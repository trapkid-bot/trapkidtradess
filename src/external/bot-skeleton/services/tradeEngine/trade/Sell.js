import { contractStatus } from '../utils/broadcast';
import { sell } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return Boolean(this.contractId && !this.isSold);
        }

        async sellAtMarket(source = 'BLOCKLY') {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerSignal = this.analyzerSignal || analyzerState.signal;

            if (source !== 'ANALYZER_EARLY_SELL') {
                return Promise.resolve();
            }

            if (
                !analyzerSignal?.signalId ||
                String(analyzerState.commandKey || '') !==
                    String(analyzerSignal.signalId) + ':' + String(analyzerSignal.lockedAt) ||
                String(analyzerState.executionTrigger || '') !== 'EARLY_SELL_READY'
            ) {
                return Promise.resolve();
            }

            if (!this.isSellAtMarketAvailable()) return Promise.resolve();

            const exit = this.getAnalyzerExit?.();
            const contract = this.data?.contract || {};
            const fallbackStake = Number(contract.buy_price ?? this.tradeOptions?.amount ?? 0);

            // Wait only for the financial leg of the same Analyzer signal. This does
            // not change Analyzer's entry/hold/exit decision; it records the actual
            // Deriv proceeds for the contract that was financially purchased.
            let derivSell = null;
            if (this.settleAnalyzerDerivContract) {
                void this.settleAnalyzerDerivContract().catch(error => {
                    globalObserver.emit(
                        'ui.log.error',
                        `TRAPKID DERIV FINANCIAL SETTLEMENT ERROR → ${error?.message || 'Unknown error'}`
                    );
                });
            }

            const actualBuyPrice = Number(this.derivBuy?.buy_price);
            const stake = Number.isFinite(actualBuyPrice) ? actualBuyPrice : fallbackStake;
            const soldFor = Number(derivSell?.sold_for);
            const derivPayout = Number.isFinite(soldFor) && soldFor >= 0 ? soldFor : NaN;

            const analyzerPayoutValue = Number(
                exit?.payout ??
                exit?.sellPrice ??
                exit?.sell_price ??
                analyzerState?.exit?.payout ??
                analyzerState?.exit?.sellPrice ??
                analyzerState?.exit?.sell_price ??
                analyzerSignal?.payout ??
                analyzerSignal?.sellPrice ??
                analyzerSignal?.sell_price
            );
            // Keep the authoritative Deriv buy payout visible immediately while
            // the final financial settlement is still pending. The settlement
            // promise will replace this with the final Deriv proceeds once closed.
            const derivBuyPayout = Number(this.derivBuy?.payout);
            const existingFinancialPayout = Number(
                contract.payout ??
                analyzerState?.analyzerPotentialPayout ??
                analyzerState?.payout
            );
            const payout = Number.isFinite(derivPayout)
                ? derivPayout
                : Number.isFinite(derivBuyPayout) && derivBuyPayout >= 0
                  ? derivBuyPayout
                  : Number.isFinite(analyzerPayoutValue)
                    ? analyzerPayoutValue
                    : Number.isFinite(existingFinancialPayout)
                      ? existingFinancialPayout
                      : 0;
            const derivProfit = Number(derivSell?.profit);
            const finalProfit = Number.isFinite(derivProfit)
                ? derivProfit
                : 0;

            const exitQuoteValue = Number(exit?.quote ?? analyzerState?.exit?.quote);
            const contractId = String(
                this.analyzerContractId ||
                this.tradeOptions?.analyzerContractId ||
                analyzerSignal?.contractId ||
                analyzerSignal?.contract_id ||
                this.contractId ||
                this.tradeOptions?.analyzerEntryCode ||
                analyzerSignal?.entryCode ||
                analyzerSignal?.signalId
            );

            const exitCode =
                exit?.exitCode ||
                analyzerState?.exit?.exitCode ||
                analyzerSignal?.exitCode ||
                null;
            const exitDigit = Number(exit?.digit ?? analyzerState?.exit?.digit);
            const settledAtMs = Number(exit?.epoch) > 0 ? Number(exit.epoch) * 1000 : Date.now();
            const derivSellTransactionId = derivSell?.transaction_id ?? null;

            this.data.contract = {
                ...contract,
                id: contractId,
                contract_id: contractId,
                transaction_ids: {
                    ...(contract.transaction_ids || {}),
                    sell: derivSellTransactionId || exitCode || contractId,
                },
                analyzer_contract_id: contractId,
                analyzer_entry_code:
                    this.tradeOptions?.analyzerEntryCode ||
                    analyzerSignal?.entryCode ||
                    analyzerSignal?.entry_code ||
                    analyzerSignal?.signalId,
                analyzer_exit_code: exitCode,
                analyzer_entry_quote:
                    this.tradeOptions?.analyzerEntryQuote ??
                    analyzerSignal?.entryQuote ??
                    analyzerSignal?.entry_quote ??
                    analyzerSignal?.quote,
                analyzer_exit_quote: Number.isFinite(exitQuoteValue) ? exitQuoteValue : null,
                analyzer_exit_digit: Number.isInteger(exitDigit) ? exitDigit : null,
                analyzer_exit_status: 'EARLY_SELL_READY',
                sell_price: payout,
                bid_price: Number.isFinite(derivPayout)
                    ? derivPayout
                    : Number.isFinite(exitQuoteValue)
                      ? exitQuoteValue
                      : payout,
                payout,
                profit: finalProfit,
                deriv_contract_id: this.derivContractId || contract.deriv_contract_id || null,
                deriv_transaction_id: derivSellTransactionId || contract.deriv_transaction_id || null,
                deriv_sell_price: Number.isFinite(derivPayout) ? derivPayout : null,
                deriv_balance_after_sell: Number.isFinite(Number(derivSell?.balance_after))
                    ? Number(derivSell.balance_after)
                    : null,
                financial_status: derivSell ? 'DERIV_SETTLEMENT_CONFIRMED' : 'DERIV_SETTLEMENT_PENDING',
                exit_spot: Number.isFinite(exitQuoteValue) ? exitQuoteValue : null,
                exit_tick: Number.isInteger(exitDigit) ? exitDigit : null,
                exit_tick_time: Math.floor(settledAtMs / 1000),
                status: 'sold',
                is_sold: true,
                is_expired: false,
                is_settleable: false,
                is_valid_to_sell: false,
            };

            this.isSold = true;
            this.isExpired = false;
            this.isSellAvailable = false;
            this.contractId = '';
            this.updateTotals(this.data.contract);

            contractStatus({
                id: 'contract.sold',
                data: contractId,
                contract: this.data.contract,
            });
            globalObserver.emit('bot.contract', this.data.contract);

            globalObserver.setState({
                trapkid_analyzer: {
                    ...analyzerState,
                    status: 'ANALYZER_SETTLED',
                    signal: analyzerSignal,
                    signalId: analyzerSignal.signalId,
                    commandKey: analyzerState.commandKey,
                    executionTrigger: 'ANALYZER_SETTLED',
                    holdUntilAnalyzerExit: false,
                    settlementSource: 'ANALYZER',
                    analyzerContractId: contractId,
                    analyzerEntryCode: this.data.contract.analyzer_entry_code,
                    analyzerExitCode: this.data.contract.analyzer_exit_code,
                    analyzerEntryQuote: this.data.contract.analyzer_entry_quote,
                    analyzerExitQuote: this.data.contract.analyzer_exit_quote,
                    payout,
                    profit: finalProfit,
                    derivPayout: Number.isFinite(derivPayout) ? derivPayout : null,
                    derivBalanceAfterSell: Number.isFinite(Number(derivSell?.balance_after))
                        ? Number(derivSell.balance_after)
                        : null,
                    exit: exit || analyzerState.exit,
                },
            });

            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            globalObserver.emit(
                'ui.log',
                `TRAPKID ANALYZER SETTLED → ${contractId} → payout=${payout} → Deriv=${derivSell ? 'SETTLED' : 'SETTLEMENT_PENDING'}`
            );

            if (this.afterPromise) {
                this.afterPromise();
                this.afterPromise = null;
            }

            this.store.dispatch(sell());
            return Promise.resolve();
        }
    };
