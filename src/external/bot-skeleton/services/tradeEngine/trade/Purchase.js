import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contract, contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';
import { observer as globalObserver } from '../../../utils/observer';

let delayIndex = 0;
let purchase_reference;

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

                if (
                    !signal ||
                    !activeSignal ||
                    String(signal.signalId) !== String(activeSignal.signalId) ||
                    Number(signal.lockedAt) !== Number(activeSignal.lockedAt) ||
                    !Number.isInteger(signal.entryDigit) ||
                    signal.entryDigit < 0 ||
                    signal.entryDigit > 9 ||
                    !Number.isInteger(signal.hotDigit) ||
                    signal.hotDigit < 0 ||
                    signal.hotDigit > 9
                ) {
                    globalObserver?.emit?.(
                        'ui.log.error',
                        'Analyzer signal is missing or not authorized. Purchase blocked.'
                    );
                    return Promise.resolve();
                }

                this.analyzerSignal = activeSignal;
                this.analyzerCommandKey =
                    String(signal.signalId) + ':' + String(signal.lockedAt);

                const analyzerSignalKey =
                    String(signal.signalId) + ':' + String(signal.lockedAt);
                const currentAnalyzerState = globalObserver.getState('trapkid_analyzer') || {};

                // One Analyzer signal can create exactly ONE real Deriv BUY.
                // The observer state above is not an atomic lock: two TradeEngine
                // instances can read it before either instance writes it. Use the
                // shared application registry as the synchronous reservation so
                // the second instance is blocked BEFORE it can call Deriv BUY.
                if (
                    currentAnalyzerState.purchaseConsumedKey === analyzerSignalKey ||
                    currentAnalyzerState.purchaseInFlightKey === analyzerSignalKey ||
                    analyzerPurchaseReservations.has(analyzerSignalKey)
                ) {
                    return Promise.resolve();
                }

                analyzerPurchaseReservations.add(analyzerSignalKey);

                // Mirror the reservation into Analyzer state for UI/lifecycle
                // visibility, but the shared registry above is the actual
                // concurrency guard.
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

                // Analyzer is the sole source of the actual Match entry values.
                // Any Bot Builder prediction value is overwritten here.
                // Analyzer entryDigit is the sole canonical DIGITMATCH barrier.
                // hotDigit is retained separately for the Analyzer-controlled exit.
                // Analyzer hotDigit is the canonical DIGITMATCH prediction/barrier.
                // entryDigit remains Analyzer entry-code metadata only.
                this.tradeOptions.prediction = signal.hotDigit;
                this.tradeOptions.symbol = signal.symbol;
                const explicitDuration = signal?.duration ?? signal?.logicalDuration ?? signal?.analyzerDuration;
                const explicitDurationUnit =
                    signal?.duration_unit ??
                    signal?.durationUnit ??
                    signal?.logicalDurationUnit ??
                    signal?.analyzerDurationUnit;

                if (Number.isFinite(Number(explicitDuration)) && Number(explicitDuration) > 0) {
                    logicalDuration = Number(explicitDuration);
                    logicalDurationUnit = explicitDurationUnit || 't';
                } else {
                    // Financial quote only: when Analyzer does not provide a duration,
                    // derive the proposal window from the same Analyzer lock instead
                    // of hardcoding the next tick as the trade lifecycle.
                    const lockWindowMs = Number(signal?.expiresAt) - Number(signal?.lockedAt);
                    if (Number.isFinite(lockWindowMs) && lockWindowMs >= 1000) {
                        logicalDuration = Math.max(1, Math.round(lockWindowMs / 1000));
                        logicalDurationUnit = 's';
                    } else {
                        logicalDuration = 1;
                        logicalDurationUnit = 't';
                    }
                }
                // Preserve the established Analyzer DIGITMATCH execution value when
                // the bridge does not include duration metadata: 1 tick.

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
            // Analyzer direct BUY does not depend on the Builder Redux purchase
            // scope. Never dispatch SELL/START here: those legacy state transitions
            // can interfere with the Analyzer-owned execution lifecycle.
            if (!analyzerMode && this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }


            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
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

                // Bind the broker's actual BUY contract to this exact Analyzer signal
                // before publishing any lifecycle/UI state. This binding is immutable:
                // a later TradeEngine instance must NEVER replace it with another
                // contract for the same signal.
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

                // Keep the normal DBot contract model as the single source for
                // the purchased position. Analyzer only supplied the values used
                // to construct this contract.
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
                    // DIGITMATCH barrier/prediction are ALWAYS the Analyzer hot digit.
                    // entryDigit belongs only to the Analyzer entry-code metadata.
                    barrier: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    // DIGITMATCH prediction is the Analyzer hot digit.
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
                        // Immutable-in-cycle BUY binding. SELL must use this exact
                        // contract for the matching Analyzer signal, even if a
                        // stale bridge/UI field later overwrites derivContractId.
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
                // Analyzer owns the exit lifecycle. After BUY, hold this exact
                // contract until Analyzer publishes EARLY_SELL_READY.
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

                // If Analyzer emitted EARLY_SELL_READY while the proposal/BUY
                // request was in flight, the exit is stored as pending. As soon
                // as the exact BUY contract is bound, execute that pending exit
                // immediately instead of waiting for another bridge/tick event.
                const postPurchaseState = globalObserver.getState('trapkid_analyzer') || {};
                const liveExit = postPurchaseState.exit;
                const pendingExit = postPurchaseState.pendingEarlyExit;
                const readyExit = pendingExit?.status === 'EARLY_SELL_READY' ? pendingExit : liveExit;
                if (readyExit?.status === 'EARLY_SELL_READY' && !this.isSold) {
                    queueMicrotask(() => {
                        void this.onAnalyzerEarlyExit?.({
                            source: 'TRAPKID_ANALYZER_POST_PURCHASE',
                            command: 'ANALYZER_EARLY_EXIT',
                            commandKey: postPurchaseState.commandKey || this.analyzerCommandKey,
                            signalId: postPurchaseState.signalId || this.analyzerSignal?.signalId,
                            signal: postPurchaseState.signal || this.analyzerSignal,
                            exit: readyExit,
                            receivedAt: Date.now(),
                        });
                    });
                }

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

            // Analyzer-only financial quote + local contract mode.
            // Deriv is queried for proposal/potential payout only. No BUY request is
            // sent, so no broker-owned contract can expire or settle independently.
            if (analyzerMode) {
                const signal = this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal;
                const amount = Number(this.tradeOptions?.amount);
                const symbol = String(signal?.symbol || '');
                const entryDigit = Number(signal?.entryDigit);
                const hotDigit = Number(signal?.hotDigit);
                const predictionDigit = hotDigit;
                const currency = this.tradeOptions?.currency || 'USD';

                if (!signal?.signalId || !symbol || !Number.isFinite(amount) || amount <= 0 ||
                    !Number.isInteger(entryDigit) || entryDigit < 0 || entryDigit > 9 ||
                    !Number.isInteger(predictionDigit) || predictionDigit < 0 || predictionDigit > 9) {
                    throw new Error('TRAPKID ANALYZER BUY -> missing stake, Analyzer market, or Analyzer digit data.');
                }

                logicalDuration = signal?.duration ?? signal?.logicalDuration ?? signal?.analyzerDuration ?? 1;
                logicalDurationUnit = signal?.duration_unit ?? signal?.durationUnit ?? signal?.logicalDurationUnit ?? signal?.analyzerDurationUnit ?? 't';

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: amount,
                    analyzer: true,
                    contract_type: 'DIGITMATCH',
                    symbol,
                    prediction: predictionDigit,
                    analyzer_entry_code: this.analyzerCommandKey || null,
                });

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'ANALYZER_EXECUTION',
                        analyzerExecutionStatus: 'ANALYZER_FINANCIAL_QUOTE',
                        contractType: 'DIGITMATCH',
                        stake: amount,
                        entryDigit,
                        prediction: predictionDigit,
                        hotDigit,
                        analyzerEntryCode: this.analyzerCommandKey || null,
                        payoutSource: 'DERIV_PROPOSAL',
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                const proposalRequest = {
                    proposal: 1,
                    amount,
                    basis: 'stake',
                    contract_type: 'DIGITMATCH',
                    currency,
                    duration: logicalDuration,
                    duration_unit: logicalDurationUnit,
                    underlying_symbol: symbol,
                    barrier: String(predictionDigit),
                    subscribe: 1,
                };

                let proposalResponse;
                try {
                    proposalResponse = await doUntilDone(
                        () => api_base.api.send(proposalRequest),
                        ['InvalidContractProposal']
                    );
                } catch (error) {
                    const code = error?.error?.code || error?.code || error?.message || 'unknown';
                    globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER FINANCIAL QUOTE ERROR -> ' + code);
                    throw error;
                }

                const proposal = proposalResponse?.proposal;
                const proposalId = proposal?.id;
                const askPrice = Number(proposal?.ask_price);
                const potentialPayout = Number(proposal?.payout);
                if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0 || !Number.isFinite(potentialPayout)) {
                    throw new Error('TRAPKID ANALYZER FINANCIAL QUOTE -> Deriv returned no valid payout quote.');
                }

                // Local Analyzer contract identity. This is NOT a Deriv contract_id.
                const analyzerContractId = String(
                    signal?.contractId ||
                    signal?.contract_id ||
                    signal?.analyzerContractId ||
                    this.analyzerCommandKey ||
                    signal.signalId
                );
                const entryCode = String(
                    signal?.entryCode ||
                    signal?.entry_code ||
                    this.analyzerCommandKey ||
                    signal.signalId
                );
                const entryQuote = Number(signal?.entryQuote ?? signal?.entry_quote ?? signal?.lockedQuote ?? signal?.quote);

                this.isSold = false;
                this.isExpired = false;
                this.isSellAvailable = true;
                this.contractId = analyzerContractId;
                this.analyzerContractId = analyzerContractId;
                this.derivContractId = '';
                this.derivBuy = null;
                this.derivBuyTransactionId = null;

                this.data.contract = {
                    id: analyzerContractId,
                    contract_id: analyzerContractId,
                    transaction_ids: { buy: entryCode, sell: null },
                    contract_type: 'DIGITMATCH',
                    symbol,
                    underlying_symbol: symbol,
                    barrier: predictionDigit,
                    prediction: predictionDigit,
                    buy_price: amount,
                    sell_price: 0,
                    bid_price: 0,
                    payout: potentialPayout,
                    currency,
                    analyzer_source: 'ANALYZER_ONLY',
                    analyzer_signal_id: String(signal.signalId),
                    analyzer_command_key: this.analyzerCommandKey,
                    analyzer_entry_code: entryCode,
                    analyzer_entry_digit: entryDigit,
                    analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                    analyzer_locked_quote: Number(signal?.lockedQuote ?? signal?.entryQuote ?? signal?.quote),
                    analyzer_hot_digit: hotDigit,
                    analyzer_prediction: predictionDigit,
                    duration: logicalDuration,
                    duration_unit: logicalDurationUnit,
                    analyzer_duration: logicalDuration,
                    analyzer_duration_unit: logicalDurationUnit,
                    analyzer_exit_status: 'WAITING_FOR_EARLY_SELL_READY',
                    analyzer_execution_status: 'WAITING_FOR_EARLY_SELL_READY',
                    analyzer_exit_code: null,
                    analyzer_contract_id: analyzerContractId,
                    deriv_proposal_id: String(proposalId),
                    deriv_proposal_ask_price: askPrice,
                    deriv_potential_payout: potentialPayout,
                    financial_status: 'DERIV_PROPOSAL_CONFIRMED',
                    status: 'open',
                    is_sold: false,
                    is_expired: false,
                    is_settleable: false,
                    is_valid_to_sell: true,
                };

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'WAITING_FOR_EARLY_SELL_READY',
                        analyzerExecutionStatus: 'WAITING_FOR_EARLY_SELL_READY',
                        executionTrigger: 'ANALYZER_ENTRY_COMMAND',
                        holdUntilAnalyzerExit: true,
                        analyzerExitStatus: 'WAITING_FOR_EARLY_SELL_READY',
                        signal,
                        signalId: String(signal.signalId),
                        commandKey: this.analyzerCommandKey,
                        entryDigit,
                        prediction: predictionDigit,
                        hotDigit,
                        analyzerContractId,
                        analyzerBuyContractId: analyzerContractId,
                        analyzerBuySignalId: String(signal.signalId),
                        analyzerContractSignalId: String(signal.signalId),
                        derivContractId: null,
                        derivTransactionId: null,
                        derivBuyPrice: null,
                        derivProposalId: String(proposalId),
                        derivProposalAskPrice: askPrice,
                        analyzerPotentialPayout: potentialPayout,
                        payout: potentialPayout,
                        payoutSource: 'DERIV_PROPOSAL',
                        analyzerEntryCode: entryCode,
                        analyzerEntryQuote: Number.isFinite(entryQuote) ? entryQuote : null,
                        lockedQuote: signal?.lockedQuote,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_READY',
                        purchaseInFlightKey: null,
                        purchaseConsumedKey: this.analyzerCommandKey,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                contract(this.data.contract);
                contractStatus({
                    id: 'contract.purchase_received',
                    data: entryCode,
                    buy: {
                        contract_id: analyzerContractId,
                        transaction_id: entryCode,
                        buy_price: amount,
                        payout: potentialPayout,
                        currency,
                        analyzer_local: true,
                        deriv_proposal_id: String(proposalId),
                        deriv_proposal_ask_price: askPrice,
                    },
                });

                globalObserver.emit('ui.log',
                    'TRAPKID ANALYZER LOCAL CONTRACT OPEN → ' + analyzerContractId +
                    ' → DERIV PROPOSAL PAYOUT=' + potentialPayout
                );

                const postPurchaseState = globalObserver.getState('trapkid_analyzer') || {};
                const readyExit = postPurchaseState.pendingEarlyExit?.status === 'EARLY_SELL_READY'
                    ? postPurchaseState.pendingEarlyExit
                    : postPurchaseState.exit;
                if (readyExit?.status === 'EARLY_SELL_READY' && !this.isSold) {
                    queueMicrotask(() => {
                        void this.onAnalyzerEarlyExit?.({
                            source: 'TRAPKID_ANALYZER_POST_PURCHASE',
                            command: 'ANALYZER_EARLY_EXIT',
                            commandKey: postPurchaseState.commandKey || this.analyzerCommandKey,
                            signalId: postPurchaseState.signalId || this.analyzerSignal?.signalId,
                            signal: postPurchaseState.signal || this.analyzerSignal,
                            exit: readyExit,
                            receivedAt: Date.now(),
                        });
                    });
                }

                this.analyzerPurchaseKey = this.analyzerCommandKey;
                delayIndex = 0;
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: entryCode },
                    contract_type: 'DIGITMATCH',
                    buy_price: amount,
                });

                return Promise.resolve({
                    buy: {
                        contract_id: analyzerContractId,
                        transaction_id: entryCode,
                        buy_price: amount,
                        payout: potentialPayout,
                        currency,
                        analyzer_local: true,
                        deriv_proposal_id: String(proposalId),
                        deriv_proposal_ask_price: askPrice,
                    },
                });
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
                        // if disconnected no need to resubscription (handled by live-api)
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

            // Analyzer mode is a real execution path, not a Builder simulation.
            // Log the exact BUY payload so the live DBot can be verified from the
            // browser journal and never silently stop before the API request.
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
