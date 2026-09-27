import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contract, contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';
import { observer as globalObserver } from '../../../utils/observer';
import DigitAcceptanceService from '../../../../../services/digit-acceptance.service';

let delayIndex = 0;
let purchase_reference;

const digitAcceptanceService =
    globalThis.__TRAPKID_DIGIT_ACCEPTANCE__ ||
    (globalThis.__TRAPKID_DIGIT_ACCEPTANCE__ = new DigitAcceptanceService({
        acceptAnyDigit: true,
        waitForSpecificDigit: false,
        autoPlaceOnDigitChange: true,
        rejectThresholdConfidence: 0.5,
    }));

// Analyzer signal -> real Deriv BUY contract binding.
// This module singleton is the immutable in-process source for SELL. It prevents
// another TradeEngine instance or stale observer state from supplying an older
// contract_id for the current Analyzer signal.
// Keep the Analyzer signal -> BUY contract registry on the application global.
// TradeEngine can have more than one observer/module instance; a module-local Map
// can therefore be duplicated by the bundler and lose the BUY binding between
// Purchase and Sell. The registry contains broker contract IDs only; it does not
// change any Analyzer trading rule.
const analyzerContractBindingStore =
    globalThis.__TRAPKID_ANALYZER_CONTRACT_BINDINGS__ ||
    (globalThis.__TRAPKID_ANALYZER_CONTRACT_BINDINGS__ = new Map());

const analyzerPurchaseReservationStore =
    globalThis.__TRAPKID_ANALYZER_PURCHASE_RESERVATIONS__ ||
    (globalThis.__TRAPKID_ANALYZER_PURCHASE_RESERVATIONS__ = new Set());

export const analyzerContractBindings = analyzerContractBindingStore;
export const analyzerPurchaseReservations = analyzerPurchaseReservationStore;

// ANALYZER-ONLY EXECUTION RULES — these override Builder/local trade rules.
// Analyzer hotDigit is the canonical DIGITMATCH prediction/barrier.
// Analyzer entryDigit belongs only to the locked Analyzer entry-code metadata.
// ANALYZER MATCH MODE: keep the purchased position open while the live
// Analyzer stream searches for the exact hot digit. The same contract is
// closed as soon as that digit appears.
export default Engine =>
    class Purchase extends Engine {
        async purchase(contract_type) {
            let logicalDuration = null;
            let logicalDurationUnit = null;
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerMode =
                this.isAnalyzerEnabledForTrade?.() ||
                !!this.analyzerSignal ||
                ['ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND', 'WAITING_FOR_ANALYZER_EXIT', 'EARLY_EXIT_COMMAND_RECEIVED', 'ANALYZER_EXECUTION', 'RUNNING'].includes(
                    String(analyzerState.status || '')
                );

            if (analyzerMode) {
                const analyzerStateGate = globalObserver.getState('trapkid_analyzer') || {};
                // STRICT COMMAND GATE:
                // A LOCKED/visible Analyzer signal, RUN button, status refresh,
                // or local execution flag is never enough to authorize a BUY.
                // The only valid entry trigger is an explicit READY Analyzer command.
                const entryCommandAuthorized =
                    analyzerStateGate.executionArmed === true &&
                    analyzerStateGate.entryReady === true &&
                    ['ANALYZER_ENTRY', 'ANALYZER_ENTRY_COMMAND'].includes(
                        String(analyzerStateGate.executionTrigger || '')
                    );

                if (!entryCommandAuthorized) {
                    globalObserver.emit(
                        'ui.log',
                        'TRAPKID ANALYZER BUY BLOCKED → Analyze entry command is not armed.'
                    );
                    return Promise.resolve();
                }

                // Analyzer owns the contract type for this execution cycle.
                contract_type = 'DIGITMATCH';
                const signal = this.getExternalAnalyzerSignal?.();
                const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
                const bridgeSignal = analyzerState?.signal;
                const bridgeSignalKey = bridgeSignal?.signalId
                    ? String(bridgeSignal.signalId) + ':' + String(bridgeSignal.lockedAt)
                    : '';
                const authorizedBridgeSignal =
                    signal &&
                    bridgeSignalKey &&
                    String(analyzerState.commandKey || '') === bridgeSignalKey
                        ? signal
                        : null;

                // The shared Analyzer bridge is authoritative. The local
                // engine field is optional because the purchase phase may run
                // on a later engine callback.
                const activeSignal = this.analyzerSignal || authorizedBridgeSignal;
                const normalizedEntryDigit = Number(signal?.entryDigit ?? activeSignal?.entryDigit ?? 0);
                const normalizedHotDigit = Number(signal?.hotDigit ?? activeSignal?.hotDigit ?? 0);
                const entryDigitValid = Number.isInteger(normalizedEntryDigit) && normalizedEntryDigit >= 0 && normalizedEntryDigit <= 9;
                const hotDigitValid = Number.isInteger(normalizedHotDigit) && normalizedHotDigit >= 0 && normalizedHotDigit <= 9;

                // Accept ANY valid 0-9 digit instead of rejecting the trade.
                // Only block if the analyzer signal is missing or has no valid 0-9 digit.
                if (
                    !signal ||
                    !activeSignal ||
                    String(signal.signalId) !== String(activeSignal.signalId) ||
                    Number(signal.lockedAt) !== Number(activeSignal.lockedAt) ||
                    !Number.isFinite(Number(signal?.amount ?? this.tradeOptions?.amount)) ||
                    Number(signal?.amount ?? this.tradeOptions?.amount) <= 0 ||
                    (!entryDigitValid && !hotDigitValid)
                ) {
                    globalObserver?.emit?.(
                        'ui.log.error',
                        'Analyzer signal is missing or does not contain a valid 0-9 digit. Purchase blocked.'
                    );
                    return Promise.resolve();
                }

                this.analyzerSignal = activeSignal;
                this.analyzerCommandKey =
                    String(signal.signalId) + ':' + String(signal.lockedAt);

                const analyzerSignalKey =
                    String(signal.signalId) + ':' + String(signal.lockedAt);
                const currentAnalyzerState = globalObserver.getState('trapkid_analyzer') || {};

                if (
                    currentAnalyzerState.purchaseConsumedKey === analyzerSignalKey ||
                    currentAnalyzerState.purchaseInFlightKey === analyzerSignalKey ||
                    analyzerPurchaseReservations.has(analyzerSignalKey)
                ) {
                    return Promise.resolve();
                }

                analyzerPurchaseReservations.add(analyzerSignalKey);

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...currentAnalyzerState,
                        status: 'ANALYZER_EXECUTION',
                        signal,
                        signalId: signal.signalId,
                        commandKey: analyzerSignalKey,
                        purchaseInFlightKey: analyzerSignalKey,
                        entryPrediction: signal.hotDigit,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_READY',
                        executionTrigger: 'ANALYZER_ENTRY_COMMAND',
                    },
                });

                this.tradeOptions.prediction = signal.hotDigit;
                this.tradeOptions.symbol = signal.symbol;
                logicalDuration = signal?.duration ?? signal?.logicalDuration ?? signal?.analyzerDuration ?? 1;
                logicalDurationUnit = signal?.duration_unit ?? signal?.durationUnit ?? signal?.logicalDurationUnit ?? signal?.analyzerDurationUnit ?? 't';

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'ANALYZER_EXECUTION',
                        symbol: signal.symbol,
                        signal,
                        signalId: signal.signalId,
                        commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                        prediction: signal.hotDigit,
                        lockedDigit: signal.lockedDigit,
                        hotDigit: signal.hotDigit,
                        entryPrediction: signal.hotDigit,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_READY',
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            }
            if (!analyzerMode && this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const onSuccess = response => {
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.derivContractId = String(buy.contract_id);
                this.derivBuy = buy;
                this.derivBuyTransactionId = buy.transaction_id ?? null;

                if (this.analyzerSignal?.signalId && Number.isFinite(Number(this.analyzerSignal?.lockedAt))) {
                    const signalKey =
                        String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt);
                    const existingContractId = String(analyzerContractBindings.get(signalKey) || '');
                    if (!existingContractId) {
                        analyzerContractBindings.set(signalKey, String(buy.contract_id));
                    } else if (existingContractId !== String(buy.contract_id)) {
                        globalObserver.emit(
                            'ui.log.error',
                            'TRAPKID ANALYZER BUY BLOCKED → duplicate contract for the same signal. ' +
                                'BOUND=' + existingContractId + ' RECEIVED=' + String(buy.contract_id)
                        );
                    }
                }
                this.isSold = false;
                this.isExpired = false;
                this.isSellAvailable = true;

                this.data.contract = {
                    ...(this.data.contract || {}),
                    id: String(buy.contract_id),
                    contract_id: String(buy.contract_id),
                    deriv_contract_id: String(buy.contract_id),
                    transaction_ids: {
                        buy: buy.transaction_id ?? null,
                        sell: null,
                    },
                    contract_type: 'DIGITMATCH',
                    symbol: this.analyzerSignal?.symbol || this.tradeOptions?.symbol,
                    underlying_symbol: this.analyzerSignal?.symbol || this.tradeOptions?.symbol,
                    barrier: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    prediction: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    buy_price: Number(buy.buy_price),
                    payout: Number(buy.payout),
                    currency: buy.currency || this.tradeOptions?.currency || 'USD',
                    analyzer_source: 'ANALYZER_ONLY',
                    analyzer_signal_id: this.analyzerSignal?.signalId || null,
                    analyzer_command_key: this.analyzerCommandKey || null,
                    analyzer_entry_code: this.analyzerCommandKey || null,
                    analyzer_entry_digit: Number(this.analyzerSignal?.entryDigit ?? this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    analyzer_entry_quote: Number(this.analyzerSignal?.entryQuote ?? this.analyzerSignal?.lockedQuote ?? NaN),
                    analyzer_locked_quote: Number(this.analyzerSignal?.lockedQuote ?? this.analyzerSignal?.entryQuote ?? NaN),
                    analyzer_hot_digit: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    analyzer_prediction: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    duration: logicalDuration,
                    duration_unit: logicalDurationUnit,
                    analyzer_duration: logicalDuration,
                    analyzer_duration_unit: logicalDurationUnit,
                    analyzer_exit_status: 'WAITING_FOR_EARLY_SELL_READY',
                    analyzer_execution_status: 'WAITING_FOR_EARLY_SELL_READY',
                    analyzer_exit_code: null,
                    analyzer_contract_id: String(buy.contract_id),
                    analyzer_contract_signal_id: this.analyzerSignal?.signalId || null,
                    deriv_transaction_id: buy.transaction_id ?? null,
                    deriv_buy_price: Number(buy.buy_price),
                    deriv_potential_payout: Number(buy.payout),
                    deriv_balance_after_buy: Number(buy.balance_after),
                    financial_status: 'DERIV_BUY_CONFIRMED',
                    status: 'open',
                    is_sold: false,
                    is_expired: false,
                };
                if (!Number.isFinite(this.data.contract.analyzer_entry_quote)) {
                    this.data.contract.analyzer_entry_quote = null;
                }
                if (!Number.isFinite(this.data.contract.analyzer_locked_quote)) {
                    this.data.contract.analyzer_locked_quote = null;
                }
                contract(this.data.contract);

                if (this.analyzerSignal) {
                    this.analyzerPurchaseKey =
                        String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt);
                }

                const purchasedSignalKey = this.analyzerSignal
                    ? String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt)
                    : '';

                globalObserver.emit('deriv.contract.buy', {
                    local_contract_id: this.analyzerSignal?.signalId || null,
                    contract_id: String(buy.contract_id),
                    transaction_id: buy.transaction_id ?? null,
                    buy_transaction_id: buy.transaction_id ?? null,
                    buy_price: Number(buy.buy_price),
                    payout: Number(buy.payout),
                    currency: buy.currency || this.tradeOptions?.currency || 'USD',
                    balance_after: Number(buy.balance_after),
                });

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'RUNNING',
                        derivContractId: String(buy.contract_id),
                        derivTransactionId: buy.transaction_id ?? null,
                        derivBuyPrice: Number.isFinite(Number(buy.buy_price)) ? Number(buy.buy_price) : null,
                        analyzerEntryCode: this.analyzerCommandKey || null,
                        analyzerEntryDigit: Number(this.analyzerSignal?.entryDigit ?? this.tradeOptions?.prediction),
                        analyzerEntryQuote: Number.isFinite(Number(this.analyzerSignal?.entryQuote ?? this.analyzerSignal?.lockedQuote))
                            ? Number(this.analyzerSignal?.entryQuote ?? this.analyzerSignal?.lockedQuote)
                            : null,
                        analyzerContractId: String(buy.contract_id),
                        analyzerBuyContractId: String(buy.contract_id),
                        analyzerBuySignalId: this.analyzerSignal?.signalId || null,
                        analyzerContractSignalId: this.analyzerSignal?.signalId || null,
                        analyzerPotentialPayout: Number.isFinite(Number(buy.payout)) ? Number(buy.payout) : null,
                        payout: Number.isFinite(Number(buy.payout)) ? Number(buy.payout) : null,
                        analyzerLogicalDuration: logicalDuration,
                        analyzerLogicalDurationUnit: logicalDurationUnit,
                        payoutSource: 'DERIV_BUY',
                        derivBalanceAfterBuy: Number.isFinite(Number(buy.balance_after)) ? Number(buy.balance_after) : null,
                        signal: this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal,
                        signalId: this.analyzerSignal?.signalId,
                        commandKey: this.analyzerCommandKey,
                        entryPrediction: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                        lockedQuote: this.analyzerSignal?.lockedQuote,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_READY',
                        executionTrigger: null,
                        purchaseInFlightKey: null,
                        purchaseConsumedKey: purchasedSignalKey || undefined,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'WAITING_FOR_EARLY_SELL_READY',
                        analyzerExecutionStatus: 'WAITING_FOR_EARLY_SELL_READY',
                        executionTrigger: 'ANALYZER_ENTRY_COMMAND',
                        holdUntilAnalyzerExit: true,
                        analyzerExitStatus: 'WAITING_FOR_EARLY_SELL_READY',
                        analyzerBuyContractId: String(buy.contract_id),
                        analyzerContractId: String(buy.contract_id),
                        derivContractId: String(buy.contract_id),
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            if (analyzerMode) {
                const signal = this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal;
                const amount = Number(this.tradeOptions?.amount);
                const symbol = String(signal?.symbol || '');
                const entryDigit = Number(signal?.entryDigit ?? 0);
                const hotDigit = Number(signal?.hotDigit ?? 0);
                const predictionDigit = hotDigit;
                const currency = this.tradeOptions?.currency || 'USD';

                const normalizedPredictionDigit = Number.isInteger(predictionDigit) && predictionDigit >= 0 && predictionDigit <= 9
                    ? predictionDigit
                    : 0;
                const normalizedEntryDigit = Number.isInteger(entryDigit) && entryDigit >= 0 && entryDigit <= 9
                    ? entryDigit
                    : 0;

                if (!signal?.signalId || !symbol || !Number.isFinite(amount) || amount <= 0) {
                    throw new Error('TRAPKID ANALYZER BUY -> missing stake, Analyzer market, or Analyzer entry digit.');
                }

                if (!Number.isInteger(normalizedPredictionDigit) || normalizedPredictionDigit < 0 || normalizedPredictionDigit > 9) {
                    throw new Error('TRAPKID ANALYZER BUY -> invalid predicted digit. Only 0-9 is accepted.');
                }

                if (!Number.isInteger(normalizedEntryDigit) || normalizedEntryDigit < 0 || normalizedEntryDigit > 9) {
                    throw new Error('TRAPKID ANALYZER BUY -> invalid entry digit. Only 0-9 is accepted.');
                }

                logicalDuration = signal?.duration ?? signal?.logicalDuration ?? signal?.analyzerDuration ?? 1;
                logicalDurationUnit = signal?.duration_unit ?? signal?.durationUnit ?? signal?.logicalDurationUnit ?? signal?.analyzerDurationUnit ?? 't';

                const proposalRequest = {
                    proposal: 1,
                    amount,
                    basis: 'stake',
                    contract_type: 'DIGITMATCH',
                    currency,
                    duration: logicalDuration,
                    duration_unit: logicalDurationUnit,
                    underlying_symbol: symbol,
                    barrier: String(normalizedPredictionDigit),
                    subscribe: 1,
                };

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: amount,
                    analyzer: true,
                    contract_type: 'DIGITMATCH',
                    symbol,
                    prediction: normalizedPredictionDigit,
                    analyzer_entry_code: this.analyzerCommandKey || null,
                });
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'ANALYZER_EXECUTION',
                        analyzerExecutionStatus: 'ANALYZER_BUYING',
                        contractType: 'DIGITMATCH',
                        stake: amount,
                        entryDigit: normalizedEntryDigit,
                        prediction: normalizedPredictionDigit,
                        analyzerEntryCode: this.analyzerCommandKey || null,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                let proposalResponse;
                try {
                    proposalResponse = await doUntilDone(
                        () => api_base.api.send(proposalRequest),
                        ['InvalidContractProposal']
                    );
                } catch (error) {
                    const code = error?.error?.code || error?.code || error?.message || 'unknown';
                    globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER PROPOSAL ERROR -> ' + code);
                    throw error;
                }

                const proposal = proposalResponse?.proposal;
                const proposalId = proposal?.id;
                const askPrice = Number(proposal?.ask_price);
                const potentialPayout = Number(proposal?.payout);
                if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0) {
                    throw new Error('TRAPKID ANALYZER PROPOSAL -> Deriv returned no valid proposal.');
                }

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        derivProposalId: String(proposalId),
                        derivProposalAskPrice: askPrice,
                        analyzerPotentialPayout: Number.isFinite(potentialPayout) ? potentialPayout : null,
                        payout: Number.isFinite(potentialPayout) ? potentialPayout : null,
                        payoutSource: 'DERIV_PROPOSAL',
                        analyzerLogicalDuration: logicalDuration,
                        analyzerLogicalDurationUnit: logicalDurationUnit,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                const makeFreshAnalyzerProposal = async () => {
                    const response = await api_base.api.send({
                        proposal: 1,
                        amount,
                        basis: 'stake',
                        contract_type: 'DIGITMATCH',
                        currency,
                        duration: logicalDuration,
                        duration_unit: logicalDurationUnit,
                        underlying_symbol: symbol,
                        barrier: String(normalizedPredictionDigit),
                        subscribe: 1,
                    });
                    const fresh = response?.proposal;
                    const freshId = fresh?.id;
                    const freshAskPrice = Number(fresh?.ask_price);
                    if (!freshId || !Number.isFinite(freshAskPrice) || freshAskPrice <= 0) {
                        throw new Error('TRAPKID ANALYZER BUY -> Deriv returned no fresh valid proposal.');
                    }
                    return { id: String(freshId), askPrice: freshAskPrice, proposal: fresh };
                };

                let buyResponse;
                let activeProposalId = String(proposalId);
                let activeAskPrice = askPrice;
                let lastBuyError;

                for (let attempt = 0; attempt < 4; attempt += 1) {
                    try {
                        buyResponse = await api_base.api.send({
                            buy: activeProposalId,
                            price: activeAskPrice,
                        });
                        if (buyResponse?.buy?.contract_id) break;
                        throw new Error('TRAPKID ANALYZER BUY -> Deriv returned no contract_id.');
                    } catch (error) {
                        lastBuyError = error;
                        const code = String(error?.error?.code || error?.code || error?.message || 'unknown');
                        globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER BUY ERROR -> ' + code);

                        const retryable = [
                            'PriceMoved',
                            'InvalidContractProposal',
                            'ContractBuyValidationError',
                            'ContractBuyValidation',
                            'RateLimit',
                        ].some(name => code.includes(name));

                        if (!retryable || attempt === 3) throw error;

                        const fresh = await makeFreshAnalyzerProposal();
                        activeProposalId = fresh.id;
                        activeAskPrice = fresh.askPrice;

                        globalObserver.setState({
                            trapkid_analyzer: {
                                ...(globalObserver.getState('trapkid_analyzer') || {}),
                                derivProposalId: activeProposalId,
                                derivProposalAskPrice: activeAskPrice,
                                analyzerEntryDigit: normalizedEntryDigit,
                                analyzerPrediction: normalizedPredictionDigit,
                                analyzerPotentialPayout: Number.isFinite(Number(fresh.proposal?.payout))
                                    ? Number(fresh.proposal.payout)
                                    : null,
                                payout: Number.isFinite(Number(fresh.proposal?.payout))
                                    ? Number(fresh.proposal.payout)
                                    : null,
                                payoutSource: 'DERIV_PROPOSAL_REFRESH',
                            },
                        });
                        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
                    }
                }

                if (!buyResponse?.buy?.contract_id) {
                    throw lastBuyError || new Error('TRAPKID ANALYZER BUY -> no Deriv contract returned.');
                }

                return onSuccess(buyResponse);
            }

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);

            if (analyzerMode) {
                globalObserver.emit('ui.log', `TRAPKID ANALYZER BUY → ${JSON.stringify(trade_option)}`);
            }

            const action = () => {
                if (analyzerMode) {
                    globalObserver.emit('ui.log', 'TRAPKID ANALYZER BUY REQUEST SENT');
                }
                return api_base.api
                    .send(trade_option)
                    .then(response => {
                        if (analyzerMode) {
                            globalObserver.emit(
                                'ui.log',
                                `TRAPKID ANALYZER BUY RESPONSE → ${JSON.stringify(response)}`
                            );
                        }
                        return response;
                    })
                    .catch(error => {
                        if (analyzerMode) {
                            globalObserver.emit(
                                'ui.log.error',
                                `TRAPKID ANALYZER BUY ERROR → ${error?.error?.code || error?.code || error?.message || JSON.stringify(error)}`
                            );
                        }
                        throw error;
                    });
            };

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
