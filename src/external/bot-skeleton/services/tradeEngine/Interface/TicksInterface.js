import { observer as globalObserver } from '../../../utils/observer';

const getTicksInterface = tradeEngine => {
    return {
        getDelayTickValue: (...args) => tradeEngine.getDelayTickValue(...args),
        getCurrentStat: (...args) => tradeEngine.getCurrentStat(...args),
        getStatList: (...args) => tradeEngine.getStatList(...args),
        getLastTick: (...args) => {
            if (typeof tradeEngine.getLastTick === 'function') return tradeEngine.getLastTick(...args);

            // Analyzer-only fallback: never call Deriv ticksService.
            const state = globalObserver.getState('trapkid_analyzer') || {};
            const signal = state.signal || {};
            const tick = state.lastTick ?? state.currentTick ?? null;

            const quote = Number(
                typeof tick === 'object' && tick !== null
                    ? tick.quote ?? tick.price ?? tick.value
                    : tick ?? signal.lockedQuote ?? signal.entryQuote
            );

            if (!Number.isFinite(quote)) return Promise.resolve(null);

            const [raw = false, toString = false] = args;

            if (raw) {
                return Promise.resolve({
                    quote,
                    epoch: Number(state.serverTime ?? state.epoch ?? signal.lockedAt ?? Date.now()),
                });
            }

            return Promise.resolve(toString ? quote.toFixed(2) : quote);
        },
        getLastDigit: (...args) => tradeEngine.getLastDigit(...args),
        getTicks: (...args) => tradeEngine.getTicks(...args),
        checkDirection: (...args) => tradeEngine.checkDirection(...args),
        getOhlcFromEnd: (...args) => tradeEngine.getOhlcFromEnd(...args),
        getOhlc: (...args) => tradeEngine.getOhlc(...args),
        getLastDigitList: (...args) => tradeEngine.getLastDigitList(...args),
    };
};

export default getTicksInterface;
