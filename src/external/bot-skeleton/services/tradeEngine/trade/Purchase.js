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
const ANALYZER_PHYSICAL_HOLD_TICKS = 100000;
const ANALYZER_LOGICAL_DURATION = 100000;
const ANALYZER_LOGICAL_DURATION_UNIT = 't';

export default Engine =>
    class Purchase extends Engine {
        async purchase(contract_type) {
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
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
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
                // Analyzer supplies the decision; the bot keeps its normal
                // Analyzer Match mode keeps the position open while the live stream searches.
                this.tradeOptions.duration = ANALYZER_PHYSICAL_HOLD_TICKS;
                this.tradeOptions.duration_unit = 't';

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
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
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
                    duration: ANALYZER_LOGICAL_DURATION,
                    duration_unit: ANALYZER_LOGICAL_DURATION_UNIT,
                    analyzer_duration: ANALYZER_LOGICAL_DURATION,

                    analyzer_duration_unit: ANALYZER_LOGICAL_DURATION_UNIT,
                    deriv_physical_duration: ANALYZER_PHYSICAL_HOLD_TICKS,
                    deriv_physical_duration_unit: 't',
                    analyzer_exit_status: 'WAITING_FOR_ANALYZER_EARLY_SELL',
                    analyzer_execution_status: 'WAITING_FOR_ANALYZER_EARLY_SELL',
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
                        analyzerLogicalDuration: ANALYZER_LOGICAL_DURATION,
                        analyzerLogicalDurationUnit: ANALYZER_LOGICAL_DURATION_UNIT,
                        derivPhysicalDuration: ANALYZER_PHYSICAL_HOLD_TICKS,
                        derivPhysicalDurationUnit: 't',
                        payoutSource: 'DERIV_BUY',
                        derivBalanceAfterBuy: Number.isFinite(Number(buy.balance_after)) ? Number(buy.balance_after) : null,
                        signal: this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal,
                        signalId: this.analyzerSignal?.signalId,
                        commandKey: this.analyzerCommandKey,
                        entryPrediction: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                        lockedQuote: this.analyzerSignal?.lockedQuote,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                        executionTrigger: null,
                        purchaseInFlightKey: null,
                        purchaseConsumedKey: purchasedSignalKey || undefined,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                // EARLY_SELL_READY is an Analyzer observation only.
                // Never send a Deriv SELL request from this event. The BUY has
                // already created the contract; settlement is handled by Deriv.
                const postPurchaseState = globalObserver.getState('trapkid_analyzer') || {};
                const liveExit = postPurchaseState.exit;
                const pendingExit = postPurchaseState.pendingEarlyExit;
                const readyExit = pendingExit?.status === 'EARLY_SELL_READY' ? pendingExit : liveExit;
                const pendingMatches =
                    readyExit?.status === 'EARLY_SELL_READY' &&
                    String(readyExit.signalId || this.analyzerSignal?.signalId || '') === String(this.analyzerSignal?.signalId || '') &&
                    Number(readyExit.digit) === Number(this.analyzerSignal?.hotDigit);

                this.store.dispatch(purchaseSuccessful());

                if (pendingMatches && this.contractId && !this.isSold) {
                    // The Analyzer exit may already be READY by the time BUY returns.
                    // Promote the exact contract immediately so Summary/Transactions
                    // never show a stale WAITING state after the Analyzer has signaled
                    // EARLY_SELL_READY.
                    this.data.contract = {
                        ...(this.data.contract || {}),
                        analyzer_exit_status: 'EARLY_SELL_READY',
                        analyzer_execution_status: 'EARLY_SELL_READY',
                        analyzer_exit_code:
                            String(this.analyzerSignal?.signalId || '') + ':' + String(readyExit?.epoch || ''),
                        analyzer_exit_digit: Number(this.analyzerSignal?.hotDigit),
                        analyzer_exit_quote: Number.isFinite(Number(readyExit?.quote))
                            ? Number(readyExit.quote)
                            : null,
                        analyzer_hot_digit: Number(this.analyzerSignal?.hotDigit),
                        analyzer_prediction: Number(this.analyzerSignal?.hotDigit),
                        analyzer_contract_id: String(this.contractId),
                        analyzer_contract_signal_id: this.analyzerSignal?.signalId || null,
                    };
                    contract(this.data.contract);

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...(globalObserver.getState('trapkid_analyzer') || {}),
                            status: 'EARLY_SELL_READY',
                            analyzerExecutionStatus: 'EARLY_SELL_READY',
                            signal: this.analyzerSignal,
                            signalId: this.analyzerSignal?.signalId,
                            commandKey: purchasedSignalKey,
                            symbol: this.analyzerSignal?.symbol,
                            prediction: Number(this.analyzerSignal?.hotDigit),
                            entryDigit: Number(this.analyzerSignal?.entryDigit),
                            hotDigit: Number(this.analyzerSignal?.hotDigit),
                            entrySource: 'ANALYZER_ONLY',
                            exitSource: 'ANALYZER_EXIT_SIGNAL_ONLY',
                            exit: { ...readyExit, status: 'EARLY_SELL_READY' },
                            analyzerExitStatus: 'EARLY_SELL_READY',
                            analyzerExitDigit: Number(this.analyzerSignal?.hotDigit),
                            analyzerExitQuote: Number.isFinite(Number(readyExit?.quote)) ? Number(readyExit.quote) : null,
                            executionTrigger: 'ANALYZER_EARLY_SELL_READY',
                            holdUntilAnalyzerExit: false,
                            executionArmed: true,
                            pendingEarlyExit: null,
                            settlementSource: 'ANALYZER_EARLY_SELL_PENDING',
                            analyzerContractId: String(this.contractId),
                            derivContractId: String(this.contractId),
                        },
                    });
                    globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
                    globalObserver.emit(
                        'ui.log',
                        'TRAPKID ANALYZER → EARLY_SELL_READY observed after BUY → same contract=' + String(this.contractId)
                    );
                }

                // Restore the working contract watcher, but its only
                // settlement trigger is Analyzer EARLY_SELL_READY for the
                // Analyzer hot digit. It never accepts broker expiry/win/loss
                // as an Analyzer exit.

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

            // Analyzer supplies only the trade decision. Use Deriv's normal
            // proposal -> buy sequence so the financial contract is created
            // exactly through the same API mechanics as the normal bot.
            if (analyzerMode) {
                const signal = this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal;
                const amount = Number(this.tradeOptions?.amount);
                // Analyzer is authoritative for the market and DIGITMATCH prediction.
                // entryDigit remains the locked entry-code field; hotDigit is the
                // canonical digit the DIGITMATCH contract must predict.
                const symbol = String(signal?.symbol || '');
                const entryDigit = Number(signal?.entryDigit);
                const hotDigit = Number(signal?.hotDigit);
                const predictionDigit = hotDigit;
                // hotDigit is the canonical DIGITMATCH prediction/barrier for this Analyzer trade.
                const currency = this.tradeOptions?.currency || 'USD';

                if (!signal?.signalId || !symbol || !Number.isFinite(amount) || amount <= 0 ||
                    !Number.isInteger(entryDigit) || entryDigit < 0 || entryDigit > 9 ||
                    !Number.isInteger(predictionDigit) || predictionDigit < 0 || predictionDigit > 9) {
                    throw new Error('TRAPKID ANALYZER BUY -> missing stake, Analyzer market, or Analyzer entry digit.');
                }

                // HARD ANALYZER-ONLY RULES:
                // 1. Contract type is DIGITMATCH.
                // 2. Market is Analyzer signal.symbol.
                // 3. DIGITMATCH prediction/barrier is Analyzer signal.hotDigit.
                // 4. Match mode keeps the position open while the Analyzer stream searches.
                // 5. entryDigit remains metadata for the locked Analyzer entry code.
                // 6. The exact Deriv BUY contract_id is canonical and must be the contract sold.
                // 7. The matching hot digit is the Analyzer-authorized exit event.
                // The exact BUY remains bound to this signal; no replacement contract is created.
                const logicalDuration = ANALYZER_LOGICAL_DURATION;
                const logicalDurationUnit = ANALYZER_LOGICAL_DURATION_UNIT;
                const physicalHoldDuration = ANALYZER_PHYSICAL_HOLD_TICKS;

                const proposalRequest = {
                    proposal: 1,
                    amount,
                    basis: 'stake',
                    contract_type: 'DIGITMATCH',
                    currency,
                    duration: ANALYZER_PHYSICAL_HOLD_TICKS,
                    duration_unit: 't',
                    underlying_symbol: symbol,
                    barrier: String(predictionDigit),
                };

                // Publish the normal DBot buying lifecycle before the broker
                // request so Summary/Transactions can show the command moving
                // from ANALYZER → BUYING instead of remaining visually empty.
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
                        analyzerExecutionStatus: 'ANALYZER_BUYING',
                        contractType: 'DIGITMATCH',
                        stake: amount,
                        entryDigit,
                        prediction: predictionDigit,
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
                        derivPhysicalDuration: physicalHoldDuration,
                        derivPhysicalDurationUnit: 't',
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                // A proposal can become invalid between proposal and buy.
                // Never retry a stale proposal id: request a fresh Analyzer-bound
                // proposal and only accept the first successful BUY. This preserves
                // the one-signal -> one-contract invariant while eliminating
                // ContractBuyValidationError caused by an expired/moved proposal.
                const makeFreshAnalyzerProposal = async () => {
                    const response = await api_base.api.send({
                        proposal: 1,
                        amount,
                        basis: 'stake',
                        contract_type: 'DIGITMATCH',
                        currency,
                        duration: ANALYZER_PHYSICAL_HOLD_TICKS,
                        duration_unit: 't',
                        underlying_symbol: symbol,
                        barrier: String(predictionDigit),
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

                        // Refresh the proposal immediately before retrying the buy.
                        // No second contract can exist because no BUY succeeded yet.
                        const fresh = await makeFreshAnalyzerProposal();
                        activeProposalId = fresh.id;
                        activeAskPrice = fresh.askPrice;

                        globalObserver.setState({
                            trapkid_analyzer: {
                                ...(globalObserver.getState('trapkid_analyzer') || {}),
                                derivProposalId: activeProposalId,
                                derivProposalAskPrice: activeAskPrice,
                                analyzerEntryDigit: entryDigit,
                                analyzerPrediction: predictionDigit,
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
        async monitorAnalyzerSettlement(contractId, signalKey) {
            const exactContractId = String(contractId || '');
            if (!exactContractId) return false;
            if (this.analyzerSettlementPromise) return this.analyzerSettlementPromise;

            this.analyzerSettlementPromise = (async () => {
                // EARLY_SELL_READY can arrive in the same tick as the BUY.
                // Use a tight observer loop so local polling does not add a
                // 100ms delay to an already time-critical 1-tick contract.
                const maxChecks = 3000;
                const intervalMs = 10;

                for (let attempt = 0; attempt < maxChecks; attempt += 1) {
                    const liveState = globalObserver.getState('trapkid_analyzer') || {};
                    const signal = liveState?.signal?.signalId ? liveState.signal : this.analyzerSignal;
                    const exit = liveState?.exit;
                    const hotDigit = Number(signal?.hotDigit);
                    const ready =
                        String(signal?.signalId || '') === String(signalKey || '').split(':')[0] &&
                        exit?.status === 'EARLY_SELL_READY' &&
                        String(exit?.signalId || signal?.signalId || '') === String(signal?.signalId || '') &&
                        Number.isInteger(hotDigit) &&
                        Number(exit?.digit) === hotDigit;

                    if (ready && !this.isSold) {
                        globalObserver.setState({
                            trapkid_analyzer: {
                                ...liveState,
                                status: 'EARLY_EXIT_EXECUTING',
                                analyzerExecutionStatus: 'EARLY_EXIT_EXECUTING',
                                analyzerContractId: exactContractId,
                                derivContractId: exactContractId,
                                analyzerExitStatus: 'EARLY_SELL_READY',
                                analyzerExitDigit: hotDigit,
                                executionTrigger: 'EARLY_SELL_READY',
                                holdUntilAnalyzerExit: false,
                                exit: {
                                    ...exit,
                                    status: 'EARLY_SELL_READY',
                                    signalId: String(signal.signalId),
                                    digit: hotDigit,
                                },
                            },
                        });
                        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                        const sold = await this.sellAtMarket('ANALYZER_EARLY_SELL');
                        if (sold) return true;

                        // Keep watching. A failed attempt must never fall back
                        // to a different digit or automatic expiry settlement.
                        await new Promise(resolve => setTimeout(resolve, intervalMs));
                        continue;
                    }

                    // Analyzer remains the sole exit authority. We deliberately
                    // do not use proposal_open_contract won/lost/expired here.
                    await new Promise(resolve => setTimeout(resolve, intervalMs));
                }

                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER WATCHER → timed out waiting for hot digit=' +
                        String(this.analyzerSignal?.hotDigit ?? '') +
                        ' on SAME CONTRACT=' + exactContractId
                );
                return false;
            })().finally(() => {
                this.analyzerSettlementPromise = null;
            });

            return this.analyzerSettlementPromise;
        }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
