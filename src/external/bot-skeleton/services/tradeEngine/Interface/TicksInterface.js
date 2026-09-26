import { observer as globalObserver } from '../../../utils/observer';

const getTicksInterface = tradeEngine => {
    return {
        getDelayTickValue: (...args) => tradeEngine.getDelayTickValue(...args),
        getCurrentStat: (...args) => tradeEngine.getCurrentStat(...args),
        getStatList: (...args) => tradeEngine.getStatList(...args),
        getLastTick: (...args) => {\n            if (typeof tradeEngine.getLastTick === 'function') return tradeEngine.getLastTick(...args);\n            // Analyzer-only fallback: never call Deriv ticksService.\n            const state = globalObserver.getState('trapkid_analyzer') || {};\n            const signal = state.signal || {};\n            const quote = Number(state.lastTick?.quote ?? state.lastTick ?? state.currentTick ?? signal.lockedQuote ?? signal.entryQuote);\n            if (!Number.isFinite(quote)) return Promise.resolve(null);\n            const [raw = false, toString = false] = args;\n            if (raw) return Promise.resolve({ quote, epoch: Number(state.serverTime ?? signal.lockedAt ?? Date.now()) });\n            return Promise.resolve(toString ? quote.toFixed(2) : quote);\n        },
        getLastDigit: (...args) => tradeEngine.getLastDigit(...args),
        getTicks: (...args) => tradeEngine.getTicks(...args),
        checkDirection: (...args) => tradeEngine.checkDirection(...args),
        getOhlcFromEnd: (...args) => tradeEngine.getOhlcFromEnd(...args),
        getOhlc: (...args) => tradeEngine.getOhlc(...args),
        getLastDigitList: (...args) => tradeEngine.getLastDigitList(...args),
    };
};

export default getTicksInterface;
