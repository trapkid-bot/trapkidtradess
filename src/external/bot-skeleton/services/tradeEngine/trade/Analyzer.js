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
                    'ANALYZER_DATA_BOUND',
                    'ANALYZER_PURCHASE_BOUND',
                    'EARLY_EXIT_COMMAND_RECEIVED',
                    'EARLY_EXIT_EXECUTING',
                ].includes(String(state?.status || ''));

            // expiresAt is only an entry-window guard for an un-authorized signal.
            // An Analyze-authorized signal remains valid for its single trade cycle.
            if (
                !signalAlreadyBound &&
                !commandAuthorizesSignal &&
                Number.isFinite(expiresAt) &&
                Date.now() >= expiresAt
            ) return null;

            return {
                ...signal,
                symbol: signal.symbol || state.symbol,
                prediction: Number.isInteger(Number(signal.prediction))
                    ? Number(signal.prediction)
                    : Number(signal.lockedDigit),
                lockedDigit: Number.isInteger(Number(signal.lockedDigit))
                    ? Number(signal.lockedDigit)
                    : null,
                hotDigit: Number.isInteger(Number(signal.hotDigit))
                    ? Number(signal.hotDigit)
                    : Number.isInteger(Number(state.hotDigit))
                      ? Number(state.hotDigit)
                      : null,
            };
        }

        async prepareAnalyzerPrediction() {
            if (!this.isAnalyzerEnabledForTrade()) return null;

            const signal = this.getExternalAnalyzerSignal();
            if (!signal) {
                throw new Error('TrapKid Analyzer: no active Analyzer signal. Trade blocked.');
            }

            if (!Number.isInteger(signal.prediction) || signal.prediction < 0 || signal.prediction > 9) {
                throw new Error('TrapKid Analyzer: signal has no valid prediction. Trade blocked.');
            }

            if (!signal.symbol) {
                throw new Error('TrapKid Analyzer: signal has no market. Trade blocked.');
            }

            // Hot digit is Analyzer exit metadata, not an entry gate.
            // Any Analyzer-produced digit is accepted for the entry signal.

            const pendingExit = this.getAnalyzerExit();
            if (pendingExit && String(pendingExit.signalId) === String(signal.signalId)) {
                throw new Error(
                    'TrapKid Analyzer: EARLY_SELL_READY is already active for this signal. New purchase blocked.'
                );
            }

            this.tradeOptions.symbol = signal.symbol;
            this.tradeOptions.prediction = signal.prediction;
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
