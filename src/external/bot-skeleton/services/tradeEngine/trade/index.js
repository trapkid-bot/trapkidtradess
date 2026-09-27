import { applyMiddleware, createStore } from 'redux';
import { thunk } from 'redux-thunk';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
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
        this.analyzerExecutionStarted = false;
        this.pendingAnalyzerCommand = null;
        this.analyzerExitObserver = this.onAnalyzerEarlyExit;
        this.analyzerCommandObserver = this.onAnalyzerCommand;
        this.analyzerStateExitObserver = state => {
            // Some Analyzer bridge versions publish EARLY_SELL_READY as state
            // before (or instead of) emitting trapkid.analyzer.exit. Treat the
            // exact Analyzer state as an equivalent exit trigger. The signalId,
            // lockedAt and hot digit are still validated by onAnalyzerEarlyExit.
            if (state?.exit?.status !== 'EARLY_SELL_READY') return;
            const stateSignal = state?.signal;
            const engineSignal = this.analyzerSignal;
            const signal =
                stateSignal?.signalId
                    ? stateSignal
                    : engineSignal?.signalId
                      ? engineSignal
                      : null;
            if (!signal?.signalId || !Number.isFinite(Number(signal.lockedAt))) return;
            const commandKey = String(signal.signalId) + ':' + String(signal.lockedAt);
            // Analyzer command keys can carry the command-generation timestamp,
            // which is not always identical to the signal's lockedAt timestamp.
            // The signalId is the authoritative trade identity here; normalize
            // the state to the canonical signalId:lockedAt key before executing.
            const stateCommandKey = String(state.commandKey || '');
            const commandBelongsToSignal =
                stateCommandKey === commandKey ||
                (stateCommandKey.startsWith(String(signal.signalId) + ':') &&
                    stateCommandKey.split(':')[0] === String(signal.signalId));
            if (!commandBelongsToSignal) return;
            const stateExitSignalId = String(state.exit.signalId || '');
            if (stateExitSignalId && stateExitSignalId !== String(signal.signalId)) return;
            if (Number(state.exit.digit) !== Number(signal.hotDigit)) return;
            if (this.isSold || this.analyzerDerivSellPromise) return;
            // If the exit arrives while the real Deriv BUY is still in flight,
            // let the normal handler persist it as pendingEarlyExit. It will be
            // consumed immediately after the same Deriv contract is confirmed.
            void this.onAnalyzerEarlyExit({
                source: 'TRAPKID_ANALYZER_STATE',
                command: 'ANALYZER_EARLY_EXIT',
                commandKey,
                signalId: String(signal.signalId),
                signal,
                exit: state.exit,
                receivedAt: Date.now(),
            });
        };
        globalObserver.register('trapkid.analyzer.exit', this.analyzerExitObserver);
        globalObserver.register('trapkid.analyzer.command', this.analyzerCommandObserver);
        globalObserver.register('trapkid.analyzer.updated', this.analyzerStateExitObserver);
        this.store = createStore(rootReducer, applyMiddleware(thunk));
        // Keep Analyze running while the Analyzer-owned local contract is open.
        // The cycle resolves only after Analyzer emits EARLY_SELL_READY and the
        // local Analyzer settlement completes.
        this.analyzerCyclePromise = Promise.resolve();
        this.resolveAnalyzerCycle = null;
    }

    onAnalyzerCommand = async command => {
        // STRICT ENTRY BOUNDARY: a visible/locked signal is informational only.
        // A real Deriv BUY may happen only after an explicit Analyzer READY command.
        if (String(command?.command || '') !== 'EXECUTE_ANALYZER_SIGNAL') return;

        const state = globalObserver.getState('trapkid_analyzer') || {};
        const signal = command?.signal?.signalId
            ? command.signal
            : state?.signal?.signalId
              ? state.signal
              : null;
        const signalId = String(command?.signalId || signal?.signalId || '');
        const lockedAt = Number(signal?.lockedAt);
        const commandKey = signalId && Number.isFinite(lockedAt)
            ? signalId + ':' + String(lockedAt)
            : String(command?.commandKey || '');

        // The command itself is the authorization. Analyzer creates the
        // command when the user performs Analyze; no second READY action exists.
        if (
            command?.entryReady !== true &&
            String(command?.status || '').toUpperCase() !== 'READY' &&
            !command?.commandKey
        ) {
            globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER ENTRY BLOCKED → malformed execution command.');
            return;
        }

        if (!signal?.signalId || !signal?.symbol || !Number.isFinite(lockedAt)) {
            globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER ENTRY BLOCKED → missing exact signal identity.');
            return;
        }

        const hotDigit = Number(signal.hotDigit);
        if (!Number.isInteger(hotDigit) || hotDigit < 0 || hotDigit > 9) {
            globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER ENTRY BLOCKED → invalid Analyzer hot digit.');
            return;
        }

        const expiresAt = Number(signal.expiresAt);
        if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
            globalObserver.emit('ui.log', 'TRAPKID ANALYZER ENTRY BLOCKED → READY command is expired.');
            return;
        }

        const activeKey = String(signal.signalId) + ':' + String(signal.lockedAt);
        if (String(commandKey || activeKey) !== activeKey) return;

        // The Analyzer command is itself the execution trigger.
        // Do not queue it behind the old DBot Run gate.
        this.analyzerExecutionStarted = true;
        if (!this.analyzerCyclePromise || this.analyzerCyclePromise === Promise.resolve()) {
            this.analyzerCyclePromise = new Promise(resolve => {
                this.resolveAnalyzerCycle = resolve;
            });
        }

        const currentState = globalObserver.getState('trapkid_analyzer') || {};
        if (currentState.purchaseConsumedKey === activeKey || currentState.purchaseInFlightKey === activeKey || this.contractId) return;

        this.analyzerSignal = {
            ...signal,
            signalId: String(signal.signalId),
            lockedAt,
            hotDigit,
            prediction: hotDigit,
        };
        this.analyzerCommandKey = activeKey;

        try {
            await this.prepareAnalyzerPrediction();
            globalObserver.setState({
                trapkid_analyzer: {
                    ...(globalObserver.getState('trapkid_analyzer') || {}),
                    status: 'ANALYZER_PURCHASE_AUTHORIZED',
                    analyzerStatus: 'READY',
                    entryReady: true,
                    signal: this.analyzerSignal,
                    signalId: this.analyzerSignal.signalId,
                    commandKey: activeKey,
                    symbol: this.analyzerSignal.symbol,
                    entryPrediction: hotDigit,
                    lockedDigit: this.analyzerSignal.lockedDigit,
                    hotDigit,
                    entrySource: 'ANALYZER_ONLY',
                    exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                    holdUntilAnalyzerExit: true,
                    executionArmed: true,
                    executionTrigger: 'ANALYZER_ENTRY_COMMAND',
                    cycleFinished: false,
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            this.tradeOptions = {
                ...this.tradeOptions,
                contractTypes: ['DIGITMATCH'],
                symbol: this.analyzerSignal.symbol,
                prediction: hotDigit,
                duration: 1,
                duration_unit: 't',
            };
            this.is_proposal_subscription_required = false;
            globalObserver.emit('ui.log', 'TRAPKID ANALYZER COMMAND → BUY AUTHORIZED → ' + activeKey + ' → digit=' + hotDigit);
            await this.purchase('DIGITMATCH');

            // Keep Analyze active until the matching Analyzer EARLY_SELL_READY
            // event has sold and financially confirmed the SAME Deriv contract.
            return this.analyzerCyclePromise;
        } catch (error) {
            globalObserver.emit('ui.log.error', error?.message || 'Analyzer command purchase failed.');
        }
    };
    onAnalyzerEarlyExit = async command => {
        // Analyzer owns the full lifecycle:
        // 1) a locked signal authorizes the BUY immediately;
        // 2) the purchased contract stays open;
        // 3) EARLY_SELL_READY is the ONLY event allowed to SELL it.
        // Never turn EARLY_SELL_READY into another BUY.
        const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
        // Analyzer exit is authoritative by signal identity, not by whichever
        // transient UI status happens to be rendered. This is important when
        // EARLY_SELL_READY arrives immediately after Analyze and before the
        // purchase lifecycle has finished changing the status to WATCHING.
        const commandSignal = command?.signal && command?.signal?.signalId
            ? command.signal
            : null;
        // Prefer the exact signal carried by the EARLY_SELL command when it
        // identifies the currently active Analyzer signal. This prevents an
        // older in-memory analyzerSignal from stealing a newer signal's exit.
        const stateSignal = analyzerState?.signal;
        const commandSignalId = String(command?.signalId || commandSignal?.signalId || '');
        const signal =
            commandSignal?.signalId && String(commandSignal.signalId) === commandSignalId
                ? commandSignal
                : stateSignal?.signalId && String(stateSignal.signalId) === commandSignalId
                  ? stateSignal
                  : this.analyzerSignal || stateSignal;
        const analyzerSignalKey = signal?.signalId && Number.isFinite(Number(signal?.lockedAt))
            ? String(signal.signalId) + ':' + String(signal.lockedAt)
            : '';
        const boundSignalKey =
            signal?.signalId && Number.isFinite(Number(signal?.lockedAt))
                ? String(signal.signalId) + ':' + String(signal.lockedAt)
                : '';
        // Once the exact Analyzer signal is bound, the matching
        // EARLY_SELL_READY command is authoritative. Do not require transient
        // execution flags such as executionArmed/purchaseInFlightKey here.
        // Those flags can legitimately change during a UI/state refresh while
        // the real Deriv contract is still open.
        if (!boundSignalKey) return;
        const commandKeyFromEvent = String(command?.commandKey || command?.key || '');
        const activeSignalId = String(signal?.signalId || '');
        const activeSignalKey = activeSignalId + ':' + String(signal?.lockedAt || '');

        // Some Analyzer bridge versions send the command key rather than
        // duplicating signalId in the event payload. Both forms identify the
        // exact locked trade; neither should be allowed to block the exit.
        const eventIdentifiesSignal =
            (commandSignalId && commandSignalId === activeSignalId) ||
            (commandKeyFromEvent && (
                commandKeyFromEvent === activeSignalKey ||
                commandKeyFromEvent.startsWith(activeSignalId + ':')
            ));

        if (!signal || !eventIdentifiesSignal) return;

        const boundCommandKey = String(analyzerState.commandKey || '');
        const commandKeyBelongsToSignal =
            boundCommandKey === activeSignalKey ||
            (boundCommandKey.startsWith(activeSignalId + ':') &&
                boundCommandKey.split(':')[0] === activeSignalId);
        const signalIsBoundToThisTrade = commandKeyBelongsToSignal;

        // Normalize Analyzer command metadata before the real SELL. Some
        // Analyzer builds use the command emission timestamp after the signal
        // was locked; that must not prevent the same signal from closing its
        // already-open Deriv contract.
        if (commandKeyBelongsToSignal && boundCommandKey !== activeSignalKey) {
            globalObserver.setState({
                trapkid_analyzer: {
                    ...analyzerState,
                    commandKey: activeSignalKey,
                },
            });
        }

        const lockExpiry = Number(signal?.expiresAt);
        // Once this exact Analyzer signal is bound to the running trade,
        // expiry is no longer allowed to cancel the pending/active lifecycle.
        if (!signalIsBoundToThisTrade && Number.isFinite(lockExpiry) && Date.now() >= lockExpiry) return;

        // Use the EXIT command/state payload itself first. Do not let a
        // stale local getAnalyzerExit() snapshot override a fresh
        // EARLY_SELL_READY command from the Analyzer.
        const bridgeExit = command?.exit || analyzerState?.exit;
        const exit =
            bridgeExit?.status === 'EARLY_SELL_READY'
                ? {
                    signalId: String(bridgeExit.signalId || commandSignalId || activeSignalId),
                    digit: Number(bridgeExit.digit ?? signal.hotDigit),
                    hotDigit: Number(signal.hotDigit),
                    quote: Number(bridgeExit.quote),
                    epoch: Number(bridgeExit.epoch),
                    status: 'EARLY_SELL_READY',
                    exitCode: bridgeExit.exitCode || null,
                }
                : (this.getAnalyzerExit?.() || null);
        if (
            !exit ||
            String(exit.signalId || activeSignalId) !== activeSignalId ||
            !Number.isInteger(Number(exit.digit)) ||
            Number(exit.digit) < 0 ||
            Number(exit.digit) > 9 ||
            Number(exit.digit) !== Number(signal.hotDigit)
        ) {
            globalObserver.emit(
                'ui.log.error',
                'TRAPKID ANALYZER COMMAND → EARLY_SELL_READY REJECTED: signal/digit mismatch'
            );
            return;
        }

        const commandKey = String(signal.signalId) + ':' + String(signal.lockedAt);

        // IMPORTANT: once the event has identified the exact signal and the
        // exit digit matches Analyzer hotDigit, do not add another command-key
        // gate here. Analyzer command timestamps/bridge state can be refreshed
        // between the EXIT event and this handler. The signalId is the trade
        // identity; the Deriv contract_id is the financial execution handle.

        // EARLY_SELL_READY is an EXIT-only event. If the BUY is still in
        // flight, remember the exact exit instead of dropping the event.
        // The pending exit is consumed immediately after contractId exists.
        if (this.isSold) return;

        // The REAL Deriv contract_id is the financial execution handle.
        // Recover it from shared Analyzer state/data if this engine instance
        // lost its in-memory field during a UI/render lifecycle transition.
        const stateDerivContractId = String(
            analyzerState?.derivContractId ||
            analyzerState?.deriv_contract_id ||
            this.data?.contract?.deriv_contract_id ||
            ''
        );
        if (!this.derivContractId && stateDerivContractId) {
            this.derivContractId = stateDerivContractId;
        }
        if (!this.contractId) {
            const stateLocalContractId = String(
                analyzerState?.analyzerContractId ||
                this.data?.contract?.contract_id ||
                ''
            );
            if (stateLocalContractId) this.contractId = stateLocalContractId;
        }

        // If the BUY has genuinely not produced a Deriv contract yet, preserve
        // this exact exit and consume it immediately when the BUY completes.
        if (!this.derivContractId) {
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
        // IMPORTANT: do not gate the exit on purchaseConsumedKey,
        // analyzerPurchaseKey, or analyzerCommandKey. Those are local lifecycle
        // bookkeeping values and can lag the real Analyzer command. Once the
        // exact signalId + EARLY_SELL_READY + matching hot digit have been
        // validated above, the existing Deriv contract is authorized to SELL.
        //
        // The command path below is deliberately unconditional with respect to
        // those local flags. This is the command-following boundary:
        // Analyzer READY -> same derivContractId -> real Deriv SELL.
        
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
                exit,
                executionTrigger: 'EARLY_SELL_READY',
                holdUntilAnalyzerExit: false,
                executionArmed: true,
                cycleFinished: false,
            },
        });
        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

        if ((this.contractId || this.derivContractId) && !this.isSold) {
            void this.sellAtMarket('ANALYZER_EARLY_SELL')
                .then(sold => {
                    // Do not release the Analyzer cycle unless the SAME Deriv
                    // contract was actually sold and settlement was confirmed.
                    if (sold && this.resolveAnalyzerCycle) {
                        const resolve = this.resolveAnalyzerCycle;
                        this.resolveAnalyzerCycle = null;
                        resolve();
                        return;
                    }
                    if (!sold) {
                        globalObserver.emit(
                            'ui.log.error',
                            'TRAPKID ANALYZER → early-sell command received, but Deriv did not confirm the same contract as sold; cycle remains locked to this contract.'
                        );
                    }
                })
                .catch(error => {
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

    watch(scopeName) {
        // Analyzer-only replacement for the removed Deriv Redux/tick scope watcher.
        // The Blockly interpreter expects watch('before') to resolve when the
        // Analyzer-owned local contract is opened, then watch('during') to resolve
        // only after Analyzer-owned settlement.
        if (scopeName === 'before') {
            if (this.contractId && !this.isSold) return Promise.resolve(true);

            return new Promise(resolve => {
                let finished = false;
                const cleanup = () => {
                    globalObserver.unregister('contract.status', onStatus);
                    globalObserver.unregister('trapkid.analyzer.updated', onAnalyzerUpdate);
                    globalObserver.unregister('bot.stop', onStop);
                };
                const finish = value => {
                    if (finished) return;
                    finished = true;
                    cleanup();
                    resolve(value);
                };
                const onStatus = event => {
                    if (event?.id === 'contract.purchase_sent' && this.contractId && !this.isSold) {
                        finish(true);
                    }
                };
                const onAnalyzerUpdate = state => {
                    if (
                        state?.status === 'WATCHING_ANALYZER_HOT_DIGIT' &&
                        this.contractId &&
                        !this.isSold
                    ) {
                        finish(true);
                    }
                };
                const onStop = () => finish(false);

                globalObserver.register('contract.status', onStatus);
                globalObserver.register('trapkid.analyzer.updated', onAnalyzerUpdate);
                globalObserver.register('bot.stop', onStop);

                // Re-check after registration to cover a synchronous Analyzer
                // purchase that completed between the initial check and listener setup.
                if (this.contractId && !this.isSold) finish(true);
            });
        }

        if (scopeName === 'during') {
            if (!this.contractId || this.isSold) return Promise.resolve(false);

            return new Promise(resolve => {
                let finished = false;
                const cleanup = () => {
                    globalObserver.unregister('contract.status', onStatus);
                    globalObserver.unregister('trapkid.analyzer.updated', onAnalyzerUpdate);
                    globalObserver.unregister('bot.stop', onStop);
                };
                const finish = value => {
                    if (finished) return;
                    finished = true;
                    cleanup();
                    resolve(value);
                };
                const onStatus = event => {
                    if (event?.id === 'contract.sold') finish(false);
                };
                const onAnalyzerUpdate = state => {
                    if (state?.status === 'ANALYZER_SETTLED' || state?.executionTrigger === 'ANALYZER_SETTLED') {
                        finish(false);
                    }
                };
                const onStop = () => finish(false);

                globalObserver.register('contract.status', onStatus);
                globalObserver.register('trapkid.analyzer.updated', onAnalyzerUpdate);

                globalObserver.register('bot.stop', onStop);

                // Re-check after registration in case Analyzer settlement happened
                // at the exact boundary between the initial state check and listener setup.
                if (!this.contractId || this.isSold) finish(false);
            });
        }

        return Promise.resolve(false);
    }

    async start(tradeOptions) {
        if (!this.options) {
            throw createError('NotInitialized', getLocalizedErrorMessage('NotInitialized'));
        }

        globalObserver.emit('bot.running');
        const validated_trade_options = this.validateTradeOptions(tradeOptions);
        this.tradeOptions = { ...validated_trade_options };

        // Analyzer lifecycle: Analyze is the explicit entry command.
        // The currently locked Analyzer signal becomes the ONLY trade decision.
        this.analyzerCyclePromise = new Promise(resolve => {
            this.resolveAnalyzerCycle = resolve;
        });
        this.store.dispatch(start());
        this.checkLimits(validated_trade_options);
        this.analyzerExecutionStarted = true;

        const analyzerState = globalObserver.getState('trapkid_analyzer') || {};

        // IMPORTANT: start() NEVER purchases an Analyzer contract.
        // It only arms the bot and waits for the explicit Analyzer execution
        // command. EXECUTE_ANALYZER_SIGNAL is the sole BUY trigger.
        this.analyzerExecutionStarted = true;

        globalObserver.setState({
            trapkid_analyzer: {
                ...analyzerState,
                status: 'WAITING_FOR_ANALYZER_COMMAND',
                analyzerStatus: 'ANALYZE_CLICK',
                entryReady: false,
                executionArmed: false,
                executionTrigger: 'WAITING_FOR_ANALYZER_COMMAND',
                holdUntilAnalyzerExit: true,
                cycleFinished: false,
            },
        });
        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
        globalObserver.emit(
            'ui.log',
            'TRAPKID ANALYZER → BOT ARMED. BUY IS BLOCKED UNTIL EXECUTE_ANALYZER_SIGNAL COMMAND.'
        );

        // The command handler is the only place that authorizes and starts
        // the Analyzer DIGITMATCH purchase. Keep this lifecycle promise open
        // until the matching Analyzer EARLY_SELL_READY closes the same contract.
        return this.analyzerCyclePromise;

    // Compatibility method required by the Blockly interpreter. The old
    // Ticks mixin exposed this method, but Analyzer-only execution deliberately
    // does not create a Deriv ticksService or tick-history promise.
    checkTicksPromiseExists() {
        // Render redeploy marker: keep Analyzer-only interpreter compatibility in the tracked main branch.
        return null;
    }

    // Blockly's legacy tick blocks call getLastTick(). In Analyzer-only mode
    // there is no Deriv ticksService, so resolve the latest Analyzer-provided
    // quote instead of falling back to Deriv.
    getLastTick(raw = false, toString = false) {
        const state = globalObserver.getState('trapkid_analyzer') || {};
        const signal = this.analyzerSignal || state.signal || {};
        const exit = state.exit || {};

        const tick =
            state.lastTick ??
            state.currentTick ??
            state.tick ??
            state.latestTick ??
            null;

        let quote =
            typeof tick === 'object' ? Number(tick.quote ?? tick.price ?? tick.value) : Number(tick);

        if (!Number.isFinite(quote)) {
            quote = Number(exit.quote);
        }
        if (!Number.isFinite(quote)) {
            quote = Number(signal.lockedQuote ?? signal.entryQuote ?? state.lockedQuote ?? state.entryQuote);
        }

        if (!Number.isFinite(quote)) return Promise.resolve(null);

        if (raw) {
            const rawTick =
                typeof tick === 'object' && tick
                    ? tick
                    : {
                        quote,
                        epoch: Number(state.serverTime ?? state.epoch ?? signal.lockedAt ?? Date.now()),
                    };
            return Promise.resolve(rawTick);
        }

        const pipSize = Number(signal.pipSize ?? state.pipSize ?? 0.01);
        const value = toString && Number.isFinite(pipSize) && pipSize > 0
            ? quote.toFixed(Math.max(0, String(pipSize).split('.')[1]?.length || 0))
            : quote;

        return Promise.resolve(value);
    }

    dispose() {
        if (
            this.analyzerExitObserver &&
            globalObserver.isRegistered('trapkid.analyzer.exit')
        ) {
            globalObserver.unregister('trapkid.analyzer.exit', this.analyzerExitObserver);
        }
        if (
            this.analyzerCommandObserver &&
            globalObserver.isRegistered('trapkid.analyzer.command')
        ) {
            globalObserver.unregister('trapkid.analyzer.command', this.analyzerCommandObserver);
        }
        if (
            this.analyzerStateExitObserver &&
            globalObserver.isRegistered('trapkid.analyzer.updated')
        ) {
            globalObserver.unregister('trapkid.analyzer.updated', this.analyzerStateExitObserver);
        }
        this.analyzerExitObserver = null;
        this.analyzerStateExitObserver = null;
        this.disposeTotalObserver?.();
    }

    observe() {
        // No Deriv observers in Analyzer-only mode. The Analyzer is the
        // execution/settlement authority for the complete trade lifecycle.
    }

}
