import { applyMiddleware, createStore } from 'redux';
import { thunk } from 'redux-thunk';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { checkBlocksForProposalRequest, doUntilDone } from '../utils/helpers';
import { expectInitArg } from '../utils/sanitize';
import { proposalsReady, start } from './state/actions';
import * as constants from './state/constants';
import rootReducer from './state/reducers';
import Balance from './Balance';
import OpenContract from './OpenContract';
import Proposal from './Proposal';
import Purchase from './Purchase';
import Sell from './Sell';
import Ticks from './Ticks';
import Total from './Total';
import Analyzer from './Analyzer';

const watchBefore = store =>
    watchScope({
        store,
        stopScope: constants.DURING_PURCHASE,
        passScope: constants.BEFORE_PURCHASE,
        passFlag: 'proposalsReady',
    });

const watchDuring = store =>
    watchScope({
        store,
        stopScope: constants.STOP,
        passScope: constants.DURING_PURCHASE,
        passFlag: 'openContract',
    });

/* The watchScope function is called randomly and resets the prevTick
 * which leads to the same problem we try to solve. So prevTick is isolated
 */
let prevTick;
const watchScope = ({ store, stopScope, passScope, passFlag }) => {
    // in case watch is called after stop is fired
    if (store.getState().scope === stopScope) {
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        const unsubscribe = store.subscribe(() => {
            const newState = store.getState();

            if (newState.newTick === prevTick) return;
            prevTick = newState.newTick;

            if (newState.scope === passScope && newState[passFlag]) {
                unsubscribe();
                resolve(true);
            }

            if (newState.scope === stopScope) {
                unsubscribe();
                resolve(false);
            }
        });
    });
};

export default class TradeEngine extends Balance(Purchase(Sell(OpenContract(Proposal(Analyzer(Ticks(Total(class {})))))))) {
    constructor($scope) {
        super();
        this.observer = $scope.observer;
        this.$scope = $scope;
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
        const [token, options] = expectInitArg(args);
        const { symbol } = options;

        this.initArgs = args;
        this.options = options;
        this.startPromise = this.loginAndGetBalance(token);

        if (!this.checkTicksPromiseExists()) this.watchTicks(symbol);
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
        const analyzerCommandKey =
            analyzerSignal?.signalId && Number.isFinite(Number(analyzerSignal?.lockedAt))
                ? String(analyzerSignal.signalId) + ':' + String(analyzerSignal.lockedAt)
                : '';
        const analyzerCommandActive =
            !!analyzerSignal?.signalId &&
            String(analyzerState.commandKey || '') === analyzerCommandKey &&
            ['COMMAND_RECEIVED', 'COMMAND_ACCEPTED', 'ANALYZER_EXECUTION', 'ANALYZER_DATA_BOUND', 'ANALYZER_TRADE_LOCKED'].includes(
                String(analyzerState.status || '')
            );

        if (analyzerCommandActive || this.isAnalyzerEnabledForTrade(this.tradeOptions)) {
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
                    this.store.dispatch(proposalsReady());

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

        this.makeDirectPurchaseDecision();
    }

    loginAndGetBalance(token) {
        if (this.token === token) {
            return Promise.resolve();
        }
        // for strategies using total runs, GetTotalRuns function is trying to get loginid and it gets called before Proposals calls.
        // the below required loginid to be set in Proposal calls where loginAndGetBalance gets resolved.
        // Earlier this used to happen as soon as we get ticks_history response and by the time GetTotalRuns gets called we have required info.
        this.accountInfo = api_base.account_info;
        this.token = api_base.token;
        return new Promise(resolve => {
            // Try to recover from a situation where API doesn't give us a correct response on
            // "proposal_open_contract" which would make the bot run forever. When there's a "sell"
            // event, wait a couple seconds for the API to give us the correct "proposal_open_contract"
            // response, if there's none after x seconds. Send an explicit request, which _should_
            // solve the issue. This is a backup!
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'transaction' && data.transaction.action === 'sell') {
                    this.transaction_recovery_timeout = setTimeout(() => {
                        const { contract } = this.data;
                        const is_same_contract = contract.contract_id === data.transaction.contract_id;
                        const is_open_contract = contract.status === 'open';
                        if (is_same_contract && is_open_contract) {
                            doUntilDone(() => {
                                api_base.api.send({ proposal_open_contract: 1, contract_id: contract.contract_id });
                            }, ['PriceMoved']);
                        }
                    }, 1500);
                }
                resolve();
            });
            api_base.pushSubscription(subscription);
        });
    }

    observe() {
        this.observeOpenContract();
        this.observeBalance();
        this.observeProposals();
    }

    watch(watchName) {
        if (watchName === 'before') {
            return watchBefore(this.store);
        }
        return watchDuring(this.store);
    }

    makeDirectPurchaseDecision() {
        const { has_payout_block, is_basis_payout } = checkBlocksForProposalRequest();
        this.is_proposal_subscription_required = has_payout_block || is_basis_payout;

        if (this.is_proposal_subscription_required) {
            this.makeProposals({ ...this.options, ...this.tradeOptions });
            this.checkProposalReady();
        } else {
            this.store.dispatch(proposalsReady());
        }
    }
}
