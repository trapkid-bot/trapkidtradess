import { getLastDigit } from '../utils/helpers';
import { observer as globalObserver } from '../../../utils/observer';

const LOCK_DURATION_MS = 30_000;
const SAMPLE_SIZE = 100;

const getDigit = (quote, pipSize) => {
    if (typeof quote !== 'number' || !Number.isFinite(quote)) return null;

    const formatted = Number.isFinite(pipSize) ? quote.toFixed(pipSize) : String(quote);
    const digit = getLastDigit(formatted);

    return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : null;
};

export default Engine =>
    class Analyzer extends Engine {
        isAnalyzerEnabledForTrade() {
            const contractTypes = this.tradeOptions?.contractTypes ?? [];
            return contractTypes.includes('DIGITMATCH');
        }

        getAnalyzerState() {
            return globalObserver.getState('trapkid_analyzer') || {
                status: 'IDLE',
                symbol: this.tradeOptions?.symbol || this.symbol || null,
                lockedDigit: null,
                lockedAt: null,
                expiresAt: null,
                counts: {},
                sampleSize: 0,
            };
        }

        async prepareAnalyzerPrediction(force = false) {
            if (!this.isAnalyzerEnabledForTrade()) return null;

            const now = Date.now();
            const existing = this.analyzerLock;

            if (!force && existing && existing.expiresAt > now) {
                this.tradeOptions.prediction = existing.digit;
                return existing.digit;
            }

            const symbol = this.tradeOptions?.symbol || this.symbol;
            if (!symbol) throw new Error('TrapKid analyzer: no underlying symbol is selected.');

            const ticksService = this.$scope?.ticksService;
            if (!ticksService) throw new Error('TrapKid analyzer: tick service is not available.');

            const ticks = await ticksService.request({ symbol });
            const recentTicks = Array.isArray(ticks) ? ticks.slice(-SAMPLE_SIZE) : [];

            if (!recentTicks.length) {
                throw new Error('TrapKid analyzer: no tick data is available.');
            }

            const pipSize = ticksService.pipSizes?.[symbol];
            const counts = Array.from({ length: 10 }, () => 0);
            const lastSeen = Array.from({ length: 10 }, () => -1);

            recentTicks.forEach((tick, index) => {
                const digit = getDigit(tick.quote, pipSize);
                if (digit === null) return;
                counts[digit] += 1;
                lastSeen[digit] = index;
            });

            let bestDigit = 0;
            for (let digit = 1; digit <= 9; digit += 1) {
                if (
                    counts[digit] > counts[bestDigit] ||
                    (counts[digit] === counts[bestDigit] && lastSeen[digit] > lastSeen[bestDigit])
                ) {
                    bestDigit = digit;
                }
            }

            const lockedAt = Date.now();
            const expiresAt = lockedAt + LOCK_DURATION_MS;

            this.analyzerLock = {
                digit: bestDigit,
                symbol,
                lockedAt,
                expiresAt,
                counts,
                sampleSize: recentTicks.length,
            };

            this.tradeOptions.prediction = bestDigit;

            globalObserver.setState({
                trapkid_analyzer: {
                    status: 'LOCKED',
                    source: 'RISE_FALL_TICK_FEED',
                    symbol,
                    lockedDigit: bestDigit,
                    lockedAt,
                    expiresAt,
                    remainingMs: LOCK_DURATION_MS,
                    counts: Object.fromEntries(counts.map((count, digit) => [digit, count])),
                    sampleSize: recentTicks.length,
                },
            });

            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            globalObserver.emit(
                'ui.log.success',
                `TrapKid Analyzer: locked digit ${bestDigit} on ${symbol} for 30 seconds using the latest ${recentTicks.length} ticks.`
            );

            return bestDigit;
        }

        analyzerPredictionIsValid() {
            return !!this.analyzerLock && this.analyzerLock.expiresAt > Date.now();
        }

        clearAnalyzerLock() {
            this.analyzerLock = null;
            globalObserver.setState({
                trapkid_analyzer: {
                    ...this.getAnalyzerState(),
                    status: 'IDLE',
                    lockedDigit: null,
                    lockedAt: null,
                    expiresAt: null,
                    remainingMs: 0,
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
        }
    };
