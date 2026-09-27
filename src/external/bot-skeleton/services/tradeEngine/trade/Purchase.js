import { LogTypes } from '../../../constants/messages';
import { contract, contractStatus, info, log } from '../utils/broadcast';
import { getUUID } from '../utils/helpers';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { account_list$, authData$, setAccountList, setAuthData } from '../../api/observables/connection-status-stream';

let purchase_reference;

export default Engine =>
    class Purchase extends Engine {

        // Financial-only Deriv bridge. Analyzer still controls the signal,
        // entry timing, hold state, and exit decision. Deriv is contacted only
        // for financial pricing, the authorized demo/real buy, and final
        // financial reconciliation. Never create a second Analyzer execution.
        requestAnalyzerDeriv = async (request, msgType, timeoutMs = 7000) => {
            // Analyzer is authoritative for the trade lifecycle, but the actual
            // money operation must use the authenticated Deriv websocket. If the
            // socket is briefly closed/opening, reconnect and wait instead of
            // turning that transient state into a fake "quote unavailable" result.
            let api = api_base?.api;

            if (!api || api.connection?.readyState !== 1) {
                try {
                    await api_base.init(true);
                } catch {
                    // The authenticated connection check below is authoritative.
                }

                const deadline = Date.now() + Math.min(12000, timeoutMs + 5000);
                while (Date.now() < deadline) {
                    api = api_base?.api;
                    if (api?.connection?.readyState === 1 && api_base?.is_authorized) break;
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            api = api_base?.api;
            if (!api || api.connection?.readyState !== 1) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV CONNECTION → authenticated WebSocket is not open.'
                );
                return null;
            }

            // A live WebSocket is not enough: BUY/SELL/PROPOSAL requests must be
            // sent on an authenticated account connection. The Analyzer entry is
            // allowed to wait for authorization; it must never silently turn that
            // wait into the generic "no real Deriv contract" error.
            if (!api_base?.is_authorized) {
                try {
                    await api_base.authorizeAndSubscribe();
                } catch (error) {
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV AUTHORIZATION → ' +
                            (error?.message || 'failed to authorize the active Deriv account')
                    );
                }
            }

            const authDeadline = Date.now() + 12000;
            while (Date.now() < authDeadline) {
                if (api_base?.is_authorized) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            if (!api_base?.is_authorized) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV AUTHORIZATION → active account is not authorized; financial request was not sent.'
                );
                return null;
            }

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

            const loginid = api_base.account_info?.loginid || globalObserver.getState('client.store')?.loginid || '';
            const currency =
                api_base.account_info?.currency ||
                globalObserver.getState('client.store')?.currency ||
                this.tradeOptions?.currency ||
                'USD';

            api_base.account_info = {
                ...(api_base.account_info || {}),
                balance: numericBalance,
                currency,
                loginid: loginid || api_base.account_info?.loginid,
            };

            const clientStore = globalObserver.getState('client.store');
            if (clientStore) {
                clientStore.setBalance?.(String(numericBalance));
                if (clientStore.loginid && Array.isArray(clientStore.account_list)) {
                    clientStore.setAccountList?.(
                        clientStore.account_list.map(account =>
                            String(account.loginid) === String(clientStore.loginid)
                                ? { ...account, balance: numericBalance, currency: account.currency || currency }
                                : account
                        )
                    );
                }
            }

            // Keep the real account observable used by the account/balance UI in
            // sync with the same Deriv balance. This is display/accounting only.
            const existingAccounts =
                (Array.isArray(account_list$?.value) && account_list$.value.length
                    ? account_list$.value
                    : clientStore?.account_list) || [];
            const activeLoginId =
                loginid ||
                existingAccounts?.[0]?.loginid ||
                '';

            const updatedAccounts = existingAccounts.map(account =>
                String(account.loginid) === String(activeLoginId)
                    ? { ...account, balance: numericBalance, currency: account.currency || currency }
                    : account
            );

            if (updatedAccounts.length) setAccountList(updatedAccounts);

            const existingAuth = authData$?.value || {};
            setAuthData({
                ...existingAuth,
                loginid: activeLoginId || existingAuth.loginid || '',
                balance: numericBalance,
                currency: existingAuth.currency || currency,
                account_list: updatedAccounts.length ? updatedAccounts : existingAuth.account_list || [],
            });

            // Keep the Analyzer-side financial state synchronized with Deriv.
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            globalObserver.setState({
                trapkid_analyzer: {
                    ...analyzerState,
                    balance: numericBalance,
                    analyzerBalance: numericBalance,
                    derivBalance: numericBalance,
                    currency,
                    derivBalanceSource: 'DERIV_BALANCE',
                },
            });
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
            // Analyzer-only mode must use the bot's normal configured execution
            // duration for the Deriv contract. Do NOT invent a longer financial
            // duration here. The Analyzer controls the exit event; this request only
            // purchases the configured DIGITMATCH contract.
            const configuredDuration = Number(this.tradeOptions?.duration);
            const duration_unit = this.tradeOptions?.duration_unit || 't';
            const duration =
                Number.isFinite(configuredDuration) && configuredDuration > 0
                    ? Math.floor(configuredDuration)
                    : 1;
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
                let proposalResponse = null;
                // The Analyzer signal is already locked. A transient Deriv websocket
                // response must not turn that authorized signal into a fake local
                // contract. Retry the actual Deriv proposal briefly before giving up.
                for (let attempt = 0; attempt < 3 && !proposalResponse?.proposal; attempt += 1) {
                    proposalResponse = await this.fetchAnalyzerPayoutQuote(signal);
                    if (!proposalResponse?.proposal && attempt < 2) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }

                if (proposalResponse?.error) {
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV PROPOSAL → ' +
                            (proposalResponse.error.message ||
                                proposalResponse.error.code ||
                                'Deriv rejected the DIGITMATCH proposal')
                    );
                    return null;
                }

                const proposal = proposalResponse?.proposal;
                if (!proposal) {
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV PROPOSAL → no proposal response from the authenticated Deriv connection.'
                    );
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

                if (!buyResponse) {
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV FINANCIAL BUY → no response from the authenticated Deriv connection.'
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

                // Deriv is the financial authority for the tracked trade.
                // Publish the exact BUY response; the transaction store renders it.
                globalObserver.emit('deriv.contract.buy', {
                    local_contract_id: this.data?.contract?.contract_id ?? contractId ?? null,
                    contract_id: String(buy.contract_id),
                    transaction_id: buy.transaction_id ?? null,
                    buy_transaction_id: buy.transaction_id ?? null,
                    buy_price: Number(buy.buy_price),
                    payout: Number(buy.payout),
                    currency: buy.currency || this.tradeOptions?.currency || 'USD',
                    balance_after: Number(buy.balance_after),
                });

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

                return buy;
            })();

            return this.analyzerDerivBuyPromise;
        };

        sellAnalyzerDerivContract = async () => {
            if (this.analyzerDerivSellPromise) return this.analyzerDerivSellPromise;

            this.analyzerDerivSellPromise = (async () => {
                const buy = this.analyzerDerivBuyPromise
                    ? await this.analyzerDerivBuyPromise.catch(() => null)
                    : this.derivBuy;
                const derivContractId = this.derivContractId || buy?.contract_id;
                if (!derivContractId) return null;

                let response = null;
                // Analyzer EARLY_SELL_READY is the single exit command. Retry only
                // the same Deriv sell request for transient websocket/auth races;
                // never substitute expiry settlement or another exit rule.
                for (let attempt = 0; attempt < 3 && !response?.sell && !response?.error; attempt += 1) {
                    response = await this.requestAnalyzerDeriv(
                        {
                            sell: Number(derivContractId),
                            price: 0,
                        },
                        'sell',
                        7000
                    );
                    if (!response?.sell && !response?.error && attempt < 2) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }

                if (response?.error) {
                    const errorMessage =
                        response.error.message ||
                        response.error.code ||
                        'Deriv rejected the early sell';
                    globalObserver.emit(
                        'ui.log.error',
                        'TRAPKID DERIV EARLY SELL → ' + errorMessage
                    );
                    return null;
                }

                if (response?.sell) {
                    const soldFor = Number(response.sell.sold_for);
                    const balanceAfter = Number(response.sell.balance_after);
                    const transactionId = response.sell.transaction_id ?? null;
                    const buyPrice = Number(
                        this.derivBuy?.buy_price ??
                        this.data?.contract?.deriv_buy_price ??
                        this.data?.contract?.buy_price
                    );
                    const realizedProfit =
                        Number.isFinite(soldFor) && Number.isFinite(buyPrice)
                            ? soldFor - buyPrice
                            : null;

                    globalObserver.emit('deriv.contract.sell', {
                        local_contract_id: this.data?.contract?.contract_id ?? null,
                        contract_id: String(derivContractId),
                        transaction_id: transactionId,
                        sell_transaction_id: transactionId,
                        sold_for: Number.isFinite(soldFor) ? soldFor : null,
                        balance_after: Number.isFinite(balanceAfter) ? balanceAfter : null,
                        currency: response.sell.currency || this.derivBuy?.currency || this.tradeOptions?.currency || 'USD',
                    });

                    if (Number.isFinite(balanceAfter)) {
                        this.updateDerivAccountBalance(balanceAfter);
                    }

                    const currentContract = this.data?.contract;
                    if (
                        currentContract &&
                        String(currentContract.contract_id) ===
                            String(this.analyzerContractId || this.contractId || currentContract.contract_id)
                    ) {
                        this.data.contract = {
                            ...currentContract,
                            transaction_ids: {
                                ...(currentContract.transaction_ids || {}),
                                sell: transactionId ?? currentContract.transaction_ids?.sell ?? null,
                            },
                            payout: Number.isFinite(soldFor) ? soldFor : currentContract.payout,
                            sell_price: Number.isFinite(soldFor) ? soldFor : currentContract.sell_price,
                            bid_price: Number.isFinite(soldFor) ? soldFor : currentContract.bid_price,
                            profit:
                                Number.isFinite(soldFor) && Number.isFinite(Number(currentContract.buy_price))
                                    ? soldFor - Number(currentContract.buy_price)
                                    : currentContract.profit,
                            deriv_contract_id: String(derivContractId),
                            deriv_transaction_id:
                                transactionId ??
                                currentContract.deriv_transaction_id ??
                                null,
                            deriv_sell_transaction_id: transactionId,
                            deriv_sell_price: Number.isFinite(soldFor) ? soldFor : null,
                            deriv_balance_after_sell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                            financial_status: 'DERIV_SELL_CONFIRMED',
                        };
                        contract(this.data.contract);
                    }

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...(globalObserver.getState('trapkid_analyzer') || {}),
                            derivContractId: String(derivContractId),
                            derivTransactionId: transactionId ?? this.derivBuyTransactionId ?? null,
                            derivSoldFor: Number.isFinite(soldFor) ? soldFor : null,
                            realizedPayout: Number.isFinite(soldFor) ? soldFor : null,
                            derivBalanceAfterSell: Number.isFinite(balanceAfter) ? balanceAfter : null,
                            derivFinancialStatus: 'DERIV_SELL_CONFIRMED',
                            payout: Number.isFinite(soldFor) ? soldFor : null,
                            profit:
                                Number.isFinite(soldFor) && Number.isFinite(Number(this.data?.contract?.buy_price))
                                    ? soldFor - Number(this.data.contract.buy_price)
                                    : null,
                        },
                    });

                    globalObserver.emit(
                        'ui.log',
                        'TRAPKID DERIV FINANCIAL SELL → ' +
                            String(derivContractId) +
                            ' → sold_for=' +
                            (Number.isFinite(soldFor) ? soldFor : '—') +
                            ' → balance_after=' +
                            (Number.isFinite(balanceAfter) ? balanceAfter : '—')
                    );

                    return {
                        ...response.sell,
                        contract_id: String(derivContractId),
                        sold_for: Number.isFinite(soldFor) ? soldFor : null,
                        payout: Number.isFinite(soldFor) ? soldFor : null,
                        buy_price: Number.isFinite(buyPrice) ? buyPrice : null,
                        profit: Number.isFinite(realizedProfit) ? realizedProfit : null,
                        balance_after: Number.isFinite(balanceAfter) ? balanceAfter : null,
                        transaction_id: transactionId,
                        sell_transaction_id: transactionId,
                        buy_transaction_id: this.derivBuyTransactionId ?? null,
                        financial_status: 'DERIV_SELL_CONFIRMED',
                    };
                }

                // Analyzer controls this lifecycle. Never silently switch an
                // Analyzer early-exit into expiry settlement when the Deriv sell
                // response is unavailable.
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV EARLY SELL → no sell response; Analyzer lifecycle remains open'
                );
                return null;
            })();

            return this.analyzerDerivSellPromise;
        };

        reconcileDerivClosedContract = async (derivContractId, attempts = 5) => {
            const contractId = String(derivContractId || '');
            if (!contractId) return null;

            const maxAttempts = Math.max(1, Number(attempts) || 1);
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                const response = await this.requestAnalyzerDeriv(
                    {
                        profit_table: 1,
                        contract_type: ['DIGITMATCH'],
                        limit: 50,
                        sort: 'DESC',
                    },
                    'profit_table',
                    5000
                );

                if (!response?.error) {
                    const transactions = response?.profit_table?.transactions || [];
                    const match = transactions.find(transaction =>
                        String(
                            transaction?.contract_id ??
                            transaction?.id ??
                            ''
                        ) === contractId
                    );

                    if (match) {
                        const finalPayout = Number(
                            match.sell_price ??
                            match.payout
                        );
                        const buyPrice = Number(match.buy_price);
                        const reportedProfit = Number(match.profit);
                        const profit = Number.isFinite(reportedProfit)
                            ? reportedProfit
                            : Number.isFinite(finalPayout) && Number.isFinite(buyPrice)
                              ? finalPayout - buyPrice
                              : NaN;

                        globalObserver.emit(
                            'ui.log',
                            'TRAPKID DERIV FINANCIAL RECONCILIATION → ' +
                                contractId +
                                ' → payout=' +
                                (Number.isFinite(finalPayout) ? finalPayout : '—')
                        );

                        return {
                            ...match,
                            contract_id: contractId,
                            sold_for: Number.isFinite(finalPayout) ? finalPayout : null,
                            transaction_id: match.transaction_id ?? null,
                            buy_price: Number.isFinite(buyPrice) ? buyPrice : null,
                            profit: Number.isFinite(profit) ? profit : null,
                            exit_spot: Number.isFinite(Number(match.exit_spot))
                                ? Number(match.exit_spot)
                                : null,
                            exit_spot_time: Number.isFinite(Number(match.exit_spot_time))
                                ? Number(match.exit_spot_time)
                                : null,
                        };
                    }
                }

                if (attempt < maxAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            return null;
        };

        settleAnalyzerDerivContract = async () => {
            if (this.analyzerDerivSettlementPromise) return this.analyzerDerivSettlementPromise;

            this.analyzerDerivSettlementPromise = (async () => {
                const buy = this.analyzerDerivBuyPromise
                    ? await this.analyzerDerivBuyPromise.catch(() => null)
                    : this.derivBuy;
                const derivContractId = this.derivContractId || buy?.contract_id;
                if (!derivContractId) return null;

                const startedAt = Date.now();
                const maxWaitMs = 180000;

                // IMPORTANT: Do not call Deriv "sell" here.
                // Analyzer may close its local lifecycle on EARLY_SELL_READY,
                // but a DIGITMATCH contract's real financial outcome is the
                // payout/profit at Deriv expiry. Holding the purchased contract
                // to expiry preserves the real Deriv payout instead of turning
                // a valid match signal into an early-sale loss.
                while (Date.now() - startedAt < maxWaitMs) {
                    const response = await this.requestAnalyzerDeriv(
                        {
                            proposal_open_contract: 1,
                            contract_id: Number(derivContractId),
                        },
                        'proposal_open_contract',
                        5000
                    );

                    if (response?.error) {
                        // A short-lived Deriv contract may already be settled before
                        // the Analyzer emits EARLY_SELL_READY. Do not keep polling a
                        // closed contract for the full 180s window; reconcile it now
                        // from Deriv's closed-contract history instead.
                        globalObserver.emit(
                            'ui.log',
                            'TRAPKID DERIV OPEN-CONTRACT → closed/unavailable; reconciling final financial result'
                        );
                        break;
                    }

                    const openContract = response?.proposal_open_contract;
                    if (openContract) {
                        // Keep the tracked trade synchronized with Deriv's live
                        // proposal_open_contract response. No journal/local calculation
                        // is used as the source of bid price, profit or currency.
                        globalObserver.emit('deriv.contract.open', {
                            contract_id: String(derivContractId),
                            bid_price: Number(openContract.bid_price),
                            profit: Number(openContract.profit),
                            payout: Number(openContract.payout),
                            buy_price: Number(openContract.buy_price),
                            currency: openContract.currency || this.derivBuy?.currency || this.tradeOptions?.currency || 'USD',
                            balance_after: Number(openContract.balance_after),
                            exit_spot: Number(openContract.exit_spot),
                            exit_spot_time: Number(openContract.exit_spot_time),
                            entry_spot: Number(openContract.entry_spot),
                            entry_spot_time: Number(openContract.entry_spot_time),
                            is_sold: openContract.is_sold,
                            is_expired: openContract.is_expired,
                            status: openContract.status ?? null,
                            transaction_ids: openContract.transaction_ids || null,
                            transaction_id: openContract.transaction_id ?? null,
                            buy_transaction_id: openContract.transaction_ids?.buy ?? this.derivBuyTransactionId ?? null,
                            sell_transaction_id: openContract.transaction_ids?.sell ?? openContract.transaction_id ?? null,
                            is_closed:
                                openContract.is_sold === 1 ||
                                openContract.is_sold === true ||
                                openContract.is_expired === 1 ||
                                openContract.is_expired === true ||
                                ['sold', 'expired', 'won', 'lost', 'settled'].includes(String(openContract.status || '').toLowerCase()),
                        });
                        const status = String(openContract.status || '').toLowerCase();
                        const closed =
                            openContract.is_sold === 1 ||
                            openContract.is_sold === true ||
                            openContract.is_expired === 1 ||
                            openContract.is_expired === true ||
                            ['sold', 'expired', 'won', 'lost', 'settled'].includes(status);

                        if (closed) {
                            const finalPayout = Number(openContract.payout);
                            const buyPrice = Number(openContract.buy_price);
                            const profit = Number(openContract.profit);
                            const balanceAfter = Number(openContract.balance_after);

                            if (Number.isFinite(balanceAfter)) {
                                this.updateDerivAccountBalance(balanceAfter);
                            }

                            const currentContract = this.data?.contract;
                            if (
                                currentContract &&
                                String(currentContract.contract_id) ===
                                    String(this.analyzerContractId || this.contractId || currentContract.contract_id)
                            ) {
                                this.data.contract = {
                                    ...currentContract,
                                    transaction_ids: {
                                        ...(currentContract.transaction_ids || {}),
                                        sell:
                                            openContract.transaction_id ??
                                            currentContract.transaction_ids?.sell ??
                                            currentContract.deriv_sell_transaction_id ??
                                            null,
                                    },
                                    payout: Number.isFinite(finalPayout) ? finalPayout : currentContract.payout,
                                    sell_price: Number.isFinite(finalPayout) ? finalPayout : currentContract.sell_price,
                                    bid_price: Number.isFinite(finalPayout) ? finalPayout : currentContract.bid_price,
                                    buy_price: Number.isFinite(buyPrice) ? buyPrice : currentContract.buy_price,
                                    profit: Number.isFinite(profit) ? profit : currentContract.profit,
                                    deriv_contract_id: String(derivContractId),
                                    deriv_transaction_id:
                                        openContract.transaction_ids?.buy ??
                                        this.derivBuyTransactionId ??
                                        currentContract.deriv_transaction_id ??
                                        null,
                                    deriv_sell_transaction_id:
                                        openContract.transaction_ids?.sell ??
                                        openContract.transaction_id ??
                                        currentContract.deriv_sell_transaction_id ??
                                        null,
                                    deriv_sell_price: Number.isFinite(finalPayout) ? finalPayout : null,
                                    deriv_balance_after_sell: Number.isFinite(balanceAfter)
                                        ? balanceAfter
                                        : currentContract.deriv_balance_after_sell ?? null,
                                    exit_spot: Number.isFinite(Number(openContract.exit_spot))
                                        ? Number(openContract.exit_spot)
                                        : currentContract.exit_spot,
                                    exit_spot_time: Number.isFinite(Number(openContract.exit_spot_time))
                                        ? Number(openContract.exit_spot_time)
                                        : currentContract.exit_spot_time,
                                    financial_status: 'DERIV_SETTLEMENT_CONFIRMED',
                                };
                                contract(this.data.contract);
                            }

                            globalObserver.setState({
                                trapkid_analyzer: {
                                    ...(globalObserver.getState('trapkid_analyzer') || {}),
                                    derivContractId: String(derivContractId),
                                    derivTransactionId:
                                        openContract.transaction_id ??
                                        this.derivBuyTransactionId ??
                                        null,
                                    derivSoldFor: Number.isFinite(finalPayout) ? finalPayout : null,
                                    realizedPayout: Number.isFinite(finalPayout) ? finalPayout : null,
                                    derivBalanceAfterSell: Number.isFinite(balanceAfter)
                                        ? balanceAfter
                                        : null,
                                    derivFinancialStatus: 'DERIV_SETTLEMENT_CONFIRMED',
                                    payout: Number.isFinite(finalPayout) ? finalPayout : null,
                                    profit: Number.isFinite(profit) ? profit : null,
                                },
                            });

                            const refreshedBalance = await this.refreshDerivAccountBalance(3);
                            const finalBalanceAfter = Number.isFinite(Number(refreshedBalance))
                                ? Number(refreshedBalance)
                                : Number.isFinite(balanceAfter)
                                  ? balanceAfter
                                  : null;

                            if (currentContract) {
                                this.data.contract = {
                                    ...this.data.contract,
                                    balance_after: finalBalanceAfter,
                                    deriv_balance_after_sell: finalBalanceAfter,
                                };
                                contract(this.data.contract);
                            }

                            globalObserver.emit(
                                'ui.log',
                                'TRAPKID DERIV FINANCIAL SETTLEMENT → ' +
                                    String(derivContractId) +
                                    ' → payout=' +
                                    (Number.isFinite(finalPayout) ? finalPayout : '—') +
                                    ' → profit=' +
                                    (Number.isFinite(profit) ? profit : '—') +
                                    ' → balance_after=' +
                                    (Number.isFinite(finalBalanceAfter) ? finalBalanceAfter : '—')
                            );

                            return {
                                ...openContract,
                                contract_id: String(derivContractId),
                                sold_for: Number.isFinite(finalPayout) ? finalPayout : null,
                                transaction_id:
                                    openContract.transaction_ids?.sell ??
                                    openContract.transaction_id ??
                                    null,
                                buy_transaction_id:
                                    openContract.transaction_ids?.buy ??
                                    this.derivBuyTransactionId ??
                                    null,
                                sell_transaction_id:
                                    openContract.transaction_ids?.sell ??
                                    openContract.transaction_id ??
                                    null,
                                transaction_ids: openContract.transaction_ids || null,
                                buy_price: Number.isFinite(buyPrice) ? buyPrice : null,
                                profit: Number.isFinite(profit) ? profit : null,
                                payout: Number.isFinite(finalPayout) ? finalPayout : null,
                                bid_price: Number.isFinite(Number(openContract.bid_price))
                                    ? Number(openContract.bid_price)
                                    : null,
                                exit_spot: Number.isFinite(Number(openContract.exit_spot))
                                    ? Number(openContract.exit_spot)
                                    : null,
                                exit_spot_time: Number.isFinite(Number(openContract.exit_spot_time))
                                    ? Number(openContract.exit_spot_time)
                                    : null,
                                balance_after: finalBalanceAfter,
                            };
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // If the contract has just closed but the direct status request
                // did not return the terminal record, reconcile from Deriv's
                // authoritative profit table.
                const reconciled = await this.reconcileDerivClosedContract(derivContractId);
                if (reconciled) {
                    const reconciledPayout = Number(reconciled.sold_for);
                    const currentContract = this.data?.contract;
                    if (
                        currentContract &&
                        String(currentContract.contract_id) ===
                            String(this.analyzerContractId || this.contractId || currentContract.contract_id)
                    ) {
                        this.data.contract = {
                            ...currentContract,
                            transaction_ids: {
                                ...(currentContract.transaction_ids || {}),
                                sell:
                                    reconciled.transaction_id ??
                                    currentContract.transaction_ids?.sell ??
                                    currentContract.deriv_sell_transaction_id ??
                                    null,
                            },
                            payout: Number.isFinite(reconciledPayout) ? reconciledPayout : currentContract.payout,
                            sell_price: Number.isFinite(reconciledPayout) ? reconciledPayout : currentContract.sell_price,
                            bid_price: Number.isFinite(reconciledPayout) ? reconciledPayout : currentContract.bid_price,
                            buy_price: Number.isFinite(Number(reconciled.buy_price))
                                ? Number(reconciled.buy_price)
                                : currentContract.buy_price,
                            profit: Number.isFinite(Number(reconciled.profit))
                                ? Number(reconciled.profit)
                                : currentContract.profit,
                            deriv_contract_id: String(derivContractId),
                            deriv_transaction_id:
                                reconciled.transaction_id ??
                                currentContract.deriv_transaction_id ??
                                null,
                            deriv_sell_transaction_id:
                                reconciled.transaction_id ??
                                currentContract.deriv_sell_transaction_id ??
                                null,
                            deriv_sell_price: Number.isFinite(reconciledPayout) ? reconciledPayout : null,
                            exit_spot: Number.isFinite(Number(reconciled.exit_spot))
                                ? Number(reconciled.exit_spot)
                                : currentContract.exit_spot,
                            exit_spot_time: Number.isFinite(Number(reconciled.exit_spot_time))
                                ? Number(reconciled.exit_spot_time)
                                : currentContract.exit_spot_time,
                            financial_status: 'DERIV_SETTLEMENT_RECONCILED',
                        };
                        contract(this.data.contract);
                    }

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...(globalObserver.getState('trapkid_analyzer') || {}),
                            derivContractId: String(derivContractId),
                            derivTransactionId:
                                reconciled.transaction_id ??
                                this.derivBuyTransactionId ??
                                null,
                            derivSoldFor: Number.isFinite(reconciledPayout) ? reconciledPayout : null,
                            derivFinancialStatus: 'DERIV_SETTLEMENT_RECONCILED',
                            realizedPayout: Number.isFinite(reconciledPayout) ? reconciledPayout : null,
                            payout: Number.isFinite(reconciledPayout) ? reconciledPayout : null,
                            profit: Number.isFinite(Number(reconciled.profit))
                                ? Number(reconciled.profit)
                                : null,
                        },
                    });

                    const reconciledBalance = await this.refreshDerivAccountBalance(3);
                    if (Number.isFinite(reconciledBalance)) {
                        const currentContract = this.data?.contract;
                        if (
                            currentContract &&
                            String(currentContract.contract_id) === String(
                                this.analyzerContractId || this.contractId || currentContract.contract_id
                            )
                        ) {
                            this.data.contract = {
                                ...currentContract,
                                deriv_balance_after_sell: reconciledBalance,
                                financial_status: 'DERIV_SETTLEMENT_RECONCILED',
                            };
                            contract(this.data.contract);
                        }
                    }
                    return reconciled;
                }

                void this.refreshDerivAccountBalance(3);
                return null;
            })();

            return this.analyzerDerivSettlementPromise;
        };

        financialAnalyzerBuyPromise = (signal, contractId) =>
            this.openAnalyzerDerivContract(signal, contractId);

        async purchase(contract_type) {
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

            // REAL DERIV BUY IS THE ENTRY GATE.
            // Never publish a fake/local "open" contract first. Analyzer supplies
            // the signal, but Deriv must accept the proposal and BUY the actual
            // DIGITMATCH contract before the UI is allowed to show an open trade.
            // This is what causes the configured stake to leave the active Deriv
            // balance and gives us Deriv's authoritative contract_id, buy_price,
            // payout and transaction_id.
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

            if (!signal?.signalId || !signal?.symbol || !Number.isInteger(Number(signal.hotDigit))) {
                throw new Error('TRAPKID ANALYZER: invalid locked signal; real Deriv BUY blocked.');
            }

            globalObserver.emit(
                'ui.log',
                'TRAPKID DERIV BUY REQUEST → ' + String(signal.symbol) +
                    ' → DIGITMATCH ' + Number(signal.hotDigit) +
                    ' → stake=' + (Number(this.tradeOptions.amount) || 0)
            );

            // The financial bridge is now awaited. A local contract is NOT created
            // if Deriv rejects, times out, or fails to return a real contract_id.
            const derivBuy = await this.openAnalyzerDerivContract(signal, contractId);
            if (!derivBuy?.contract_id) {
                const failedState = globalObserver.getState('trapkid_analyzer') || {};
                globalObserver.setState({
                    trapkid_analyzer: {
                        ...failedState,
                        status: 'DERIV_BUY_FAILED',
                        purchaseInFlightKey: null,
                        purchaseConsumedKey: null,
                        executionTrigger: 'ANALYZER_ENTRY',
                        executionArmed: true,
                    },
                });
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV BUY FAILED → no real Deriv contract was opened; local contract was not created.'
                );
                throw new Error('TRAPKID DERIV BUY failed. No real Deriv contract was opened.');
            }

            const derivContractId = String(derivBuy.contract_id);
            const actualBuyPrice = Number(derivBuy.buy_price);
            const actualPayout = Number(derivBuy.payout);
            const balanceAfterBuy = Number(derivBuy.balance_after);
            const entryQuote = Number(
                this.tradeOptions.analyzerEntryQuote ??
                signal?.entryQuote ??
                signal?.entry_quote ??
                signal?.quote
            );
            const openedAtMs = Number(
                signal?.lockedAt ??
                signal?.entryEpoch ??
                signal?.entryTime ??
                Date.now()
            );
            const durationValue = Number(this.tradeOptions.duration);
            const durationUnit = this.tradeOptions.duration_unit || 't';

            this.isSold = false;
            this.isExpired = false;
            this.isSellAvailable = true;
            // Keep the Analyzer entry identity for the UI/journal, while the
            // Deriv contract ID is the ONLY handle used for the real sell.
            this.contractId = String(contractId);
            this.analyzerContractId = String(contractId);
            this.derivContractId = derivContractId;
            this.derivBuy = derivBuy;
            this.derivBuyTransactionId = derivBuy.transaction_id ?? null;

            this.data.contract = {
                id: String(contractId),
                contract_id: String(contractId),
                deriv_contract_id: derivContractId,
                transaction_ids: {
                    buy: derivBuy.transaction_id ?? null,
                    sell: null,
                },
                contract_type: 'DIGITMATCH',
                symbol: signal.symbol,
                underlying_symbol: signal.symbol,
                display_name: signal.symbol,
                shortcode: 'DIGITMATCH',
                barrier: Number(signal.hotDigit),
                prediction: Number(signal.hotDigit),
                buy_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : Number(this.tradeOptions.amount),
                sell_price: 0,
                bid_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : 0,
                payout: Number.isFinite(actualPayout) ? actualPayout : 0,
                profit: 0,
                currency: derivBuy.currency || this.tradeOptions.currency || 'USD',
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
                is_valid_to_sell: true,
                is_valid_to_cancel: false,
                is_settleable: false,
                analyzer_source: 'ANALYZER_ONLY',
                analyzer_signal_id: String(signal.signalId),
                analyzer_command_key: this.analyzerCommandKey,
                analyzer_contract_id: String(contractId),
                analyzer_entry_code: String(entryCode),
                analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                analyzer_locked_quote: Number(this.tradeOptions.analyzerLockedQuote) || null,
                analyzer_hot_digit: Number(signal.hotDigit),
                analyzer_prediction: Number(signal.hotDigit),
                analyzer_duration: durationValue,
                analyzer_duration_unit: durationUnit,
                analyzer_exit_code: null,
                analyzer_exit_quote: null,
                analyzer_exit_digit: null,
                analyzer_exit_status: 'WAITING_FOR_ANALYZER_EXIT',
                deriv_transaction_id: derivBuy.transaction_id ?? null,
                deriv_buy_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : null,
                deriv_potential_payout: Number.isFinite(actualPayout) ? actualPayout : null,
                deriv_balance_after_buy: Number.isFinite(balanceAfterBuy) ? balanceAfterBuy : null,
                financial_status: 'DERIV_BUY_CONFIRMED',
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
                    derivContractId,
                    derivTransactionId: derivBuy.transaction_id ?? null,
                    derivBuyPrice: Number.isFinite(actualBuyPrice) ? actualBuyPrice : null,
                    analyzerPotentialPayout: Number.isFinite(actualPayout) ? actualPayout : null,
                    payout: Number.isFinite(actualPayout) ? actualPayout : null,
                    payoutSource: 'DERIV_BUY',
                    derivBalanceAfterBuy: Number.isFinite(balanceAfterBuy) ? balanceAfterBuy : null,
                    analyzerEntryCode: String(entryCode),
                    analyzerEntryQuote: Number.isFinite(entryQuote) ? entryQuote : null,
                    settlementSource: 'DERIV',
                },
            });
            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));

            // Only now publish the contract as OPEN. At this point Deriv has
            // already deducted the stake and returned a real contract_id.
            const purchasePayload = {
                ...this.data.contract,
                id: String(contractId),
                contract_id: String(contractId),
                deriv_contract_id: derivContractId,
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
                    contract_id: derivContractId,
                    transaction_id: derivBuy.transaction_id ?? null,
                    buy_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : null,
                    payout: Number.isFinite(actualPayout) ? actualPayout : null,
                    currency: derivBuy.currency || this.tradeOptions.currency || 'USD',
                    analyzer_contract_id: String(contractId),
                    analyzer_entry_code: String(entryCode),
                    analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                },
                contract: purchasePayload,
            });

            globalObserver.emit(
                'ui.log',
                'TRAPKID REAL DERIV CONTRACT OPEN → ' + String(derivContractId) +
                    ' → stake=' + (Number.isFinite(actualBuyPrice) ? actualBuyPrice : '—') +
                    ' → payout=' + (Number.isFinite(actualPayout) ? actualPayout : '—')
            );

            // If Analyzer signalled EARLY_SELL_READY during the Deriv BUY, execute
            // that exact exit immediately against the SAME real Deriv contract.
            const postEntryState = globalObserver.getState('trapkid_analyzer') || {};
            const pendingExit = postEntryState.pendingEarlyExit;
            if (
                pendingExit?.status === 'EARLY_SELL_READY' &&
                String(pendingExit.signalId || '') === String(signal.signalId || '') &&
                Number(pendingExit.digit) === Number(signal.hotDigit)
            ) {
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
                await this.onAnalyzerEarlyExit({
                    source: 'TRAPKID_ANALYZER_PENDING_EXIT',
                    command: 'ANALYZER_EARLY_EXIT',
                    commandKey: this.analyzerCommandKey,
                    signalId: String(signal.signalId),
                    signal,
                    exit: pendingExit,
                    receivedAt: Date.now(),
                });
            }

            return {
                buy: {
                    contract_id: derivContractId,
                    transaction_id: derivBuy.transaction_id ?? null,
                    buy_price: Number.isFinite(actualBuyPrice) ? actualBuyPrice : null,
                    payout: Number.isFinite(actualPayout) ? actualPayout : null,
                    balance_after: Number.isFinite(balanceAfterBuy) ? balanceAfterBuy : null,
                    currency: derivBuy.currency || this.tradeOptions.currency || 'USD',
                    analyzer_contract_id: String(contractId),
                    analyzer_entry_code: String(entryCode),
                    analyzer_entry_quote: Number.isFinite(entryQuote) ? entryQuote : null,
                },
            };
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
