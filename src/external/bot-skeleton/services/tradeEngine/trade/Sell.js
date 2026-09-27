import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { contractStatus, log } from '../utils/broadcast';
import { doUntilDone, recoverFromError } from '../utils/helpers';
import { DURING_PURCHASE } from './state/constants';
import { sell } from './state/actions';
import { analyzerContractBindings } from './Purchase';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return this.contractId && !this.isSold && this.isSellAvailable && !this.isExpired;
        }

        // Analyzer-only settlement: bind SELL to the current BUY contract and never reuse a prior cycle ID.
        async sellAnalyzerEarlyExit() {
            const state = globalObserver.getState('trapkid_analyzer') || {};
            const signal = state?.signal?.signalId ? state.signal : this.analyzerSignal;
            const exit = state?.exit;

            if (
                !signal?.signalId ||
                String(state.commandKey || '') !== String(signal.signalId) + ':' + String(signal.lockedAt) ||
                String(state.executionTrigger || '') !== 'MATCH_FOUND' &&
                String(exit?.status || '') !== 'MATCH_FOUND'
            ) {
                return false;
            }

            const exitSignalId = String(exit?.signalId || '');
            const exitDigit = Number(exit?.digit);
            const hotDigit = Number(signal.hotDigit);
            if (
                (exitSignalId && exitSignalId !== String(signal.signalId)) ||
                !Number.isInteger(exitDigit) ||
                exitDigit !== hotDigit ||
                hotDigit < 0 ||
                hotDigit > 9
            ) {
                globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER SELL → signal/exit digit mismatch; sell blocked.');
                return false;
            }

            // HARD ANALYZER CONTRACT OWNERSHIP:
            // The only valid SELL handle is the contract_id returned by the
            // successful BUY for THIS Analyzer signal. Do not fall back to
            // generic engine contractId/derivContractId or generic bridge state.
            // Those fields can belong to a previous TradeEngine instance/cycle.
            const analyzerSellKey = String(signal.signalId) + ':' + String(signal.lockedAt);

            // HARD ANALYZER CONTRACT IDENTITY:
            // Purchase.js records the actual Deriv BUY contract_id in the module
            // binding for this exact signal. That broker ID is the ONLY SELL target.
            // Never let a stale TradeEngine instance, generic derivContractId,
            // analyzerContractId, or old derivBuy response override it.
            const immutableBuyContractId = String(analyzerContractBindings.get(analyzerSellKey) || '');

            const stateBuySignalId = String(state.analyzerBuySignalId || '');
            const stateBuyContractId =
                stateBuySignalId === String(signal.signalId)
                    ? String(state.analyzerBuyContractId || '')
                    : '';

            if (!immutableBuyContractId) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER SELL BLOCKED → no immutable BUY contract binding for signal=' +
                        String(signal.signalId)
                );
                return false;
            }

            // If shared state has a BUY binding, it must agree with the immutable
            // broker binding. A mismatch is a stale-state bug, not permission to
            // choose whichever ID happens to be available.
            if (stateBuyContractId && stateBuyContractId !== immutableBuyContractId) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER SELL BLOCKED → stale BUY state binding rejected; immutable=' +
                        immutableBuyContractId +
                        ' state=' +
                        stateBuyContractId
                );
                return false;
            }

            const contractId = immutableBuyContractId;

            if (!contractId || this.isSold) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER SELL BLOCKED → no exact BUY contract is bound to signal=' +
                        String(signal.signalId)
                );
                return false;
            }

            // Shared one-SELL lock: this is global Analyzer state, not an
            // instance-local flag. Multiple TradeEngine observers must never
            // send duplicate SELL requests for the same signal.
            // Lock only while this exact SELL request is in flight. A failed
            // request must not permanently poison the signal: the Analyzer watcher
            // must remain able to retry the SAME contract while it is still open.
            const sharedSellKey = String(state.analyzerSellAttemptKey || '');
            const sharedSellInFlight = state.analyzerSellInFlight === true;
            if (sharedSellKey === analyzerSellKey && sharedSellInFlight) {
                return false;
            }
            globalObserver.setState({
                trapkid_analyzer: {
                    ...state,
                    analyzerSellAttemptKey: analyzerSellKey,
                    analyzerSellContractId: contractId,
                    analyzerSellInFlight: true,
                },
            });
            this.analyzerSellAttemptKey = analyzerSellKey;

            // From this point onward the exact BUY contract_id is immutable.
            this.contractId = contractId;
            this.derivContractId = contractId;

            // The immutable signal binding above is the sole BUY identity.
            // Do not reference the old per-engine buyResponseContractId here.
            globalObserver.emit(
                'ui.log',
                'TRAPKID MATCH → SAME DERIV CONTRACT → ' +
                    contractId +
                    ' → signal=' +
                    String(signal.signalId) +
                    ' → hotDigit=' +
                    String(hotDigit)
            );

            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

            const sellContractAndGetInfo = async () => {
                // CRITICAL 1-TICK TIMING RULE:
                // EARLY_SELL_READY is already an explicit Analyzer exit command.
                // Do NOT poll proposal_open_contract first. That old 8 x 250ms
                // visibility loop could consume the entire 1-tick lifetime and
                // make a valid early SELL arrive after expiry.
                // Send SELL immediately against the canonical BUY contract ID.
                let sellResponse = null;
                let lastSellError = null;

                for (let attempt = 0; attempt < 3; attempt += 1) {
                    try {
                        globalObserver.emit(
                            'ui.log',
                            'TRAPKID DERIV EARLY SELL → SELL IMMEDIATE → contract=' + contractId
                        );
                        sellResponse = await api_base.api.send({
                            sell: Number(contractId),
                            price: 0,
                        });
                        break;
                    } catch (error) {
                        lastSellError = error;
                        const code = error?.error?.code || error?.code || '';
                        // A RateLimit is transient; retry quickly because a
                        // 1-tick Analyzer contract has almost no remaining life.
                        if (code !== 'RateLimit' || attempt === 2) throw error;
                        await wait(100 * (attempt + 1));
                    }
                }

                if (!sellResponse) {
                    throw lastSellError || new Error('TRAPKID MATCH → SELL request returned no response.');
                }

                // Verification happens AFTER the SELL request so verification
                // latency can never delay the actual exit command.
                let contractResponse = null;
                try {
                    contractResponse = await api_base.api.send({
                        proposal_open_contract: 1,
                        contract_id: Number(contractId),
                    });
                } catch {
                    // SELL response is authoritative for sold_for/transaction_id.
                }

                const sell = sellResponse?.sell;
                const responseContractId = String(sell?.contract_id ?? '');
                if (responseContractId && responseContractId !== contractId) {
                    throw new Error(
                        'TRAPKID DERIV EARLY SELL → Deriv returned a different contract ID. expected=' +
                        contractId + ' received=' + responseContractId
                    );
                }

                return { sellResponse, contractResponse };
            };

            let result;
            try {
                // Analyzer Match settlement is allowed to confirm the same
                // contract even when a 1-tick DIGITMATCH has already reached
                // its broker expiry. In that case SELL is no longer a valid
                // operation; the broker's final contract record is the
                // settlement record for the exact BUY contract.
                result = await sellContractAndGetInfo();
            } catch (error) {
                let contractResponse = null;
                try {
                    contractResponse = await api_base.api.send({
                        proposal_open_contract: 1,
                        contract_id: Number(contractId),
                    });
                } catch {
                    // Preserve the original broker error if the contract record
                    // cannot be read.
                }

                const poc = contractResponse?.proposal_open_contract;
                const finalContractId = String(poc?.contract_id ?? '');
                const finalTickRaw = poc?.exit_tick_display ?? poc?.exit_tick;
                const finalTickDigits = String(finalTickRaw ?? '').replace(/[^0-9]/g, '');
                const finalDigit = finalTickDigits ? Number(finalTickDigits.slice(-1)) : NaN;
                const brokerClosed =
                    finalContractId === contractId &&
                    (poc?.is_sold === 1 || poc?.is_sold === true ||
                     poc?.is_expired === 1 || poc?.is_expired === true);

                // A one-tick contract may already be broker-settled by the time
                // the Analyzer MATCH_FOUND reaches the SELL bridge. If its exact
                // final tick is the Analyzer hot digit, confirm that SAME contract
                // as MATCH_SETTLED instead of reporting a false SELL failure.
                if (brokerClosed && Number.isInteger(finalDigit) && finalDigit === hotDigit) {
                    globalObserver.emit(
                        'ui.log',
                        'TRAPKID MATCH → SAME CONTRACT ALREADY SETTLED → contract=' +
                            contractId + ' → hotDigit=' + hotDigit
                    );
                    result = {
                        brokerSettled: true,
                        contractResponse,
                    };
                } else {
                    const errorCode = error?.error?.code || error?.code || '';
                    const errorMessage = error?.error?.message || error?.message || 'sell failed';
                    const failedState = globalObserver.getState('trapkid_analyzer') || {};
                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...failedState,
                            status: 'MATCH_SETTLEMENT_PENDING',
                            analyzerExecutionStatus: 'MATCH_SETTLEMENT_PENDING',
                            executionTrigger: 'MATCH_FOUND',
                            holdUntilAnalyzerExit: true,
                            analyzerExitStatus: 'MATCH_FOUND',
                            earlySellErrorCode: errorCode || null,
                            earlySellError: errorMessage,
                            analyzerContractId: contractId,
                            derivContractId: contractId,
                            analyzerSellInFlight: false,
                            analyzerSellAttemptKey: null,
                        },
                    });
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID MATCH → settlement pending for SAME CONTRACT=' + contractId +
                        ' → ' + errorMessage
                    );
                    globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
                    return false;
                }
            }

            if (result?.notSellable) {
                const poc = result?.contractResponse?.proposal_open_contract;
                const finalTickRaw = poc?.exit_tick_display ?? poc?.exit_tick;
                const finalTickDigits = String(finalTickRaw ?? '').replace(/[^0-9]/g, '');
                const finalDigit = finalTickDigits ? Number(finalTickDigits.slice(-1)) : NaN;
                const brokerClosed =
                    String(poc?.contract_id ?? '') === contractId &&
                    (poc?.is_sold === 1 || poc?.is_sold === true ||
                     poc?.is_expired === 1 || poc?.is_expired === true);
                if (brokerClosed && Number.isInteger(finalDigit) && finalDigit === hotDigit) {
                    result = { brokerSettled: true, contractResponse: result.contractResponse };
                } else {
                    return false;
                }
            }

            const sold = result?.sellResponse?.sell;
            const poc = result?.contractResponse?.proposal_open_contract;
            const brokerSettled = result?.brokerSettled === true;
            const soldFor = Number(sold?.sold_for ?? poc?.sell_price ?? poc?.payout ?? poc?.bid_price);
            const balanceAfter = Number(sold?.balance_after);
            const sellTransactionId =
                sold?.transaction_id ??
                poc?.transaction_ids?.sell ??
                null;
            if (
                String(sold?.contract_id ?? poc?.contract_id ?? contractId) !== contractId ||
                !Number.isFinite(soldFor) ||
                (!brokerSettled && sellTransactionId == null)
            ) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID MATCH → settlement did not confirm the SAME CONTRACT=' + contractId
                );
                return false;
            }

            const buyPrice = Number(this.data?.contract?.buy_price ?? this.tradeOptions?.amount);
            const profit = Number.isFinite(buyPrice) ? soldFor - buyPrice : 0;
            const currentContract = this.data?.contract || {};

            this.data.contract = {
                ...currentContract,
                contract_id: contractId,
                deriv_contract_id: contractId,
                transaction_ids: {
                    ...(currentContract.transaction_ids || {}),
                    buy: currentContract.transaction_ids?.buy ?? this.derivBuyTransactionId ?? null,
                    sell: sellTransactionId,
                },
                sell_price: soldFor,
                payout: soldFor,
                bid_price: soldFor,
                profit,
                deriv_sell_price: soldFor,
                deriv_sell_transaction_id: sellTransactionId,
                deriv_balance_after_sell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                analyzer_exit_status: 'MATCH_FOUND',
                analyzer_execution_status: 'MATCH_SETTLED',
                analyzer_exit_code: String(signal.signalId) + ':' + String(exit?.epoch || ''),
                analyzer_exit_digit: hotDigit,
                analyzer_exit_quote: Number.isFinite(Number(exit?.quote)) ? Number(exit.quote) : null,
                analyzer_contract_id: contractId,
                financial_status: brokerSettled ? 'DERIV_CONTRACT_SETTLED' : 'DERIV_SELL_CONFIRMED',
                status: 'sold',
                is_sold: true,
                is_expired: false,
                is_settleable: false,
                is_valid_to_sell: false,
            };

            this.isSold = true;
            this.isExpired = false;
            this.isSellAvailable = false;
            this.updateTotals(this.data.contract);

            globalObserver.emit('deriv.contract.sell', {
                local_contract_id: String(signal.signalId),
                contract_id: contractId,
                transaction_id: sellTransactionId,
                sell_transaction_id: sellTransactionId,
                analyzer_entry_code: currentContract.analyzer_entry_code || currentContract.analyzer_command_key || null,
                analyzer_exit_code: String(signal.signalId) + ':' + String(exit?.epoch || ''),
                sold_for: soldFor,
                balance_after: Number.isFinite(balanceAfter) ? balanceAfter : null,
                currency: sold?.currency || this.tradeOptions?.currency || 'USD',
            });

            contractStatus({
                id: 'contract.sold',
                data: contractId,
                contract: this.data.contract,
            });

            globalObserver.setState({
                trapkid_analyzer: {
                    ...state,
                    status: 'MATCH_SETTLED',
                    signal,
                    signalId: signal.signalId,
                    commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                    executionTrigger: 'MATCH_SETTLED',
                    holdUntilAnalyzerExit: false,
                    settlementSource: 'MATCH_FOUND',
                    analyzerContractId: contractId,
                    derivContractId: contractId,
                    derivSellTransactionId: sellTransactionId,
                    derivSellPrice: soldFor,
                    derivPayout: soldFor,
                    payout: soldFor,
                    financialStatus: brokerSettled ? 'DERIV_CONTRACT_SETTLED' : 'DERIV_SELL_CONFIRMED',
                    financial_status: 'DERIV_SELL_CONFIRMED',
                    profit,
                    derivBalanceAfterSell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                    exit: {
                        ...(exit || {}),
                        status: 'MATCH_FOUND',
                        signalId: String(signal.signalId),
                        digit: hotDigit,
                    },
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            if (this.afterPromise) {
                this.afterPromise();
                this.afterPromise = null;
            }

            this.store.dispatch(sell());
            return true;
        }

        sellAtMarket(source = 'BLOCKLY') {
            if (source === 'ANALYZER_EARLY_SELL') {
                return this.sellAnalyzerEarlyExit();
            }
            globalObserver.emit('bot.sell');

            // Prevent calling sell twice
            if (this.store.getState().scope !== DURING_PURCHASE) {
                return Promise.resolve();
            }

            if (!this.isSellAtMarketAvailable()) {
                log(LogTypes.NOT_OFFERED);
                return Promise.resolve();
            }

            let delay_index = 1;

            return new Promise(resolve => {
                const onContractSold = sell_response => {
                    delay_index = 1;

                    if (sell_response) {
                        const { sold_for } = sell_response.sell;
                        log(LogTypes.SELL, { sold_for });
                    }

                    contractStatus('purchase.sold');
                    this.waitForAfter();
                    resolve();
                };

                const contract_id = this.contractId;

                const sellContractAndGetContractInfo = () => {
                    return doUntilDone(() => api_base.api.send({ sell: contract_id, price: 0 }))
                        .then(sell_response => {
                            doUntilDone(() => api_base.api.send({ proposal_open_contract: 1, contract_id })).then(
                                () => sell_response
                            );
                        })
                        .catch(e => {
                            const error = e.error;
                            if (error.code === 'InvalidOfferings') {
                                // "InvalidOfferings" may occur when user tries to sell the contract too close
                                // to the expiry time. We shouldn't interrupt the bot but instead let the contract
                                // finish.
                                return Promise.resolve();
                            }

                            const sell_error = {
                                name: error.code,
                                message: getLocalizedErrorMessage(error.code, error.details),
                                msg_type: e.msg_type,
                                error: { ...error.error },
                            };

                            if (error.code === 'RateLimit') {
                                return Promise.reject(sell_error);
                            }

                            // For every other error, check whether the contract is not actually already sold.
                            return doUntilDone(() =>
                                api_base.api.send({
                                    proposal_open_contract: 1,
                                    contract_id,
                                })
                            ).then(proposal_open_contract_response => {
                                const { proposal_open_contract } = proposal_open_contract_response;

                                if (!proposal_open_contract.is_sold) {
                                    return Promise.reject(sell_error);
                                }

                                // If the contract is sold at this point it means there was a race condition.
                                // Pretend this sell request was successful and mislead the trade engine into
                                // moving onto the next scope.
                                return Promise.resolve({
                                    sell: {
                                        sold_for: proposal_open_contract.sell_price,
                                    },
                                });
                            });
                        });
                };

                const errors_to_ignore = ['NoOpenPosition', 'InvalidSellContractProposal', 'UnrecognisedRequest'];

                // Restart buy/sell on error is enabled, don't recover from sell error.
                if (!this.options.timeMachineEnabled) {
                    // eslint-disable-next-line no-promise-executor-return
                    return doUntilDone(sellContractAndGetContractInfo, errors_to_ignore)
                        .then(sell_response => onContractSold(sell_response))
                        .catch(error => error);
                }

                // If above checkbox not checked, try to recover from sell error.
                const recoverFn = (error_code, makeDelay) => {
                    return makeDelay().then(() => this.observer.emit('REVERT', 'during'));
                };
                // eslint-disable-next-line no-promise-executor-return
                return recoverFromError(
                    sellContractAndGetContractInfo,
                    recoverFn,
                    errors_to_ignore,
                    delay_index++
                ).then(sell_response => onContractSold(sell_response));
            });
        }
    };
