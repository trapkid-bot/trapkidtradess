import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, log } from '../utils/broadcast';
import { doUntilDone, recoverFromError } from '../utils/helpers';
import { DURING_PURCHASE } from './state/constants';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return this.contractId && !this.isSold && this.isSellAvailable && !this.isExpired;
        }

        sellAtMarket(source = 'BLOCKLY') {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerSignal = this.analyzerSignal || analyzerState.signal;
            const analyzerActive =
                !!analyzerSignal?.signalId &&
                String(analyzerState.commandKey || '') ===
                    String(analyzerSignal.signalId) + ':' + String(analyzerSignal.lockedAt) &&
                ['COMMAND_ACCEPTED', 'COMMAND_RECEIVED', 'ANALYZER_EXECUTION', 'ANALYZER_TRADE_LOCKED', 'ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND', 'RUNNING', 'EARLY_EXIT_COMMAND_RECEIVED', 'WAITING_FOR_ANALYZER_EXIT_DIGIT', 'EARLY_EXIT_EXECUTING'].includes(
                    String(analyzerState.status || '')
                );

            const analyzerEarlySell = source === 'ANALYZER_EARLY_SELL';

            if (
                analyzerActive &&
                !analyzerEarlySell &&
                String(analyzerState.executionTrigger || '') !== 'EARLY_SELL_READY'
            ) {
                // Analyzer owns the position. Builder/manual selling is blocked.
                // The Analyzer EARLY_SELL_READY handler calls this method with
                // ANALYZER_EARLY_SELL, so it must never be blocked by the
                // normal Builder/manual sell gate.
                return Promise.resolve();
            }

            globalObserver.emit('bot.sell');

            // Analyzer early-sell is allowed to close the already-purchased
            // Analyzer contract even if the legacy Builder Redux scope has
            // already moved away from DURING_PURCHASE.
            // Normal Builder/manual sells keep the original scope gate.
            if (this.store.getState().scope !== DURING_PURCHASE && !analyzerEarlySell) {
                return Promise.resolve();
            }

            if (!this.isSellAtMarketAvailable(analyzerEarlySell)) {
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
