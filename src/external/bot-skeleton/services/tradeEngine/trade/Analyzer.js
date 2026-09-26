import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Analyzer extends Engine {
        isAnalyzerEnabledForTrade(options = this.tradeOptions) {
            const contractTypes = options?.contractTypes ?? [];
            return (
                contractTypes.includes('DIGITMATCH') ||
                options?.contractType === 'DIGITMATCH' ||
                options?.contract_type === 'DIGITMATCH'
            );
        }

        getAnalyzerState() {
            return globalObserver.getState('trapkid_analyzer') || {
                status: 'IDLE',
                symbol: null,
                signal: null,
                lockedDigit: null,
                prediction: null,
                hotDigit: null,
                lockedAt: null,
                expiresAt: null,
                exit: null,
            };
        }

        getExternalAnalyzerSignal() {
            const state = this.getAnalyzerState();
            const signal = state?.signal;
            if (!signal || !signal.signalId) return null;

            const lockedAt = Number(signal.lockedAt);
            const expiresAt = Number(signal.expiresAt);
            if (!Number.isFinite(lockedAt)) return null;

            // expiresAt only controls whether a NEW signal may be entered.
            // Once this exact signal is bound to the trade, it stays locked
            // until its matching Analyzer early-exit event arrives.
            const boundSignalKey = this.analyzerSignal
                ? String(this.analyzerSignal.signalId || '') + ':' + String(this.analyzerSignal.lockedAt || '')
                : '';
            const currentSignalKey = String(signal.signalId || '') + ':' + String(signal.lockedAt || '');
            const signalAlreadyBound = !!boundSignalKey && boundSignalKey === currentSignalKey;
            const observerCommandKey = String(state?.commandKey || '');
            const commandAuthorizesSignal =
                observerCommandKey === currentSignalKey &&
                [
                    'COMMAND_RECEIVED',
                    'COMMAND_ACCEPTED',
                    'RUNNING',
                    'WAITING_FOR_ANALYZER_EXIT',
                    'ANALYZER_EXECUTION',
                    'ANALYZER_DATA_BOUND',
                    'ANALYZER_PURCHASE_BOUND',
                    'EARLY_EXIT_COMMAND_RECEIVED',
                    'WAITING_FOR_ANALYZER_EXIT_DIGIT',
                    'EARLY_EXIT_EXECUTING',
                ].includes(String(state?.status || ''));

            // The Analyzer lock is a hard execution window. The signal may be
            // analyzed and displayed immediately, but DBot can only execute
            // while this exact lock is alive.
            const lockExpiry = Number.isFinite(expiresAt)
                ? expiresAt
                : lockedAt + 30000;

            // A signal that is already bound to this execution cycle remains
            // valid until Analyzer sends EARLY_SELL_READY. Expiry is only an
            // entry freshness guard; it must not kill an already-authorized buy.
            if (!signalAlreadyBound && Date.now() >= lockExpiry) return null;

            const rawHotDigit = signal.hotDigit ?? state.hotDigit;
            const hotDigit = Number.isInteger(Number(rawHotDigit)) ? Number(rawHotDigit) : null;
            const rawLockedEntry = signal.entryDigit ?? signal.lockedDigit ?? signal.prediction;
            const lockedEntryDigit = Number.isInteger(Number(rawLockedEntry)) ? Number(rawLockedEntry) : null;

            return {
                ...signal,
                symbol: signal.symbol || state.symbol,
                // ANALYZER ONLY rule:
                // the Analyzer hot digit is the canonical prediction used by
                // the DBot DIGITMATCH contract and by the Analyzer exit watcher.
                // The raw Analyzer prediction is never allowed to override it.
                entryDigit: hotDigit,
                prediction: hotDigit,
                lockedEntryDigit,
                lockedDigit: Number.isInteger(Number(signal.lockedDigit))
                    ? Number(signal.lockedDigit)
                    : lockedEntryDigit,
                hotDigit,
            };
        }

        async waitForAnalyzerSignal(timeoutMs = 10000) {
            // Analyze is the execution trigger. Use the lock that already exists
            // at click time immediately; only wait briefly if Analyzer is still
            // publishing that current lock.
            const immediate = this.getExternalAnalyzerSignal();
            if (immediate?.signalId && Number.isInteger(Number(immediate.hotDigit)) && immediate.symbol) {
                return immediate;
            }
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                const signal = this.getExternalAnalyzerSignal();
                if (signal?.signalId && Number.isInteger(Number(signal.hotDigit)) && signal.symbol) {
                    return signal;
                }
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return null;
        }

        async prepareAnalyzerPrediction() {
            if (!this.isAnalyzerEnabledForTrade()) return null;

            const signal = this.getExternalAnalyzerSignal();
            if (!signal) {
                throw new Error('TrapKid Analyzer: no active Analyzer signal. Trade blocked.');
            }

            if (!Number.isInteger(signal.hotDigit) || signal.hotDigit < 0 || signal.hotDigit > 9) {
                throw new Error('TrapKid Analyzer: signal has no valid hot/exit digit. Trade blocked.');
            }

            // The hot digit is the only Analyzer-authorized prediction.
            // Do not allow a different raw prediction/entry digit into DBot.
            signal.entryDigit = signal.hotDigit;
            signal.prediction = signal.hotDigit;

            if (!signal.symbol) {
                throw new Error('TrapKid Analyzer: signal has no market. Trade blocked.');
            }

            // EARLY_SELL_READY may arrive before the purchase is completed.
            // Keep the signal purchasable; Purchase.js will bind the pending
            // Analyzer exit immediately after the contract is created.
            // The hot digit remains the only authorized exit digit.

            this.tradeOptions.symbol = signal.symbol;
            this.tradeOptions.prediction = signal.hotDigit;
            this.analyzerSignal = signal;
            this.analyzerCommandKey = String(signal.signalId) + ':' + String(signal.lockedAt);

            globalObserver.setState({
                trapkid_analyzer: {
                    ...this.getAnalyzerState(),
                    status: 'ANALYZER_DATA_BOUND',
                    symbol: signal.symbol,
                    signal,
                    signalId: signal.signalId,
                    commandKey: this.analyzerCommandKey,
                    lockedDigit: signal.lockedDigit,
                    prediction: signal.prediction,
                    hotDigit: signal.hotDigit,
                    lockedAt: signal.lockedAt,
                    expiresAt: signal.expiresAt,
                    analyzerBoundAt: Date.now(),
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            return signal.prediction;
        }

        analyzerPredictionIsValid() {
            const signal = this.getExternalAnalyzerSignal();
            return !!signal && !!this.analyzerSignal &&
                String(signal.signalId) === String(this.analyzerSignal.signalId) &&
                Number(signal.lockedAt) === Number(this.analyzerSignal.lockedAt);
        }

        getAnalyzerExit() {
            const state = this.getAnalyzerState();
            const exit = state?.exit;
            const signal = this.analyzerSignal || state?.signal;
            if (!exit || exit.status !== 'EARLY_SELL_READY' || !signal) return null;

            const exitSignalId = String(exit.signalId || '');
            const signalId = String(signal.signalId || '');
            if (exitSignalId && exitSignalId !== signalId) return null;

            const exitDigit = Number(exit.digit);
            const hotDigit = Number(signal.hotDigit);
            if (!signalId || !Number.isInteger(exitDigit) || exitDigit < 0 || exitDigit > 9) return null;
            if (!Number.isInteger(hotDigit) || hotDigit < 0 || hotDigit > 9) return null;

            // Analyzer hotDigit is the ONLY authorized exit digit.
            // Ignore any other digit supplied in the exit payload.
            if (exitDigit !== hotDigit) return null;

            return {
                signalId,
                commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                digit: hotDigit,
                hotDigit,
                quote: Number(exit.quote),
                epoch: Number(exit.epoch),
            };        }

        clearAnalyzerLock() {
            this.analyzerSignal = null;
            this.analyzerCommandKey = null;
            globalObserver.setState({
                trapkid_analyzer: {
                    ...this.getAnalyzerState(),
                    status: 'WAITING_FOR_ANALYZER',
                    exit: null,
                    commandKey: null,
                    signalId: null,
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
        }
    };
