import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { api_base } from '../../api/api-base';
import { doUntilDone, tradeOptionToProposal } from '../utils/helpers';
import { clearProposals, proposalsReady } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Proposal extends Engine {
        makeProposals(trade_option) {
            let analyzerTradeOption = trade_option;
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const signal = analyzerState?.signal;
            const analyzerActive =
                signal?.signalId &&
                analyzerState?.commandKey ===
                    String(signal.signalId) + ':' + String(signal.lockedAt) &&
                ['COMMAND_RECEIVED', 'COMMAND_ACCEPTED', 'ANALYZER_EXECUTION', 'WAITING_FOR_ANALYZER_EXIT', 'EARLY_EXIT_COMMAND_RECEIVED', 'RUNNING', 'ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND'].includes(
                    String(analyzerState.status || '')
                );

            if (analyzerActive) {
                // Rebuild the actual proposal inputs from the Analyzer signal
                // at the final proposal boundary. Bot Builder entry values are
                // not authoritative for an Analyzer-controlled trade.
                analyzerTradeOption = {
                    ...trade_option,
                    contractTypes: ['DIGITMATCH'],
                    symbol: signal.symbol,
                    prediction: signal.prediction,
                };
            }

            if (!this.isNewTradeOption(analyzerTradeOption)) {
                return;
            }

            this.regeneratePurchaseReference();
            this.trade_option = analyzerTradeOption;
            this.proposal_templates = tradeOptionToProposal(
                analyzerTradeOption,
                this.getPurchaseReference()
            );
            this.renewProposalsOnPurchase();
        }

        selectProposal(contract_type) {
            const { proposals } = this.data;

            if (proposals.length === 0) {
                throw Error(getLocalizedErrorMessage('ProposalsNotReady'));
            }

            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const signal = analyzerState?.signal;
            const analyzerActive =
                signal?.signalId &&
                analyzerState?.commandKey ===
                    String(signal.signalId) + ':' + String(signal.lockedAt) &&
                ['COMMAND_RECEIVED', 'COMMAND_ACCEPTED', 'ANALYZER_EXECUTION', 'RUNNING', 'ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND'].includes(
                    String(analyzerState.status || '')
                ) &&
                contract_type === 'DIGITMATCH';

            const to_buy = proposals.find(proposal => {
                if (
                    proposal.contract_type === contract_type &&
                    proposal.purchase_reference === this.getPurchaseReference()
                ) {
                    if (analyzerActive) {
                        const proposalPrediction = Number(
                            proposal.selected_tick ?? proposal.barrier
                        );
                        const analyzerPrediction = Number(signal.prediction);
                        const proposalSymbol = String(
                            proposal.underlying_symbol || proposal.underlying_symbol_name || ''
                        );

                        if (
                            proposalSymbol !== String(signal.symbol) ||
                            !Number.isInteger(analyzerPrediction) ||
                            proposalPrediction !== analyzerPrediction ||
                            Number(proposal.barrier) !== analyzerPrediction
                        ) {
                            throw new Error(
                                'Analyzer authorization mismatch: purchase blocked because the proposal does not match the Analyzer signal.'
                            );
                        }
                    }
                    // Below happens when a user has had one of the proposals return
                    // with a ContractBuyValidationError. We allow the logic to continue
                    // to here cause the opposite proposal may still be valid. Only once
                    // they attempt to purchase the errored proposal we will intervene.
                    if (proposal.error) {
                        // Ensure we throw the localized error message
                        throw proposal.error;
                    }

                    return proposal;
                }

                return false;
            });

            if (!to_buy) {
                throw new Error(getLocalizedErrorMessage('SelectedProposalNotExist'));
            }

            return {
                id: to_buy.id,
                askPrice: to_buy.ask_price,
            };
        }

        renewProposalsOnPurchase() {
            this.data.proposals = [];
            this.store.dispatch(clearProposals());
            this.requestProposals();
        }

        requestProposals() {
            // Since there are two proposals (in most cases), an error may be logged twice, to avoid this
            // flip this boolean on error.
            let has_informed_error = false;

            Promise.all(
                this.proposal_templates.map(proposal => {
                    doUntilDone(() => api_base.api.send(proposal)).catch(error => {
                        // We intercept ContractBuyValidationError as user may have specified
                        // e.g. a DIGITUNDER 0 or DIGITOVER 9, while one proposal may be invalid
                        // the other is valid. We will error on Purchase rather than here.

                        if (error?.error?.code === 'ContractBuyValidationError') {
                            // Create localized error message for validation errors
                            const localizedError = new Error(getLocalizedErrorMessage(error.error.code, error.error));
                            localizedError.code = error.error.code;
                            localizedError.details = error.error.details;
                            localizedError.message_to_client = error.error.message_to_client;

                            this.data.proposals.push({
                                ...error.error.echo_req,
                                ...error.echo_req.passthrough,
                                error: localizedError,
                            });

                            return null;
                        }
                        if (!has_informed_error) {
                            has_informed_error = true;
                            // Use localized error message for general errors
                            const localizedErrorMessage = error.error.code
                                ? getLocalizedErrorMessage(error.error.code, error.error)
                                : error.error.message || getLocalizedErrorMessage('GeneralError');

                            const localizedError = {
                                ...error.error,
                                message: localizedErrorMessage,
                            };
                            this.$scope.observer.emit('Error', localizedError);
                        }
                        return null;
                    });
                })
            );
        }

        observeProposals() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(response => {
                if (response.data.msg_type === 'proposal') {
                    const { passthrough, proposal, error } = response.data;

                    // Handle proposal errors with localized messages
                    if (error) {
                        const localizedError = new Error(getLocalizedErrorMessage(error.code, error));
                        localizedError.code = error.code;
                        localizedError.details = error.details;
                        localizedError.message_to_client = error.message_to_client;

                        this.data.proposals.push({
                            ...passthrough,
                            error: localizedError,
                        });
                        return;
                    }

                    if (proposal && this.data.proposals.findIndex(p => p.id === proposal.id) === -1) {
                        // Add proposals based on the ID returned by the API.
                        this.data.proposals.push({ ...proposal, ...passthrough });
                        this.checkProposalReady();
                    }
                }
            });
            api_base.pushSubscription(subscription);
        }

        checkProposalReady() {
            // Proposals are considered ready when the proposals in our memory match the ones
            // we've requested from the API, we determine this by checking the passthrough of the response.
            const { proposals } = this.data;

            if (proposals.length > 0 && this.proposal_templates) {
                const has_equal_proposals = this.proposal_templates.every(template => {
                    return (
                        proposals.findIndex(proposal => {
                            return (
                                proposal.purchase_reference === template.passthrough.purchase_reference &&
                                proposal.contract_type === template.contract_type
                            );
                        }) !== -1
                    );
                });

                if (has_equal_proposals) {
                    this.startPromise.then(() => this.store.dispatch(proposalsReady()));
                }
            }
        }

        isNewTradeOption(trade_option) {
            if (!this.trade_option) {
                this.trade_option = trade_option;
                return true;
            }

            // Compare incoming "trade_option" argument with "this.trade_option", if any
            // of the values is different, this is a new tradeOption and new proposals
            // should be generated.
            return [
                'amount',
                'barrierOffset',
                'basis',
                'duration',
                'duration_unit',
                'prediction',
                'secondBarrierOffset',
                'underlying_symbol',
            ].some(value => this.trade_option[value] !== trade_option[value]);
        }
    };
