import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { contract, contractStatus, log } from '../utils/broadcast';
import { doUntilDone, recoverFromError } from '../utils/helpers';
import { DURING_PURCHASE } from './state/constants';
import { sell } from './state/actions';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return this.contractId && !this.isSold && this.isSellAvailable && !this.isExpired;
        }

        // Analyzer-only local settlement.
        // The Analyzer owns the lifecycle. Deriv is used only for the financial
        // proposal/potential payout obtained during Purchase.js. No broker SELL
        // request is made, so there is no Deriv-owned settlement event here.
        async sellAnalyzerEarlyExit() {
            const state = globalObserver.getState('trapkid_analyzer') || {};
            const signal = state?.signal?.signalId ? state.signal : this.analyzerSignal;
            const exit = state?.exit;

            if (
                !signal?.signalId ||
                String(state.commandKey || '') !== String(signal.signalId) + ':' + String(signal.lockedAt) ||
                (String(state.executionTrigger || '') !== 'EARLY_SELL_READY' &&
                    String(exit?.status || '') !== 'EARLY_SELL_READY')
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
                globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER EXIT → signal/hot digit mismatch; settlement blocked.');
                return false;
            }

            const contractId = String(
                state.analyzerContractId ||
                state.analyzerBuyContractId ||
                this.analyzerContractId ||
                this.contractId ||
                this.analyzerCommandKey ||
                signal.signalId
            );
            if (!contractId || this.isSold) return false;

            const sharedExitKey = String(state.analyzerExitAttemptKey || '');
            if (sharedExitKey === contractId && state.analyzerExitInFlight === true) return false;
            globalObserver.setState({
                trapkid_analyzer: {
                    ...state,
                    analyzerExitAttemptKey: contractId,
                    analyzerExitInFlight: true,
                    status: 'EARLY_EXIT_EXECUTING',
                    analyzerExecutionStatus: 'EARLY_EXIT_EXECUTING',
                    executionTrigger: 'EARLY_SELL_READY',
                    holdUntilAnalyzerExit: false,
                    analyzerContractId: contractId,
                    derivContractId: null,
                    analyzerExitStatus: 'EARLY_SELL_READY',
                },
            });

            const stake = Number(this.data?.contract?.buy_price ?? this.tradeOptions?.amount ?? 0);
            const proposalPayout = Number(
                state.analyzerPotentialPayout ??
                state.payout ??
                this.data?.contract?.deriv_potential_payout ??
                this.data?.contract?.payout
            );
            const exitPayout = Number(
                exit?.payout ??
                exit?.sellPrice ??
                exit?.sell_price
            );
            // Deriv contributes only the financial proposal value. Analyzer
            // determines WHEN the local contract settles and WHICH digit triggers it.
            const payout = Number.isFinite(exitPayout) && exitPayout > 0
                ? exitPayout
                : proposalPayout;
            if (!Number.isFinite(payout) || payout < 0) {
                globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER SETTLEMENT → no valid financial payout quote.');
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        analyzerExitInFlight: false,
                        analyzerExitAttemptKey: null,
                        status: 'EARLY_EXIT_EXECUTING',
                        analyzerExecutionStatus: 'EARLY_EXIT_WAITING_FOR_PAYOUT',
                        executionTrigger: 'EARLY_SELL_READY',
                    },
                });
                return false;
            }

            const exitCode = String(
                exit?.exitCode ||
                signal.signalId + ':' + String(exit?.epoch || Date.now())
            );
            const currentContract = this.data?.contract || {};
            const profit = payout - stake;

            this.data.contract = {
                ...currentContract,
                id: contractId,
                contract_id: contractId,
                deriv_contract_id: null,
                transaction_ids: {
                    ...(currentContract.transaction_ids || {}),
                    buy: currentContract.transaction_ids?.buy || currentContract.analyzer_entry_code || signal.signalId,
                    sell: exitCode,
                },
                sell_price: payout,
                payout,
                bid_price: payout,
                profit,
                analyzer_exit_status: 'EARLY_SELL_READY',
                analyzer_execution_status: 'ANALYZER_EARLY_SELL_CONFIRMED',
                analyzer_exit_code: exitCode,
                analyzer_exit_digit: hotDigit,
                analyzer_exit_quote: Number.isFinite(Number(exit?.quote)) ? Number(exit.quote) : null,
                analyzer_contract_id: contractId,
                deriv_contract_id: null,
                deriv_potential_payout: payout,
                deriv_sell_transaction_id: null,
                deriv_sell_price: null,
                deriv_balance_after_sell: null,
                financial_status: 'ANALYZER_SIMULATED_SETTLEMENT',
                payout_source: 'DERIV_PROPOSAL',
                status: 'sold',
                is_sold: true,
                is_expired: false,
                is_settleable: false,
                is_valid_to_sell: false,
            };

            this.isSold = true;
            this.isExpired = false;
            this.isSellAvailable = false;
            this.contractId = '';
            this.derivContractId = '';
            this.derivBuy = null;
            this.updateTotals(this.data.contract);

            contractStatus({
                id: 'contract.sold',
                data: contractId,
                contract: this.data.contract,
            });
            contract(this.data.contract);

            globalObserver.setState({
                trapkid_analyzer: {
                    ...state,
                    status: 'ANALYZER_EARLY_SELL_CONFIRMED',
                    analyzerExecutionStatus: 'ANALYZER_EARLY_SELL_CONFIRMED',
                    signal,
                    signalId: signal.signalId,
                    commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                    executionTrigger: 'ANALYZER_EARLY_SELL_CONFIRMED',
                    holdUntilAnalyzerExit: false,
                    settlementSource: 'ANALYZER',
                    analyzerContractId: contractId,
                    analyzerBuyContractId: contractId,
                    derivContractId: null,
                    derivSellTransactionId: null,
                    derivSellPrice: null,
                    payout,
                    analyzerPotentialPayout: payout,
                    payoutSource: 'DERIV_PROPOSAL',
                    financialStatus: 'ANALYZER_SIMULATED_SETTLEMENT',
                    financial_status: 'ANALYZER_SIMULATED_SETTLEMENT',
                    profit,
                    analyzerExitStatus: 'EARLY_SELL_READY',
                    analyzerExitDigit: hotDigit,
                    analyzerExitAttemptKey: null,
                    analyzerExitInFlight: false,
                    exit: {
                        ...(exit || {}),
                        status: 'EARLY_SELL_READY',
                        signalId: String(signal.signalId),
                        digit: hotDigit,
                    },
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            globalObserver.emit(
                'ui.log',
                'TRAPKID ANALYZER LOCAL SETTLEMENT → ' + contractId +
                ' → hotDigit=' + hotDigit +
                ' → payout=' + payout
            );

            // Analyzer settlement is a local lifecycle transition.
            // Do not dispatch the legacy Redux SELL action: Analyzer mode does not
            // use the Builder DURING_PURCHASE scope.
            if (this.resolveAnalyzerCycle) {
                const resolve = this.resolveAnalyzerCycle;
                this.resolveAnalyzerCycle = null;
                queueMicrotask(() => resolve(true));
            }

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
