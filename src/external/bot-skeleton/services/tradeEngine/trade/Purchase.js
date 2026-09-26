import { LogTypes } from '../../../constants/messages';
import { contract, contractStatus, info, log } from '../utils/broadcast';
import { getUUID } from '../utils/helpers';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';

let purchase_reference;

export default Engine =>
    class Purchase extends Engine {

        // Financial-only Deriv bridge. Analyzer still controls the signal,
        // entry timing, hold state, and exit decision. Deriv is contacted only
        // for proposal pricing, the actual financial buy, and the actual sell.
        requestAnalyzerDeriv = (request, msgType, timeoutMs = 7000) => {
            const api = api_base?.api;
            if (!api || api.connection?.readyState !== 1) return Promise.resolve(null);

            const req_id = Number(String(Date.now()).slice(-9));
            const payload = { ...request, req_id };

            return new Promise(resolve => {
                let finished = false;
                let timeout;
                let subscription;
                const finish = response => {
                    if (finished) return;
                    finished = true;
                    if (timeout) clearTimeout(timeout);
                    try {
                        subscription?.unsubscribe?.();
                    } catch {
                        // Best-effort cleanup of this one-shot financial listener.
                    }
                    resolve(response || null);
                };

                try {
                    subscription = api.onMessage().subscribe(({ data }) => {
                        if (Number(data?.req_id) !== req_id || data?.msg_type !== msgType) return;
                        finish(data);
                    });
                    api.send(payload);
                    timeout = setTimeout(() => finish(null), timeoutMs);
                } catch {
                    finish(null);
                }
            });
        };

        updateDerivAccountBalance = balance => {
            const numericBalance = Number(balance);
            if (!Number.isFinite(numericBalance)) return;

            api_base.account_info = {
                ...(api_base.account_info || {}),
                balance: numericBalance,
            };

            const clientStore = globalObserver.getState('client.store');
            if (!clientStore) return;

            clientStore.setBalance?.(String(numericBalance));
            if (clientStore.loginid && Array.isArray(clientStore.account_list)) {
                clientStore.setAccountList?.(
                    clientStore.account_list.map(account =>
                        String(account.loginid) === String(clientStore.loginid)
                            ? { ...account, balance: numericBalance }
                            : account
                    )
                );
            }
        };

        refreshDerivAccountBalance = async (attempts = 3) => {
            const api = api_base?.api;
            if (!api || api.connection?.readyState !== 1) return null;

            const maxAttempts = Math.max(1, Number(attempts) || 1);
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                try {
                    const result = await Promise.race([
                        api.balance(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Deriv balance refresh timeout')), 5000)
                        ),
                    ]);

                    const balanceValue = Number(result?.balance?.balance);
                    const currency = result?.balance?.currency || this.tradeOptions?.currency || 'USD';
                    const loginid = result?.balance?.loginid || api_base.account_id || null;

                    if (Number.isFinite(balanceValue)) {
                        api_base.account_info = {
                            ...(api_base.account_info || {}),
                            balance: balanceValue,
                            currency,
                            loginid,
                        };
                        this.updateDerivAccountBalance(balanceValue);

                        globalObserver.setState({
                            trapkid_analyzer: {
                                ...(globalObserver.getState('trapkid_analyzer') || {}),
                                balance: balanceValue,
                                analyzerBalance: balanceValue,
                                derivBalance: balanceValue,
                                currency,
                                derivBalanceSource: 'DERIV_BALANCE',
                            },
                        });

                        globalObserver.emit(
                            'ui.log',
                            'TRAPKID DERIV BALANCE SYNC → ' + balanceValue
                        );
                        return balanceValue;
                    }
                } catch {
                    // Retry only this financial balance read; never touch Analyzer execution.
                }

                if (attempt < maxAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, 350));
                }
            }

            return null;
        };

        fetchAnalyzerPayoutQuote = signal => {
            if (!signal?.symbol) return Promise.resolve(null);

            const amount = Number(this.tradeOptions?.amount);
            const duration = Number(this.tradeOptions?.duration);
            const duration_unit = this.tradeOptions?.duration_unit || 't';
            const currency = this.tradeOptions?.currency || 'USD';
            const hotDigit = Number(signal.hotDigit);
            if (!Number.isFinite(amount) || amount <= 0) return Promise.resolve(null);
            if (!Number.isFinite(duration) || duration <= 0) return Promise.resolve(null);
            if (!Number.isInteger(hotDigit) || hotDigit < 0 || hotDigit > 9) return Promise.resolve(null);

            return this.requestAnalyzerDeriv(
                {
                    proposal: 1,
                    amount,
                    basis: this.tradeOptions?.basis || 'stake',
                    contract_type: 'DIGITMATCH',
                    currency,
                    duration,
                    duration_unit,
                    underlying_symbol: String(signal.symbol),
                    barrier: String(hotDigit),
                },
                'proposal'
            );
        };

        openAnalyzerDerivContract = async (signal, contractId) => {
            if (this.analyzerDerivBuyPromise) return this.analyzerDerivBuyPromise;

            this.analyzerDerivBuyPromise = (async () => {
                const proposalResponse = await this.fetchAnalyzerPayoutQuote(signal);
                const proposal = proposalResponse?.proposal;
                if (!proposal) {
                    globalObserver.emit('ui.log.error', 'TRAPKID DERIV FINANCIAL QUOTE → unavailable');
                    return null;
                }

                const potentialPayout = Number(proposal.payout);
                const askPrice = Number(proposal.ask_price);
                const proposalId = proposal.id;

                const quoteContract = this.data?.contract;
                if (quoteContract && String(quoteContract.contract_id) === String(contractId)) {
                    this.data.contract = {
                        ...quoteContract,
                        payout: Number.isFinite(potentialPayout) ? potentialPayout : quoteContract.payout,
                        analyzer_payout_source: 'DERIV_PROPOSAL',
                        analyzer_payout_quote_id: proposalId ?? null,
                        analyzer_payout_ask_price: Number.isFinite(askPrice) ? askPrice : null,
                        financial_status: 'DERIV_PROPOSAL_RECEIVED',
                    };
                    contract(this.data.contract);
                }

                if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0) {
                    globalObserver.emit('ui.log.error', 'TRAPKID DERIV FINANCIAL BUY → invalid proposal');
                    return null;
                }

                const buyResponse = await this.requestAnalyzerDeriv(
                    {
                        buy: String(proposalId),
                        price: askPrice,
                    },
                    'buy'
                );
                if (buyResponse?.error) {
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV FINANCIAL BUY → ' +
                            (buyResponse.error.message || buyResponse.error.code || 'rejected')
                    );
                    return null;
                }

                const buy = buyResponse?.buy;
                if (!buy?.contract_id) {
                    globalObserver.emit('ui.log.error', 'TRAPKID DERIV FINANCIAL BUY → no contract returned');
                    return null;
                }

                this.derivContractId = String(buy.contract_id);
                this.derivBuyTransactionId = buy.transaction_id ?? null;
                this.derivBuy = buy;

                const actualBuyPrice = Number(buy.buy_price);
                const actualPayout = Number(buy.payout);
                const balanceAfter = Number(buy.balance_after);
                const currentContract = this.data?.contract;

                if (currentContract && String(currentContract.contract_id) === String(contractId)) {
                    this.data.contract = {
                        ...currentContract,
                        buy_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : currentContract.buy_price,
                        payout: Number.isFinite(actualPayout)
                            ? actualPayout
                            : Number.isFinite(potentialPayout)
                              ? potentialPayout
                              : currentContract.payout,
                        analyzer_payout_source: 'DERIV_BUY',
                        analyzer_payout_quote_id: proposalId ?? null,
                        analyzer_payout_ask_price: Number.isFinite(askPrice) ? askPrice : null,
                        deriv_contract_id: String(buy.contract_id),
                        deriv_transaction_id: buy.transaction_id ?? null,
                        deriv_buy_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : null,
                        deriv_potential_payout: Number.isFinite(actualPayout) ? actualPayout : null,
                        deriv_balance_after_buy: Number.isFinite(balanceAfter) ? balanceAfter : null,
                        financial_status: 'DERIV_BUY_CONFIRMED',
                    };
                    contract(this.data.contract);
                }

                if (Number.isFinite(balanceAfter)) this.updateDerivAccountBalance(balanceAfter);

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        derivContractId: String(buy.contract_id),
                        derivTransactionId: buy.transaction_id ?? null,
                        derivBuyPrice: Number.isFinite(actualBuyPrice) ? actualBuyPrice : null,
                        analyzerPotentialPayout: Number.isFinite(actualPayout)
                            ? actualPayout
                            : Number.isFinite(potentialPayout)
                              ? potentialPayout
                              : null,
                        payout: Number.isFinite(actualPayout)
                            ? actualPayout
                            : Number.isFinite(potentialPayout)
                              ? potentialPayout
                              : null,
                        payoutSource: 'DERIV_BUY',
                        derivBalanceAfterBuy: Number.isFinite(balanceAfter) ? balanceAfter : null,
                    },
                });

                globalObserver.emit(
                    'ui.log',
                    'TRAPKID DERIV FINANCIAL BUY → ' +
                        String(buy.contract_id) +
                        ' → stake=' +
                        (Number.isFinite(actualBuyPrice) ? actualBuyPrice : askPrice) +
                        ' → payout=' +
                        (Number.isFinite(actualPayout) ? actualPayout : potentialPayout)
                );

                if (this.data?.contract?.is_sold) {
                    void this.settleAnalyzerDerivContract();
                }

                return buy;
            })();

            return this.analyzerDerivBuyPromise;
        };

        settleAnalyzerDerivContract = async () => {
            if (this.analyzerDerivSellPromise) return this.analyzerDerivSellPromise;

            this.analyzerDerivSellPromise = (async () => {
                const buy = this.analyzerDerivBuyPromise
                    ? await this.analyzerDerivBuyPromise.catch(() => null)
                    : this.derivBuy;
                const derivContractId = this.derivContractId || buy?.contract_id;
                if (!derivContractId) return null;

                const response = await this.requestAnalyzerDeriv(
                    {
                        sell: Number(derivContractId),
                        price: 0,
                    },
                    'sell'
                );
                if (response?.error) {
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV FINANCIAL SELL → ' +
                            (response.error.message || response.error.code || 'rejected')
                    );
                    return null;
                }

                const sold = response?.sell;
                if (!sold?.contract_id) return null;

                const soldFor = Number(sold.sold_for);
                const balanceAfter = Number(sold.balance_after);
                if (Number.isFinite(balanceAfter)) this.updateDerivAccountBalance(balanceAfter);
                // Re-read Deriv's authoritative balance after settlement. This is
                // financial reconciliation only; it does not touch Analyzer timing,
                // execution, or settlement authority.
                void this.refreshDerivAccountBalance(3);

                const currentContract = this.data?.contract;
                if (
                    currentContract &&
                    String(currentContract.contract_id) ===
                        String(this.analyzerContractId || this.contractId || currentContract.contract_id)
                ) {
                    this.data.contract = {
                        ...currentContract,
                        deriv_sell_transaction_id: sold.transaction_id ?? null,
                        deriv_sold_for: Number.isFinite(soldFor) ? soldFor : null,
                        deriv_balance_after_sell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                        financial_status: 'DERIV_SELL_CONFIRMED',
                    };
                    contract(this.data.contract);
                }

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        derivTransactionId: sold.transaction_id ?? null,
                        derivSoldFor: Number.isFinite(soldFor) ? soldFor : null,
                        derivBalanceAfterSell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                        derivFinancialStatus: 'DERIV_SELL_CONFIRMED',
                        realizedPayout: Number.isFinite(soldFor) ? soldFor : null,
                    },
                });

                globalObserver.emit(
                    'ui.log',
                    'TRAPKID DERIV FINANCIAL SELL → ' +
                        String(sold.contract_id) +
                        ' → realized=' +
                        (Number.isFinite(soldFor) ? soldFor : '—')
                );

                return sold;
            })();

            return this.analyzerDerivSellPromise;
        };

        financialAnalyzerBuyPromise = (signal, contractId) =>
            this.openAnalyzerDerivContract(signal, contractId);

        purchase(contract_type) {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const currentSignal = analyzerState?.signal;
            const currentSignalIsExecutable =
                !!currentSignal?.signalId &&
                !!currentSignal?.symbol &&
                Number.isInteger(Number(currentSignal?.hotDigit));

            const analyzerMode =
                this.isAnalyzerEnabledForTrade?.() ||
                !!this.analyzerSignal ||
                currentSignalIsExecutable ||
                [
                    'ANALYZER_PURCHASE_AUTHORIZED',
                    'ANALYZER_PURCHASE_BOUND',
                    'WAITING_FOR_ANALYZER_EXIT',
                    'WATCHING_ANALYZER_HOT_DIGIT',
                    'EARLY_EXIT_COMMAND_RECEIVED',
                    'ANALYZER_EXECUTION',
                    'RUNNING',
                ].includes(String(analyzerState.status || ''));

            if (analyzerMode) {
                const analyzerStateGate = globalObserver.getState('trapkid_analyzer') || {};
                // Analyzer entry is authorized by the execution trigger, not
                // by a transient UI/status label. The Analyzer bridge may move
                // the status to WAITING_FOR_ANALYZER_EXIT while the proposal is
                // still arriving; that must never cancel the already-authorized BUY.
                const gateSignal = analyzerStateGate.signal;
                const signalIdMatches =
                    !!gateSignal?.signalId &&
                    String(analyzerStateGate.signalId || '') === String(gateSignal.signalId);
                const lockedAtMatches =
                    Number.isFinite(Number(gateSignal?.lockedAt)) &&
                    Number(gateSignal.lockedAt) === Number(analyzerStateGate.lockedAt);
                const commandMatches =
                    signalIdMatches &&
                    String(analyzerStateGate.commandKey || '') ===
                        String(gateSignal.signalId) + ':' + String(gateSignal.lockedAt);
                const boundAnalyzerCommand = signalIdMatches && (commandMatches || lockedAtMatches);

                // Analyzer owns this execution path. A live signal bound to the same
                // signalId is sufficient authorization when the bridge has already
                // accepted the command but a UI refresh dropped executionArmed/trigger.
                // Never fall back to the Builder purchase gate.
                if (analyzerStateGate.executionArmed !== true && !boundAnalyzerCommand) {
                    // A valid locked signal is itself the entry authorization when
                    // Analyze was just clicked. Do not fall back to the generic
                    // "waiting for a signal to buy" lifecycle.
                    const currentSignalIsLocked =
                        !!gateSignal?.signalId &&
                        !!gateSignal?.symbol &&
                        Number.isInteger(Number(gateSignal?.hotDigit)) &&
                        Number.isFinite(Number(gateSignal?.lockedAt)) &&
                        (
                            !Number.isFinite(Number(gateSignal?.expiresAt)) ||
                            Date.now() < Number(gateSignal.expiresAt)
                        );

                    if (!currentSignalIsLocked) {
                        globalObserver.emit(
                            'ui.log.error',
                            `TRAPKID ANALYZER BUY BLOCKED → no current locked Analyzer signal=${String(analyzerStateGate.signalId || gateSignal?.signalId || '')}`
                        );
                        return Promise.resolve();
                    }

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...analyzerStateGate,
                            signal: gateSignal,
                            signalId: gateSignal.signalId,
                            commandKey: String(gateSignal.signalId) + ':' + String(gateSignal.lockedAt),
                            executionTrigger: 'ANALYZER_ENTRY',
                            executionArmed: true,
                            entrySource: 'ANALYZER_ONLY',
                            exitSource: 'ANALYZER_EARLY_SELL_ONLY',
                        },
                    });
                }

                // Restore the Analyzer-owned execution state after any bridge/UI refresh.
                if (String(analyzerStateGate.executionTrigger || '') !== 'ANALYZER_ENTRY' || analyzerStateGate.executionArmed !== true) {
                    globalObserver.emit(
                        'ui.log',
                        `TRAPKID ANALYZER BUY AUTHORIZED → normalizing trigger from ${String(analyzerStateGate.executionTrigger || 'none')} to ANALYZER_ENTRY`
                    );
                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...analyzerStateGate,
                            executionTrigger: 'ANALYZER_ENTRY',
                            executionArmed: true,
                        },
                    });
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

                const currentAnalyzerState = globalObserver.getState('trapkid_analyzer') || {};
                const analyzerCommandKey = this.analyzerCommandKey;

                // One Analyzer signal can create exactly one contract.
                // Keep this guard in shared observer state so it survives
                // engine/restart callbacks.
                if (
                    currentAnalyzerState.purchaseConsumedKey === analyzerCommandKey ||
                    currentAnalyzerState.purchaseInFlightKey === analyzerCommandKey
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
                        commandKey: analyzerCommandKey,
                        purchaseInFlightKey: analyzerCommandKey,
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
                // Analyzer owns the complete execution identity. Preserve its
                // entry/contract metadata instead of generating a new DBot
                // identity or replacing Analyzer's quote/code.
                this.tradeOptions.analyzerSignalId = String(signal.signalId);
                this.tradeOptions.analyzerCommandKey = analyzerCommandKey;
                this.tradeOptions.analyzerContractId =
                    signal.contractId ?? signal.contract_id ?? signal.analyzerContractId ?? String(signal.signalId);
                this.tradeOptions.analyzerEntryCode =
                    signal.entryCode ?? signal.entry_code ?? signal.signalId;
                this.tradeOptions.analyzerEntryQuote =
                    signal.entryQuote ?? signal.entry_quote ?? signal.quote;
                this.tradeOptions.analyzerLockedQuote =
                    signal.lockedQuote ?? signal.locked_quote ?? signal.quote;
                if (Number.isFinite(Number(signal.duration)) && Number(signal.duration) > 0) {
                    this.tradeOptions.duration = Number(signal.duration);
                    this.tradeOptions.duration_unit = signal.duration_unit || signal.durationUnit || 't';
                }

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
            if (!analyzerMode) {
                return Promise.reject(
                    new Error('TrapKid Analyzer-only engine: non-Analyzer execution is disabled.')
                );
            }

            // Analyzer is the complete execution engine. Create the contract locally
            // from Analyzer data. No proposal, BUY request, or Deriv contract observer.
            const signal = this.analyzerSignal;
            const entryCode =
                this.tradeOptions.analyzerEntryCode ||
                signal?.entryCode ||
                signal?.entry_code ||
                signal?.signalId;
            const contractId =
                this.tradeOptions.analyzerContractId ||
                signal?.contractId ||
                signal?.contract_id ||
                entryCode;
            const entryQuote = Number(
                this.tradeOptions.analyzerEntryQuote ??
                signal?.entryQuote ??
                signal?.entry_quote ??
                signal?.quote
            );
            const buyPrice = Number(this.tradeOptions.amount) || 0;

            this.isSold = false;
            this.isExpired = false;
            this.isSellAvailable = true;
            this.contractId = String(contractId);
            this.analyzerContractId = String(contractId);
            const openedAtMs = Number(
                signal?.lockedAt ??
                signal?.entryEpoch ??
                signal?.entryTime ??
                Date.now()
            );
            const durationValue = Number(this.tradeOptions.duration);
            const durationUnit = this.tradeOptions.duration_unit || 't';
            const payoutValue = Number(
                signal?.payout ??
                signal?.potentialPayout ??
                signal?.potential_payout ??
                signal?.return
            );
            const potentialPayout = Number.isFinite(payoutValue) ? payoutValue : 0;

            this.data.contract = {
                id: String(contractId),
                contract_id: String(contractId),
                transaction_ids: {
                    buy: String(entryCode),
                    sell: null,
                },
                contract_type: 'DIGITMATCH',
                symbol: signal?.symbol || this.tradeOptions.symbol,
                underlying_symbol: signal?.symbol || this.tradeOptions.symbol,
                display_name: signal?.symbol || this.tradeOptions.symbol,
                shortcode: 'DIGITMATCH',
                barrier: Number(signal.hotDigit),
                prediction: Number(signal.hotDigit),
                buy_price: buyPrice,
                sell_price: 0,
                bid_price: Number.isFinite(entryQuote) ? entryQuote : 0,
                payout: potentialPayout,
                profit: 0,
                currency: this.tradeOptions.currency || 'USD',
                purchase_time: Math.floor(openedAtMs / 1000),
                date_start: Math.floor(openedAtMs / 1000),
                date_expiry:
                    Number.isFinite(durationValue) && durationValue > 0 && durationUnit === 't'
                        ? Math.floor(openedAtMs / 1000) + durationValue
                        : null,
                entry_spot: Number.isFinite(entryQuote) ? entryQuote : null,
                entry_spot_time: Math.floor(openedAtMs / 1000),
                entry_tick: Number.isFinite(entryQuote) ? entryQuote : null,
                entry_tick_time: Math.floor(openedAtMs / 1000),
                tick_count:
                    Number.isFinite(durationValue) && durationValue > 0 && durationUnit === 't'
                        ? durationValue
                        : 0,
                tick_passed: 0,
                is_valid_to_sell: false,
                is_valid_to_cancel: false,
                is_settleable: false,
                analyzer_source: 'ANALYZER_ONLY',
                analyzer_signal_id: String(signal.signalId),
                analyzer_command_key: this.analyzerCommandKey,
                analyzer_contract_id: String(contractId),
                analyzer_entry_code: String(entryCode),
                analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                analyzer_locked_quote:
                    Number(this.tradeOptions.analyzerLockedQuote) || null,
                analyzer_hot_digit: Number(signal.hotDigit),
                analyzer_prediction: Number(signal.hotDigit),
                analyzer_duration: durationValue,
                analyzer_duration_unit: durationUnit,
                analyzer_exit_code: null,
                analyzer_exit_quote: null,
                analyzer_exit_digit: null,
                analyzer_exit_status: 'WAITING_FOR_ANALYZER_EXIT',
                status: 'open',
                is_sold: false,
            };

            globalObserver.setState({
                trapkid_analyzer: {
                    ...(globalObserver.getState('trapkid_analyzer') || {}),
                    status: 'WATCHING_ANALYZER_HOT_DIGIT',
                    signal,
                    signalId: signal.signalId,
                    commandKey: this.analyzerCommandKey,
                    purchaseInFlightKey: null,
                    purchaseConsumedKey: this.analyzerCommandKey,
                    executionArmed: true,
                    executionTrigger: 'ANALYZER_ENTRY',
                    holdUntilAnalyzerExit: true,
                    analyzerContractId: String(contractId),
                    analyzerEntryCode: String(entryCode),
                    analyzerEntryQuote: Number.isFinite(entryQuote) ? entryQuote : null,
                    settlementSource: 'ANALYZER',
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            // Publish the Analyzer-owned contract immediately so the
            // contract card leaves the generic "waiting for a signal" loader.
            // This is a local UI event only; no Deriv contract is created.
            contract({
                ...this.data.contract,
                contract_id: String(contractId),
                is_sold: false,
                status: 'open',
                analyzer_signal_id: String(signal.signalId),
                analyzer_command_key: this.analyzerCommandKey,
                analyzer_hot_digit: Number(signal.hotDigit),
                analyzer_entry_code: String(entryCode),
            });
            const purchasePayload = {
                ...this.data.contract,
                id: String(contractId),
                contract_id: String(contractId),
                is_sold: false,
                status: 'open',
            };

            contract(purchasePayload);
            contractStatus({
                id: 'contract.purchase_sent',
                data: String(contractId),
                contract: purchasePayload,
            });
            contractStatus({
                id: 'contract.purchase_received',
                data: String(contractId),
                buy: {
                    contract_id: String(contractId),
                    transaction_id: String(entryCode),
                    buy_price: buyPrice,
                    currency: this.tradeOptions.currency || 'USD',
                    analyzer_contract_id: String(contractId),
                    analyzer_entry_code: String(entryCode),
                    analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                },
                contract: purchasePayload,
            });

            globalObserver.emit(
                'ui.log',
                `TRAPKID ANALYZER CONTRACT OPEN → ${String(entryCode)} → quote=${Number.isFinite(entryQuote) ? entryQuote : '—'}`
            );

            // Financial leg only. Do not await it: Analyzer owns execution timing
            // and this bridge only mirrors the authorized trade financially at Deriv.
            this.financialAnalyzerBuyPromise(signal, contractId);

            const postEntryState = globalObserver.getState('trapkid_analyzer') || {};
            const pendingExit = postEntryState.pendingEarlyExit;
            if (pendingExit?.status === 'EARLY_SELL_READY' &&
                String(pendingExit.signalId || '') === String(signal.signalId || '') &&
                Number(pendingExit.digit) === Number(signal.hotDigit)) {
                const settledState = {
                    ...postEntryState,
                    exit: { ...pendingExit },
                    executionTrigger: 'EARLY_SELL_READY',
                    status: 'EARLY_EXIT_COMMAND_RECEIVED',
                    pendingEarlyExit: null,
                    holdUntilAnalyzerExit: false,
                };
                globalObserver.setState({ trapkid_analyzer: settledState });
                globalObserver.emit('trapkid.analyzer.updated', settledState);
                setTimeout(() => {
                    void this.onAnalyzerEarlyExit({
                        source: 'TRAPKID_ANALYZER_PENDING_EXIT',
                        command: 'ANALYZER_EARLY_EXIT',
                        commandKey: this.analyzerCommandKey,
                        signalId: String(signal.signalId),
                        signal,
                        exit: pendingExit,
                        receivedAt: Date.now(),
                    });
                }, 0);
            }

            return Promise.resolve({
                buy: {
                    contract_id: String(contractId),
                    transaction_id: String(entryCode),
                    buy_price: buyPrice,
                    currency: this.tradeOptions.currency || 'USD',
                    analyzer_contract_id: String(contractId),
                    analyzer_entry_code: String(entryCode),
                    analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                },
            });
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
