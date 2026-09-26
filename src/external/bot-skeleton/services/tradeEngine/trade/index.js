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
        if (!(this.isAnalyzerEnabledForTrade?.() || this.analyzerSignal) || !this.contractId || this.isSold) return;

        const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
        const signal = this.analyzerSignal || analyzerState.signal;
        const commandSignalId = String(command?.signalId || command?.signal?.signalId || '');
        const activeSignalId = String(signal?.signalId || '');

        if (!signal || !commandSignalId || commandSignalId !== activeSignalId) return;

        const exit = this.getAnalyzerExit?.();
        if (
            !exit ||
            String(exit.signalId) !== activeSignalId ||
            !Number.isInteger(Number(exit.digit)) ||
            Number(exit.digit) < 0 ||
            Number(exit.digit) > 9
        ) {
            return;
        }

        // EARLY_SELL_READY is an instruction to START watching for the
        // Analyzer-provided exit digit. It is NOT itself the sell trigger.
        // The exit digit may be different from the entry hot digit.
        // Every other digit is deliberately ignored.
        const previousSubscription = this.analyzerExitTickSubscription;
        if (previousSubscription) {
            previousSubscription.unsubscribe?.();
            this.analyzerExitTickSubscription = null;
        }

        globalObserver.setState({
            trapkid_analyzer: {
                ...analyzerState,
                status: 'WAITING_FOR_ANALYZER_EXIT_DIGIT',
                cycleFinished: false,
                purchaseConsumedKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                exitDigit: exit.digit,
                hotDigit: exit.hotDigit,
                commandKey: exit.commandKey,
                exitSource: 'ANALYZER_EARLY_SELL_ONLY',
            },
        });
        globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

        const symbol = String(signal.symbol || analyzerState.symbol || '');
        const exitDigit = Number(exit.digit);
        const pipSize = Number(signal.pipSize ?? signal.pip_size ?? 0.01);
        const decimalPlaces = Number.isFinite(pipSize) && pipSize > 0
            ? Math.max(0, (String(pipSize).split('.')[1] || '').length)
            : 2;

        const getDigitFromTick = tick => {
            const quote = tick?.quote;
            if (quote === undefined || quote === null) return null;
            const formatted = Number(quote).toFixed(decimalPlaces);
            return Number(formatted[formatted.length - 1]);
        };

        const onTick = message => {
            const tick = message?.data?.tick;
            if (!tick || (symbol && String(tick.symbol || '') !== symbol)) return;

            const currentDigit = getDigitFromTick(tick);

            // Ignore every digit except the Analyzer-authorized exit digit.
            if (currentDigit !== exitDigit) return;

            this.analyzerExitTickSubscription?.unsubscribe?.();
            this.analyzerExitTickSubscription = null;

            globalObserver.setState({
                trapkid_analyzer: {
                    ...(globalObserver.getState('trapkid_analyzer') || {}),
                    status: 'EARLY_EXIT_EXECUTING',
                    cycleFinished: true,
                    matchedExitDigit: currentDigit,
                    exitDigit,
                    hotDigit: signal.hotDigit,
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            void this.sellAtMarket('ANALYZER_EARLY_EXIT').then(() => {
                this.store.dispatch({ type: constants.STOP });
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'WAITING_FOR_ANALYZER',
                        cycleFinished: true,
                        matchedExitDigit: exitDigit,
                    },
                });
                globalObserver.emit(
                    'trapkid.analyzer.updated',
                    globalObserver.getState('trapkid_analyzer')
                );
            });
        };

        this.analyzerExitTickSubscription = api_base.api.onMessage().subscribe(onTick);
        api_base.pushSubscription(this.analyzerExitTickSubscription);
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
            ['COMMAND_RECEIVED', 'COMMAND_ACCEPTED', 'ANALYZER_DATA_BOUND', 'ANALYZER_TRADE_LOCKED'].includes(
                String(analyzerState.status || '')
            );

        if (analyzerCommandActive || this.isAnalyzerEnabledForTrade(this.tradeOptions)) {
            this.prepareAnalyzerPrediction()
                .then(() => {
                    const analyzerSignal = this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal;
                    if (!analyzerSignal?.signalId) {
                        throw new Error('TrapKid Analyzer: no authorized signal for purchase.');
                    }

                    // Analyzer owns the entire contract lifecycle. Ignore the
                    // Builder's duration so a 1-tick strategy cannot settle
                    // before the Analyzer issues EARLY_SELL_READY.
                    this.tradeOptions = {
                        ...this.tradeOptions,
                        contractTypes: ['DIGITMATCH'],
                        symbol: analyzerSignal.symbol,
                        prediction: Number(analyzerSignal.prediction),
                        // Long safety expiry. Analyzer EARLY_SELL_READY
                        // remains the intended and only close path.
                        duration: 60,
                        duration_unit: 's',
                    };

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...(globalObserver.getState('trapkid_analyzer') || {}),
                            status: 'ANALYZER_EXECUTION',
                            signal: analyzerSignal,
                            signalId: analyzerSignal.signalId,
                            commandKey: String(analyzerSignal.signalId) + ':' + String(analyzerSignal.lockedAt),
                            symbol: analyzerSignal.symbol,
                            entryPrediction: Number(analyzerSignal.prediction),
                            lockedDigit: analyzerSignal.lockedDigit,
                            hotDigit: analyzerSignal.hotDigit,
                            entrySource: 'ANALYZER_ONLY',
                            exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                            holdUntilAnalyzerExit: true,
                        },
                    });
                    globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                    return this.makeDirectPurchaseDecision();
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
