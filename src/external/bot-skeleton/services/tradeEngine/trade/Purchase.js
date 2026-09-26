import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';
import { observer as globalObserver } from '../../../utils/observer';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerMode =
                this.isAnalyzerEnabledForTrade?.() ||
                !!this.analyzerSignal ||
                ['ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND', 'WAITING_FOR_ANALYZER_EXIT', 'EARLY_EXIT_COMMAND_RECEIVED', 'ANALYZER_EXECUTION', 'RUNNING'].includes(
                    String(analyzerState.status || '')
                );

            if (analyzerMode) {
                const analyzerStateGate = globalObserver.getState('trapkid_analyzer') || {};
                // Analyzer entry is authorized by the execution trigger, not
                // by a transient UI/status label. The Analyzer bridge may move
                // the status to WAITING_FOR_ANALYZER_EXIT while the proposal is
                // still arriving; that must never cancel the already-authorized BUY.
                if (
                    analyzerStateGate.executionArmed !== true ||
                    !['ANALYZER_ENTRY', 'EARLY_SELL_READY'].includes(String(analyzerStateGate.executionTrigger || ''))
                ) {
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
                        executionTrigger: 'ANALYZER_ENTRY',
                    },
                });

                // Analyzer is the sole source of the actual Match entry values.
                // Any Bot Builder prediction value is overwritten here.
                // Hot digit is the sole canonical Analyzer prediction.
                this.tradeOptions.prediction = signal.hotDigit;
                this.tradeOptions.symbol = signal.symbol;

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
            // Analyzer execution owns this purchase lifecycle. If the legacy
            // Builder watcher has already moved the Redux scope away from
            // BEFORE_PURCHASE, restore the purchase scope instead of silently
            // dropping the Analyzer-triggered buy.
            if (analyzerMode) {
                const scope = this.store.getState().scope;
                if (scope !== BEFORE_PURCHASE) {
                    this.store.dispatch({ type: 'SELL' });
                    this.store.dispatch({ type: 'START' });
                }
            } else if (this.store.getState().scope !== BEFORE_PURCHASE) {
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

                if (this.analyzerSignal) {
                    this.analyzerPurchaseKey =
                        String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt);
                }

                const purchasedSignalKey = this.analyzerSignal
                    ? String(this.analyzerSignal.signalId) + ':' + String(this.analyzerSignal.lockedAt)
                    : '';

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'RUNNING',
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
                globalObserver.emit('ui.log', {
                    message: `TRAPKID ANALYZER BUY → ${tradeOptionToBuy ? JSON.stringify(trade_option) : 'DIGITMATCH'}`,
                });
            }

            const action = () => {
                if (analyzerMode) {
                    globalObserver.emit('ui.log', {
                        message: 'TRAPKID ANALYZER BUY REQUEST SENT',
                    });
                }
                return api_base.api.send(trade_option);
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
