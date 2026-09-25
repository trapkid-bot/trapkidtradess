import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Analyzer extends Engine {
        isAnalyzerEnabledForTrade() {
            const contractTypes = this.tradeOptions?.contractTypes ?? [];
            return contractTypes.includes('DIGITMATCH');
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
            if (!Number.isFinite(lockedAt) || !Number.isFinite(expiresAt)) return null;
            if (Date.now() >= expiresAt) return null;

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

            const exitDigit = Number(exit.digit);
            const hotDigit = Number(signal.hotDigit);
            const signalId = String(signal.signalId || '');
            if (!signalId || !Number.isInteger(exitDigit) || exitDigit < 0 || exitDigit > 9) return null;
            if (!Number.isInteger(hotDigit) || hotDigit < 0 || hotDigit > 9) return null;
            if (exitDigit !== hotDigit) return null;

            return {
                signalId,
                commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                digit: exitDigit,
                hotDigit,
                quote: Number(exit.quote),
                epoch: Number(exit.epoch),
            };
        }

        clearAnalyzerLock() {
            this.analyzerSignal = null;
            this.analyzerCommandKey = null;
            globalObserver.setState({
                trapkid_analyzer: {
                    ...this.getAnalyzerState(),
                    status: 'WAITING_FOR_ANALYZER',
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
        }
    };
