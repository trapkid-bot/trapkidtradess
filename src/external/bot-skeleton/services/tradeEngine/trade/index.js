import { applyMiddleware, createStore } from 'redux';
import { thunk } from 'redux-thunk';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
import { expectInitArg } from '../utils/sanitize';
import { expectInitArg } from '../utils/sanitize';
import { start } from './state/actions';
import rootReducer from './state/reducers';
import Balance from './Balance';
import Purchase from './Purchase';
import Sell from './Sell';
import Total from './Total';
import Analyzer from './Analyzer';

export default class TradeEngine extends Balance(Purchase(Sell(Analyzer(Total(class {}))))) {
    constructor($scope) {
        super();
        this.observer = $scope.observer;
        this.$scope = $scope;
        // Analyzer-only engine: no Deriv subscriptions, account login, proposal
        // polling, open-contract polling, or broker settlement callbacks.
        this.analyzerOnly = true;
        this.accountInfo = { loginid: 'ANALYZER', currency: 'USD' };
        this.observe();
        this.data = {
            contract: {},
            proposals: [],
        };
        this.subscription_id_for_accumulators = null;
        this.is_proposal_requested_for_accumulators = false;
        globalObserver.register('trapkid.analyzer.exit', this.onAnalyzerEarlyExit);
        this.store = createStore(rootReducer, applyMiddleware(thunk));
    }

    onAnalyzerEarlyExit = async command => {
        // Analyzer owns the full lifecycle:
        // 1) a locked signal authorizes the BUY immediately;
        // 2) the purchased contract stays open;
        // 3) EARLY_SELL_READY is the ONLY event allowed to SELL it.
        // Never turn EARLY_SELL_READY into another BUY.
        const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
        if (
            ![
                'WAITING_FOR_ANALYZER_EXIT',
                'COMMAND_RECEIVED',
                'COMMAND_ACCEPTED',
                'ANALYZER_DATA_BOUND',
                'ANALYZER_EXECUTION',
                'ANALYZER_TRADE_LOCKED',
                'RUNNING',
                'WAITING_FOR_ANALYZER_EXIT_DIGIT',
            ].includes(String(analyzerState.status || ''))
        ) return;
        const signal = this.analyzerSignal || analyzerState.signal;
        const boundSignalKey =
            signal?.signalId && Number.isFinite(Number(signal?.lockedAt))
                ? String(signal.signalId) + ':' + String(signal.lockedAt)
                : '';
        const boundAnalyzerExit =
            !!boundSignalKey &&
            String(analyzerState.commandKey || '') === boundSignalKey &&
            (
                analyzerState.executionArmed === true ||
                analyzerState.purchaseConsumedKey === boundSignalKey ||
                analyzerState.purchaseInFlightKey === boundSignalKey ||
                this.analyzerPurchaseKey === boundSignalKey
            );

        // Once the exact Analyzer signal is bound to this contract, the
        // Analyzer exit event remains authoritative even if a UI/state refresh
        // dropped executionArmed. Builder execution rules must not block it.
        if (!boundAnalyzerExit) return;
        const commandSignalId = String(command?.signalId || command?.signal?.signalId || '');
        const activeSignalId = String(signal?.signalId || '');

        if (!signal || !commandSignalId || commandSignalId !== activeSignalId) return;

        const activeSignalKey = String(signal?.signalId || '') + ':' + String(signal?.lockedAt || '');
        const boundCommandKey = String(analyzerState.commandKey || '');
        const signalIsBoundToThisTrade =
            boundCommandKey === activeSignalKey &&
            (
                analyzerState.executionArmed === true ||
                analyzerState.purchaseInFlightKey === activeSignalKey ||
                analyzerState.purchaseConsumedKey === activeSignalKey
            );

        const lockExpiry = Number(signal?.expiresAt);
        // Once this exact Analyzer signal is bound to the running trade,
        // expiry is no longer allowed to cancel the pending/active lifecycle.
        if (!signalIsBoundToThisTrade && Number.isFinite(lockExpiry) && Date.now() >= lockExpiry) return;

        const bridgeExit = command?.exit || analyzerState?.exit;
        const exit = this.getAnalyzerExit?.() || (
            bridgeExit?.status === 'EARLY_SELL_READY'
                ? {
                    signalId: String(bridgeExit.signalId || commandSignalId),
                    digit: Number(bridgeExit.digit),
                    hotDigit: Number(signal.hotDigit),
                    quote: Number(bridgeExit.quote),
                    epoch: Number(bridgeExit.epoch),
                }
                : null
        );
        if (
            !exit ||
            String(exit.signalId) !== activeSignalId ||
            !Number.isInteger(Number(exit.digit)) ||
            Number(exit.digit) < 0 ||
            Number(exit.digit) > 9 ||
            Number(exit.digit) !== Number(signal.hotDigit)
        ) {
            return;
        }

        const commandKey = String(signal.signalId) + ':' + String(signal.lockedAt);
        if (String(analyzerState.commandKey || '') !== commandKey) return;

        // EARLY_SELL_READY is an EXIT-only event. If the BUY is still in
        // flight, remember the exact exit instead of dropping the event.
        // The pending exit is consumed immediately after contractId exists.
        if (!this.contractId || this.isSold) {
            globalObserver.setState({
                trapkid_analyzer: {
                    ...analyzerState,
                    pendingEarlyExit: {
                        ...exit,
                        status: 'EARLY_SELL_READY',
                        signalId: activeSignalId,
                    },
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            return;
        }
        const analyzerPurchaseBound =
            analyzerState.purchaseConsumedKey === commandKey ||
            this.analyzerPurchaseKey === commandKey;

        if (!analyzerPurchaseBound || analyzerState.purchaseInFlightKey) {
            return;
        }

        // The contract is already open. EARLY_SELL_READY now closes that
        // existing Analyzer contract and can never create a second BUY.
        this.tradeOptions = {
            ...this.tradeOptions,
            contractTypes: ['DIGITMATCH'],
            symbol: signal.symbol,
            prediction: Number(signal.hotDigit),
            duration: this.tradeOptions?.duration,
            duration_unit: this.tradeOptions?.duration_unit,
        };

        globalObserver.setState({
            trapkid_analyzer: {
                ...analyzerState,
                status: 'EARLY_EXIT_COMMAND_RECEIVED',
                signal,
                signalId: signal.signalId,
                commandKey,
                symbol: signal.symbol,
                prediction: Number(signal.hotDigit),
                hotDigit: Number(signal.hotDigit),
                entryPrediction: Number(signal.hotDigit),
                entrySource: 'ANALYZER_ONLY',
                exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                executionTrigger: 'EARLY_SELL_READY',
                holdUntilAnalyzerExit: false,
                executionArmed: true,
                cycleFinished: false,
            },
        });
        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

        // The contract is already purchased in Analyzer mode. This event
        // only closes that existing contract.
        globalObserver.setState({
            trapkid_analyzer: {
                ...analyzerState,
                status: 'EARLY_EXIT_COMMAND_RECEIVED',
                signal,
                signalId: signal.signalId,
                commandKey,
                symbol: signal.symbol,
                prediction: Number(signal.hotDigit),
                hotDigit: Number(signal.hotDigit),
                executionTrigger: 'EARLY_SELL_READY',
                holdUntilAnalyzerExit: false,
                executionArmed: true,
                cycleFinished: false,
            },
        });
        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

        if (this.contractId && !this.isSold) {
            void this.sellAtMarket('ANALYZER_EARLY_SELL').catch(error => {
                globalObserver.emit('ui.log.error', error?.message || 'Analyzer early sell failed.');
            });
        }
    };

    init(...args) {
        const [, options] = expectInitArg(args);
        const { symbol } = options;

        this.initArgs = args;
        this.options = options;
        // The execution engine is intentionally independent of Deriv.
        // Analyzer supplies the signal, contract identity and settlement.
        this.startPromise = Promise.resolve();

        // Analyzer supplies market/ticks/signals. Do not start the DBot
        // Deriv tick monitor.
    }

    start(tradeOptions) {
        if (!this.options) {
            throw createError('NotInitialized', getLocalizedErrorMessage('NotInitialized'));
        }

        globalObserver.emit('bot.running');

        const validated_trade_options = this.validateTradeOptions(tradeOptions);

        // Start with the user's strategy shape only so we can identify the
        // selected contract type. Analyzer mode is decided AFTER tradeOptions
        // exists; Analyzer is then the only source allowed to bind symbol/prediction.
        this.tradeOptions = {
            ...validated_trade_options,
        };

        this.store.dispatch(start());
        this.checkLimits(validated_trade_options);

        const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
        const analyzerSignal = analyzerState?.signal;
        {
            this.prepareAnalyzerPrediction()
                .then(() => {
                    const analyzerSignal = this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal;
                    if (!analyzerSignal?.signalId) {
                        throw new Error('TrapKid Analyzer: no authorized signal for purchase.');
                    }

                    // Analyzer owns the execution path. Builder limits, proposal
                    // gates and strategy values are not applied in this mode.
                    this.tradeOptions = {
                        ...this.tradeOptions,
                        contractTypes: ['DIGITMATCH'],
                        symbol: analyzerSignal.symbol,
                        prediction: Number(analyzerSignal.hotDigit),
                    };

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...(globalObserver.getState('trapkid_analyzer') || {}),
                            // Analyzer controls the entire trade lifecycle:
                            // buy immediately after the signal is locked, then
                            // keep the contract open until EARLY_SELL_READY.
                            status: 'ANALYZER_PURCHASE_AUTHORIZED',
                            signal: analyzerSignal,
                            signalId: analyzerSignal.signalId,
                            commandKey: String(analyzerSignal.signalId) + ':' + String(analyzerSignal.lockedAt),
                            symbol: analyzerSignal.symbol,
                            entryPrediction: Number(analyzerSignal.hotDigit),
                            lockedDigit: analyzerSignal.lockedDigit,
                            hotDigit: analyzerSignal.hotDigit,
                            entrySource: 'ANALYZER_ONLY',
                            exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                            holdUntilAnalyzerExit: true,
                            executionArmed: true,
                            executionTrigger: 'ANALYZER_ENTRY',
                            cycleFinished: false,
                        },
                    });
                    globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                    // IMPORTANT: Analyzer entry is a DIRECT BUY. The Builder's
                    // proposal/payout watcher must never be able to stall an
                    // Analyzer-controlled entry. Analyzer already supplies the
                    // exact symbol, DIGITMATCH type and hotDigit.
                    this.is_proposal_subscription_required = false;

                    void this.purchase('DIGITMATCH').catch(error => {
                        globalObserver.emit(
                            'ui.log.error',
                            error?.message || 'Analyzer entry purchase failed.'
                        );
                    });
                    return undefined;
                })
                .catch(error => {
                    globalObserver.emit('ui.log.error', error?.message || 'TrapKid analyzer failed to prepare a prediction.');
                    this.store.dispatch({ type: constants.STOP });
                });
            return;
        }

    }

    observe() {
        // No Deriv observers in Analyzer-only mode. The Analyzer is the
        // execution/settlement authority for the complete trade lifecycle.
    }

}
