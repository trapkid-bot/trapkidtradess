import { LogTypes } from '../../../constants/messages';
import { contractStatus, info, log } from '../utils/broadcast';
import { getUUID } from '../utils/helpers';
import { observer as globalObserver } from '../../../utils/observer';

let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerMode =
                this.isAnalyzerEnabledForTrade?.() ||
                !!this.analyzerSignal ||
                ['ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND', 'WAITING_FOR_ANALYZER_EXIT', 'EARLY_EXIT_COMMAND_RECEIVED', 'ANALYZER_EXECUTION', 'RUNNING'].includes(
                    String(analyzerState.status || '')
                );

            if (analyzerMode) {
                const analyzerStateGate = globalObserver.getState('trapkid_analyzer') || {};
                // Analyzer entry is authorized by the execution trigger, not
                // by a transient UI/status label. The Analyzer bridge may move
                // the status to WAITING_FOR_ANALYZER_EXIT while the proposal is
                // still arriving; that must never cancel the already-authorized BUY.
                const gateSignal = analyzerStateGate.signal;
                const signalIdMatches =
                    !!gateSignal?.signalId &&
                    String(analyzerStateGate.signalId || '') === String(gateSignal.signalId);
                const lockedAtMatches =
                    Number.isFinite(Number(gateSignal?.lockedAt)) &&
                    Number(gateSignal.lockedAt) === Number(analyzerStateGate.lockedAt);
                const commandMatches =
                    signalIdMatches &&
                    String(analyzerStateGate.commandKey || '') ===
                        String(gateSignal.signalId) + ':' + String(gateSignal.lockedAt);
                const boundAnalyzerCommand = signalIdMatches && (commandMatches || lockedAtMatches);

                // Analyzer owns this execution path. A live signal bound to the same
                // signalId is sufficient authorization when the bridge has already
                // accepted the command but a UI refresh dropped executionArmed/trigger.
                // Never fall back to the Builder purchase gate.
                if (analyzerStateGate.executionArmed !== true && !boundAnalyzerCommand) {
                    globalObserver.emit(
                        'ui.log.error',
                        `TRAPKID ANALYZER BUY BLOCKED → no bound Analyzer command signal=${String(analyzerStateGate.signalId || gateSignal?.signalId || '')}`
                    );
                    return Promise.resolve();
                }

                // Restore the Analyzer-owned execution state after any bridge/UI refresh.
                if (String(analyzerStateGate.executionTrigger || '') !== 'ANALYZER_ENTRY' || analyzerStateGate.executionArmed !== true) {
                    globalObserver.emit(
                        'ui.log',
                        `TRAPKID ANALYZER BUY AUTHORIZED → normalizing trigger from ${String(analyzerStateGate.executionTrigger || 'none')} to ANALYZER_ENTRY`
                    );
                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...analyzerStateGate,
                            executionTrigger: 'ANALYZER_ENTRY',
                            executionArmed: true,
                        },
                    });
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
                    !Number.isInteger(signal.prediction) ||
                    !Number.isInteger(signal.hotDigit) ||
                    Number(signal.prediction) !== Number(signal.hotDigit)
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

                // One Analyzer signal can create exactly one contract.
                // Keep this guard in shared observer state so it survives
                // engine/restart callbacks.
                if (
                    currentAnalyzerState.purchaseConsumedKey === analyzerSignalKey ||
                    currentAnalyzerState.purchaseInFlightKey === analyzerSignalKey
                ) {
                    return Promise.resolve();
                }

                // Reserve the signal before sending the purchase request so
                // concurrent/restarted purchase callbacks cannot create a
                // second contract from the same Analyzer signal.
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...currentAnalyzerState,
                        status: 'ANALYZER_EXECUTION',
                        signal,
                        signalId: signal.signalId,
                        commandKey: analyzerSignalKey,
                        purchaseInFlightKey: analyzerSignalKey,
                        entryPrediction: signal.prediction,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                        executionTrigger: 'ANALYZER_ENTRY',
                    },
                });

                // Analyzer is the sole source of the actual Match entry values.
                // Any Bot Builder prediction value is overwritten here.
                // Hot digit is the sole canonical Analyzer prediction.
                this.tradeOptions.prediction = signal.hotDigit;
                this.tradeOptions.symbol = signal.symbol;
                // Analyzer owns the complete execution identity. Preserve its
                // entry/contract metadata instead of generating a new DBot
                // identity or replacing Analyzer's quote/code.
                this.tradeOptions.analyzerSignalId = String(signal.signalId);
                this.tradeOptions.analyzerCommandKey = analyzerSignalKey;
                this.tradeOptions.analyzerContractId =
                    signal.contractId ?? signal.contract_id ?? signal.analyzerContractId ?? String(signal.signalId);
                this.tradeOptions.analyzerEntryCode =
                    signal.entryCode ?? signal.entry_code ?? signal.signalId;
                this.tradeOptions.analyzerEntryQuote =
                    signal.entryQuote ?? signal.entry_quote ?? signal.quote;
                this.tradeOptions.analyzerLockedQuote =
                    signal.lockedQuote ?? signal.locked_quote ?? signal.quote;
                if (Number.isFinite(Number(signal.duration)) && Number(signal.duration) > 0) {
                    this.tradeOptions.duration = Number(signal.duration);
                    this.tradeOptions.duration_unit = signal.duration_unit || signal.durationUnit || 't';
                }

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'ANALYZER_EXECUTION',
                        symbol: signal.symbol,
                        signal,
                        signalId: signal.signalId,
                        commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                        prediction: signal.prediction,
                        lockedDigit: signal.lockedDigit,
                        hotDigit: signal.hotDigit,
                        entryPrediction: signal.prediction,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            }
            // Analyzer direct BUY does not depend on the Builder Redux purchase
            // scope. Never dispatch SELL/START here: those legacy state transitions
            // can interfere with the Analyzer-owned execution lifecycle.
            if (!analyzerMode) {
                return Promise.reject(
                    new Error('TrapKid Analyzer-only engine: non-Analyzer execution is disabled.')
                );
            }

            // Analyzer is the complete execution engine. Create the contract locally
            // from Analyzer data. No proposal, BUY request, or Deriv contract observer.
            const signal = this.analyzerSignal;
            const entryCode =
                this.tradeOptions.analyzerEntryCode ||
                signal?.entryCode ||
                signal?.entry_code ||
                signal?.signalId;
            const contractId =
                this.tradeOptions.analyzerContractId ||
                signal?.contractId ||
                signal?.contract_id ||
                entryCode;
            const entryQuote = Number(
                this.tradeOptions.analyzerEntryQuote ??
                signal?.entryQuote ??
                signal?.entry_quote ??
                signal?.quote
            );
            const buyPrice = Number(this.tradeOptions.amount) || 0;

            this.isSold = false;
            this.isExpired = false;
            this.isSellAvailable = true;
            this.contractId = String(contractId);
            this.analyzerContractId = String(contractId);
            this.data.contract = {
                contract_id: String(contractId),
                transaction_ids: { buy: String(entryCode) },
                contract_type: 'DIGITMATCH',
                symbol: signal?.symbol || this.tradeOptions.symbol,
                buy_price: buyPrice,
                sell_price: 0,
                currency: this.tradeOptions.currency || 'USD',
                analyzer_contract_id: String(contractId),
                analyzer_entry_code: String(entryCode),
                analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                status: 'open',
                is_sold: false,
            };

            globalObserver.setState({
                trapkid_analyzer: {
                    ...(globalObserver.getState('trapkid_analyzer') || {}),
                    status: 'WAITING_FOR_ANALYZER_EXIT',
                    signal,
                    signalId: signal.signalId,
                    commandKey: analyzerSignalKey,
                    purchaseInFlightKey: null,
                    purchaseConsumedKey: analyzerSignalKey,
                    executionArmed: true,
                    executionTrigger: 'ANALYZER_ENTRY',
                    holdUntilAnalyzerExit: true,
                    analyzerContractId: String(contractId),
                    analyzerEntryCode: String(entryCode),
                    analyzerEntryQuote: Number.isFinite(entryQuote) ? entryQuote : null,
                    settlementSource: 'ANALYZER',
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            contractStatus({ id: 'contract.purchase_sent', data: buyPrice });

            globalObserver.emit(
                'ui.log',
                `TRAPKID ANALYZER CONTRACT OPEN → ${String(entryCode)}`
            );

            return Promise.resolve({
                buy: {
                    contract_id: String(contractId),
                    transaction_id: String(entryCode),
                    buy_price: buyPrice,
                    currency: this.tradeOptions.currency || 'USD',
                    analyzer_contract_id: String(contractId),
                    analyzer_entry_code: String(entryCode),
                    analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                },
            });
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
