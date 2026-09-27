import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { contractStatus, log } from '../utils/broadcast';
import { doUntilDone, recoverFromError } from '../utils/helpers';
import { DURING_PURCHASE } from './state/constants';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return this.contractId && !this.isSold && this.isSellAvailable && !this.isExpired;
        }

        async sellAnalyzerEarlyExit() {
            const state = globalObserver.getState('trapkid_analyzer') || {};
            const signal = state?.signal?.signalId ? state.signal : this.analyzerSignal;
            const exit = state?.exit;

            if (
                !signal?.signalId ||
                String(state.commandKey || '') !== String(signal.signalId) + ':' + String(signal.lockedAt) ||
                state.executionTrigger !== 'EARLY_SELL_READY' &&
                exit?.status !== 'EARLY_SELL_READY'
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

            // The BUY response is the canonical owner of the real Deriv
            // contract ID. UI/bridge state can lag or still contain the previous
            // Analyzer cycle, so never choose a contract ID from stale UI state.
            const buyResponseContractId = String(this.derivBuy?.contract_id || '');
            const engineDerivContractId = String(this.derivContractId || '');
            const engineContractId = String(this.contractId || '');
            const stateDerivContractId = String(state.derivContractId || state.deriv_contract_id || '');
            const contractId =
                buyResponseContractId ||
                engineDerivContractId ||
                engineContractId ||
                stateDerivContractId;

            if (!contractId || this.isSold) return false;

            // Keep the in-memory engine bound to the exact ID returned by this BUY.
            this.contractId = contractId;
            this.derivContractId = contractId;

            if (buyResponseContractId && engineDerivContractId && buyResponseContractId !== engineDerivContractId) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER SELL → current BUY contract ID mismatch detected; using Deriv BUY response ID ' +
                        buyResponseContractId
                );
            }
            if (stateDerivContractId && buyResponseContractId && stateDerivContractId !== buyResponseContractId) {
                globalObserver.emit(
                    'ui.log',
                    'TRAPKID ANALYZER SELL → stale bridge contract ID ignored; current BUY ID=' +
                        buyResponseContractId
                );
            }
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER SELL → Deriv contract ownership mismatch; SAME contract sell blocked.'
                );
                return false;
            }

            globalObserver.emit(
                'ui.log',
                'TRAPKID ANALYZER EARLY SELL → SAME DERIV CONTRACT → ' +
                    contractId +
                    ' → signal=' +
                    String(signal.signalId) +
                    ' → hotDigit=' +
                    String(hotDigit)
            );

            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

            const getOpenContract = async () => {
                return api_base.api.send({
                    proposal_open_contract: 1,
                    contract_id: Number(contractId),
                });
            };

            const sellContractAndGetInfo = async () => {
                // BUY responses can arrive a fraction before Deriv exposes the
                // position through the open-contract endpoint. Confirm the SAME
                // current BUY contract is visible before sending SELL.
                let openContractResponse = null;
                let lastOpenContractError = null;

                for (let attempt = 0; attempt < 8; attempt += 1) {
                    try {
                        const response = await getOpenContract();
                        const poc = response?.proposal_open_contract;

                        if (
                            poc &&
                            String(poc.contract_id || '') === contractId &&
                            !poc.is_sold &&
                            !poc.is_expired
                        ) {
                            openContractResponse = response;
                            break;
                        }

                        if (poc && String(poc.contract_id || '') === contractId) {
                            return {
                                sellResponse: null,
                                contractResponse: response,
                                notSellable: true,
                            };
                        }
                    } catch (error) {
                        lastOpenContractError = error;
                        const code = error?.error?.code || error?.code || '';
                        // The position may need a few hundred milliseconds to
                        // become visible. Retry only the transient/not-yet-visible
                        // case; other API errors are surfaced immediately.
                        if (!['ContractNotFound', 'NoOpenPosition', 'InvalidSellContractProposal'].includes(code)) {
                            throw error;
                        }
                    }

                    await wait(250);
                }

                if (!openContractResponse) {
                    throw lastOpenContractError || new Error(
                        'TRAPKID DERIV EARLY SELL → current BUY contract is not visible as an open position.'
                    );
                }

                let sellResponse = null;
                let lastSellError = null;

                for (let attempt = 0; attempt < 4; attempt += 1) {
                    try {
                        sellResponse = await api_base.api.send({
                            sell: Number(contractId),
                            price: 0,
                        });
                        break;
                    } catch (error) {
                        lastSellError = error;
                        const code = error?.error?.code || error?.code || '';
                        if (code !== 'RateLimit' || attempt === 3) throw error;
                        await wait(750 * (attempt + 1));
                    }
                }

                if (!sellResponse) {
                    throw lastSellError || new Error('TRAPKID DERIV EARLY SELL → SELL request returned no response.');
                }

                let contractResponse = openContractResponse;
                try {
                    contractResponse = await api_base.api.send({
                        proposal_open_contract: 1,
                        contract_id: Number(contractId),
                    });
                } catch {
                    // SELL response itself remains authoritative for sold_for/transaction_id.
                }

                return { sellResponse, contractResponse };
            };

            let result;
            try {
                // Analyzer SELL has its own bounded retry policy so RateLimit
                // cannot recurse indefinitely through the generic DBot recovery loop.
                result = await sellContractAndGetInfo();
            } catch (error) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV EARLY SELL → ' +
                        (error?.error?.message || error?.error?.code || error?.message || 'sell failed')
                );
                return false;
            }

            if (result?.notSellable) {
                const poc = result?.contractResponse?.proposal_open_contract;
                const reason = poc?.is_expired
                    ? 'contract expired before EARLY_SELL_READY reached the broker'
                    : poc?.is_sold
                      ? 'contract was already sold'
                      : 'contract is not currently sellable';
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV EARLY SELL → ' + reason + ' → contract=' + contractId
                );
                return false;
            }

            const sold = result?.sellResponse?.sell;
            const poc = result?.contractResponse?.proposal_open_contract;
            const soldFor = Number(sold?.sold_for ?? poc?.sell_price);
            const balanceAfter = Number(sold?.balance_after);
            const sellTransactionId =
                sold?.transaction_id ??
                poc?.transaction_ids?.sell ??
                null;

            if (
                String(sold?.contract_id ?? poc?.contract_id ?? contractId) !== contractId ||
                !Number.isFinite(soldFor) ||
                sellTransactionId == null
            ) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV EARLY SELL → Deriv did not confirm the same contract with sold_for and transaction_id.'
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
                analyzer_exit_status: 'EARLY_SELL_READY',
                analyzer_execution_status: 'ANALYZER_SETTLED',
                analyzer_exit_code: String(signal.signalId) + ':' + String(exit?.epoch || ''),
                analyzer_exit_digit: hotDigit,
                analyzer_exit_quote: Number.isFinite(Number(exit?.quote)) ? Number(exit.quote) : null,
                analyzer_contract_id: contractId,
                financial_status: 'DERIV_SELL_CONFIRMED',
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
                    status: 'ANALYZER_SETTLED',
                    signal,
                    signalId: signal.signalId,
                    commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                    executionTrigger: 'ANALYZER_SETTLED',
                    holdUntilAnalyzerExit: false,
                    settlementSource: 'ANALYZER_EARLY_SELL',
                    analyzerContractId: contractId,
                    derivContractId: contractId,
                    derivSellTransactionId: sellTransactionId,
                    derivPayout: soldFor,
                    payout: soldFor,
                    profit,
                    derivBalanceAfterSell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                    exit: {
                        ...(exit || {}),
                        status: 'EARLY_SELL_READY',
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
