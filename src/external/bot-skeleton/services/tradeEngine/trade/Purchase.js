import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contract, contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';
import { observer as globalObserver } from '../../../utils/observer';

let delayIndex = 0;
let purchase_reference;

// Analyzer logical duration remains 1 tick, but the real Deriv position
// must stay sellable until EARLY_SELL_READY. Deriv has no separate
// "display duration" field, so use a long physical expiry as the safety ceiling.
// DIGITMATCH is a short-duration contract. Use the longest common
// broker-supported digit duration as the physical ceiling, while the
// Analyzer still owns the actual exit lifecycle.
const ANALYZER_PHYSICAL_HOLD_TICKS = 10;
const ANALYZER_LOGICAL_DURATION = 1;
const ANALYZER_LOGICAL_DURATION_UNIT = 't';

export default Engine =>
    class Purchase extends Engine {
        async purchase(contract_type) {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerMode =
                this.isAnalyzerEnabledForTrade?.() ||
                !!this.analyzerSignal ||
                ['ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND', 'WAITING_FOR_ANALYZER_EXIT', 'EARLY_EXIT_COMMAND_RECEIVED', 'ANALYZER_EXECUTION', 'RUNNING'].includes(
                    String(analyzerState.status || '')
                );

            if (analyzerMode) {
                const analyzerStateGate = globalObserver.getState('trapkid_analyzer') || {};
                // STRICT COMMAND GATE:
                // A LOCKED/visible Analyzer signal, RUN button, status refresh,
                // or local execution flag is never enough to authorize a BUY.
                // The only valid entry trigger is an explicit READY Analyzer command.
                const entryCommandAuthorized =
                    analyzerStateGate.executionArmed === true &&
                    analyzerStateGate.entryReady === true &&
                    ['ANALYZER_ENTRY', 'ANALYZER_ENTRY_COMMAND'].includes(
                        String(analyzerStateGate.executionTrigger || '')
                    );

                if (!entryCommandAuthorized) {
                    globalObserver.emit(
                        'ui.log',
                        'TRAPKID ANALYZER BUY BLOCKED → Analyze entry command is not armed.'
                    );
                    return Promise.resolve();
                }

                // Analyzer owns the contract type for this execution cycle.
                contract_type = 'DIGITMATCH';
                const signal = this.getExternalAnalyzerSignal?.();
                const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
                const bridgeSignal = analyzerState?.signal;
                const bridgeSignalKey = bridgeSignal?.signalId
                    ? String(bridgeSignal.signalId) + ':' + String(bridgeSignal.lockedAt)
                    : '';
                const authorizedBridgeSignal =
                    signal &&
                    bridgeSignalKey &&
                    String(analyzerState.commandKey || '') === bridgeSignalKey
                        ? signal
                        : null;

                // The shared Analyzer bridge is authoritative. The local
                // engine field is optional because the purchase phase may run
                // on a later engine callback.
                const activeSignal = this.analyzerSignal || authorizedBridgeSignal;

                if (
                    !signal ||
                    !activeSignal ||
                    String(signal.signalId) !== String(activeSignal.signalId) ||
                    Number(signal.lockedAt) !== Number(activeSignal.lockedAt) ||
                    !Number.isInteger(signal.prediction) ||
                    !Number.isInteger(signal.hotDigit) ||
                    Number(signal.prediction) !== Number(signal.hotDigit)
                ) {
                    globalObserver?.emit?.(
                        'ui.log.error',
                        'Analyzer signal is missing or not authorized. Purchase blocked.'
                    );
                    return Promise.resolve();
                }

                this.analyzerSignal = activeSignal;
                this.analyzerCommandKey =
                    String(signal.signalId) + ':' + String(signal.lockedAt);

                const analyzerSignalKey =
                    String(signal.signalId) + ':' + String(signal.lockedAt);
                const currentAnalyzerState = globalObserver.getState('trapkid_analyzer') || {};

                // One Analyzer signal can create exactly one contract.
                // Keep this guard in shared observer state so it survives
                // engine/restart callbacks.
                if (
                    currentAnalyzerState.purchaseConsumedKey === analyzerSignalKey ||
                    currentAnalyzerState.purchaseInFlightKey === analyzerSignalKey
                ) {
                    return Promise.resolve();
                }

                // Reserve the signal before sending the purchase request so
                // concurrent/restarted purchase callbacks cannot create a
                // second contract from the same Analyzer signal.
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...currentAnalyzerState,
                        status: 'ANALYZER_EXECUTION',
                        signal,
                        signalId: signal.signalId,
                        commandKey: analyzerSignalKey,
                        purchaseInFlightKey: analyzerSignalKey,
                        entryPrediction: signal.prediction,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                        executionTrigger: 'ANALYZER_ENTRY_COMMAND',
                    },
                });

                // Analyzer is the sole source of the actual Match entry values.
                // Any Bot Builder prediction value is overwritten here.
                // Hot digit is the sole canonical Analyzer prediction.
                this.tradeOptions.prediction = signal.hotDigit;
                this.tradeOptions.symbol = signal.symbol;
                // Analyzer supplies the decision; the bot keeps its normal
                // Deriv purchase pipeline. Execution is fixed to 1 tick.
                this.tradeOptions.duration = 1;
                this.tradeOptions.duration_unit = 't';

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'ANALYZER_EXECUTION',
                        symbol: signal.symbol,
                        signal,
                        signalId: signal.signalId,
                        commandKey: String(signal.signalId) + ':' + String(signal.lockedAt),
                        prediction: signal.prediction,
                        lockedDigit: signal.lockedDigit,
                        hotDigit: signal.hotDigit,
                        entryPrediction: signal.prediction,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            }
            // Analyzer direct BUY does not depend on the Builder Redux purchase
            // scope. Never dispatch SELL/START here: those legacy state transitions
            // can interfere with the Analyzer-owned execution lifecycle.
            if (!analyzerMode && this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }


            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.derivContractId = String(buy.contract_id);
                this.derivBuy = buy;
                this.derivBuyTransactionId = buy.transaction_id ?? null;
                this.isSold = false;
                this.isExpired = false;
                this.isSellAvailable = true;

                // Keep the normal DBot contract model as the single source for
                // the purchased position. Analyzer only supplied the values used
                // to construct this contract.
                this.data.contract = {
                    ...(this.data.contract || {}),
                    id: String(buy.contract_id),
                    contract_id: String(buy.contract_id),
                    deriv_contract_id: String(buy.contract_id),
                    transaction_ids: {
                        buy: buy.transaction_id ?? null,
                        sell: null,
                    },
                    contract_type: 'DIGITMATCH',
                    symbol: this.analyzerSignal?.symbol || this.tradeOptions?.symbol,
                    underlying_symbol: this.analyzerSignal?.symbol || this.tradeOptions?.symbol,
                    barrier: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    prediction: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    buy_price: Number(buy.buy_price),
                    payout: Number(buy.payout),
                    currency: buy.currency || this.tradeOptions?.currency || 'USD',
                    analyzer_source: 'ANALYZER_ONLY',
                    analyzer_signal_id: this.analyzerSignal?.signalId || null,
                    analyzer_command_key: this.analyzerCommandKey || null,
                    analyzer_hot_digit: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    analyzer_prediction: Number(this.analyzerSignal?.hotDigit ?? this.tradeOptions?.prediction),
                    // Logical DBot contract identity: keep the configured Match
                    // duration as one tick, even though the real Deriv position
                    // uses a longer sellable lifetime for the Analyzer lifecycle.
                    duration: ANALYZER_LOGICAL_DURATION,
                    duration_unit: ANALYZER_LOGICAL_DURATION_UNIT,
                    analyzer_duration: ANALYZER_LOGICAL_DURATION,

                    analyzer_duration_unit: ANALYZER_LOGICAL_DURATION_UNIT,
                    deriv_physical_duration: ANALYZER_PHYSICAL_HOLD_TICKS,
                    deriv_physical_duration_unit: 't',
                    analyzer_exit_status: 'WAITING_FOR_ANALYZER_EXIT',
                    deriv_transaction_id: buy.transaction_id ?? null,
                    deriv_buy_price: Number(buy.buy_price),
                    deriv_potential_payout: Number(buy.payout),
                    deriv_balance_after_buy: Number(buy.balance_after),
                    financial_status: 'DERIV_BUY_CONFIRMED',
                    status: 'open',
                    is_sold: false,
                    is_expired: false,
                };
                contract(this.data.contract);

                if (this.analyzerSignal) {
                    this.analyzerPurchaseKey =
                        String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt);
                }

                const purchasedSignalKey = this.analyzerSignal
                    ? String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt)
                    : '';

                globalObserver.emit('deriv.contract.buy', {
                    local_contract_id: this.analyzerSignal?.signalId || null,
                    contract_id: String(buy.contract_id),
                    transaction_id: buy.transaction_id ?? null,
                    buy_transaction_id: buy.transaction_id ?? null,
                    buy_price: Number(buy.buy_price),
                    payout: Number(buy.payout),
                    currency: buy.currency || this.tradeOptions?.currency || 'USD',
                    balance_after: Number(buy.balance_after),
                });

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'RUNNING',
                        derivContractId: String(buy.contract_id),
                        derivTransactionId: buy.transaction_id ?? null,
                        derivBuyPrice: Number.isFinite(Number(buy.buy_price)) ? Number(buy.buy_price) : null,
                        analyzerPotentialPayout: Number.isFinite(Number(buy.payout)) ? Number(buy.payout) : null,
                        payout: Number.isFinite(Number(buy.payout)) ? Number(buy.payout) : null,
                        analyzerLogicalDuration: ANALYZER_LOGICAL_DURATION,
                        analyzerLogicalDurationUnit: ANALYZER_LOGICAL_DURATION_UNIT,
                        derivPhysicalDuration: ANALYZER_PHYSICAL_HOLD_TICKS,
                        derivPhysicalDurationUnit: 't',
                        payoutSource: 'DERIV_BUY',
                        derivBalanceAfterBuy: Number.isFinite(Number(buy.balance_after)) ? Number(buy.balance_after) : null,
                        signal: this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal,
                        signalId: this.analyzerSignal?.signalId,
                        commandKey: this.analyzerCommandKey,
                        entryPrediction: this.tradeOptions.prediction,
                        lockedQuote: this.analyzerSignal?.lockedQuote,
                        entrySource: 'ANALYZER_ONLY',
                        exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                        executionTrigger: null,
                        purchaseInFlightKey: null,
                        purchaseConsumedKey: purchasedSignalKey || undefined,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                // EARLY_SELL_READY is an EXIT event, never an entry event.
                // If Analyzer emitted it while the proposal/buy was still in
                // flight, the exit handler stores it as pending. Execute that
                // already-authorized exit immediately after contractId exists.
                const postPurchaseState = globalObserver.getState('trapkid_analyzer') || {};
                const pendingExit = postPurchaseState.pendingEarlyExit;
                const pendingMatches =
                    pendingExit?.status === 'EARLY_SELL_READY' &&
                    String(pendingExit.signalId || '') === String(this.analyzerSignal?.signalId || '') &&
                    Number(pendingExit.digit) === Number(this.analyzerSignal?.hotDigit);

                this.store.dispatch(purchaseSuccessful());

                if (pendingMatches && this.contractId && !this.isSold) {
                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...(globalObserver.getState('trapkid_analyzer') || {}),
                            status: 'EARLY_EXIT_COMMAND_RECEIVED',
                            signal: this.analyzerSignal,
                            signalId: this.analyzerSignal?.signalId,
                            commandKey: purchasedSignalKey,
                            symbol: this.analyzerSignal?.symbol,
                            prediction: Number(this.analyzerSignal?.hotDigit),
                            hotDigit: Number(this.analyzerSignal?.hotDigit),
                            entrySource: 'ANALYZER_ONLY',
                            exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                            exit: { ...pendingExit, status: 'EARLY_SELL_READY' },
                            executionTrigger: 'EARLY_SELL_READY',
                            holdUntilAnalyzerExit: false,
                            executionArmed: true,
                            pendingEarlyExit: null,
                        },
                    });
                    globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
                    void this.sellAtMarket('ANALYZER_EARLY_SELL').catch(error => {
                        globalObserver.emit('ui.log.error', error?.message || 'Analyzer early sell failed.');
                    });
                }

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            // Analyzer supplies only the trade decision. Use Deriv's normal
            // proposal -> buy sequence so the financial contract is created
            // exactly through the same API mechanics as the normal bot.
            if (analyzerMode) {
                const signal = this.analyzerSignal || globalObserver.getState('trapkid_analyzer')?.signal;
                const amount = Number(this.tradeOptions?.amount);
                const symbol = String(signal?.symbol || '');
                const hotDigit = Number(signal?.hotDigit);
                const currency = this.tradeOptions?.currency || 'USD';

                if (!signal?.signalId || !symbol || !Number.isFinite(amount) || amount <= 0 ||
                    !Number.isInteger(hotDigit) || hotDigit < 0 || hotDigit > 9) {
                    throw new Error('TRAPKID ANALYZER BUY -> missing stake, market, or hot digit.');
                }

                // IMPORTANT:
                // - Logical DBot/Analyzer duration = 1 tick.
                // - Physical Deriv expiry = short tick ceiling accepted by DIGITMATCH.
                // - EARLY_SELL_READY is the only event that closes the real contract.
                // A real 1-tick Deriv contract can expire before the Analyzer exit;
                // Analyzer exit because Deriv expires it at the tick boundary.
                const logicalDuration = ANALYZER_LOGICAL_DURATION;
                const logicalDurationUnit = ANALYZER_LOGICAL_DURATION_UNIT;
                const physicalHoldDuration = ANALYZER_PHYSICAL_HOLD_TICKS;

                const proposalRequest = {
                    proposal: 1,
                    amount,
                    basis: 'stake',
                    contract_type: 'DIGITMATCH',
                    currency,
                    duration: physicalHoldDuration,
                    duration_unit: 't',
                    underlying_symbol: symbol,
                    barrier: String(hotDigit),
                };

                let proposalResponse;
                try {
                    proposalResponse = await doUntilDone(
                        () => api_base.api.send(proposalRequest),
                        ['InvalidContractProposal']
                    );
                } catch (error) {
                    const code = error?.error?.code || error?.code || error?.message || 'unknown';
                    globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER PROPOSAL ERROR -> ' + code);
                    throw error;
                }

                const proposal = proposalResponse?.proposal;
                const proposalId = proposal?.id;
                const askPrice = Number(proposal?.ask_price);
                const potentialPayout = Number(proposal?.payout);
                if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0) {
                    throw new Error('TRAPKID ANALYZER PROPOSAL -> Deriv returned no valid proposal.');
                }

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        derivProposalId: String(proposalId),
                        derivProposalAskPrice: askPrice,
                        analyzerPotentialPayout: Number.isFinite(potentialPayout) ? potentialPayout : null,
                        payout: Number.isFinite(potentialPayout) ? potentialPayout : null,
                        payoutSource: 'DERIV_PROPOSAL',
                        analyzerLogicalDuration: logicalDuration,
                        analyzerLogicalDurationUnit: logicalDurationUnit,
                        derivPhysicalDuration: physicalHoldDuration,
                        derivPhysicalDurationUnit: 't',
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

                let buyResponse;
                try {
                    buyResponse = await doUntilDone(
                        () => api_base.api.send({ buy: String(proposalId), price: askPrice }),
                        ['PriceMoved', 'InvalidContractProposal']
                    );
                } catch (error) {
                    const code = error?.error?.code || error?.code || error?.message || 'unknown';
                    globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER BUY ERROR -> ' + code);
                    throw error;
                }

                return onSuccess(buyResponse);
            }

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);

            // Analyzer mode is a real execution path, not a Builder simulation.
            // Log the exact BUY payload so the live DBot can be verified from the
            // browser journal and never silently stop before the API request.
            if (analyzerMode) {
                globalObserver.emit('ui.log', `TRAPKID ANALYZER BUY → ${JSON.stringify(trade_option)}`);
            }

            const action = () => {
                if (analyzerMode) {
                    globalObserver.emit('ui.log', 'TRAPKID ANALYZER BUY REQUEST SENT');
                }
                return api_base.api
                    .send(trade_option)
                    .then(response => {
                        if (analyzerMode) {
                            globalObserver.emit(
                                'ui.log',
                                `TRAPKID ANALYZER BUY RESPONSE → ${JSON.stringify(response)}`
                            );
                        }
                        return response;
                    })
                    .catch(error => {
                        if (analyzerMode) {
                            globalObserver.emit(
                                'ui.log.error',
                                `TRAPKID ANALYZER BUY ERROR → ${error?.error?.code || error?.code || error?.message || JSON.stringify(error)}`
                            );
                        }
                        throw error;
                    });
            };

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
