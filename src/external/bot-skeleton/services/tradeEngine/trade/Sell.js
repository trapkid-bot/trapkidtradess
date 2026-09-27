import { contractStatus } from '../utils/broadcast';
import { sell } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            // Analyzer-only trades are backed by the real Deriv contract ID.
            // The local Analyzer contract ID is only a tracking key and must
            // never be required for the actual Deriv sell.
            return Boolean((this.derivContractId || this.contractId) && !this.isSold);
        }

        async sellAtMarket(source = 'BLOCKLY') {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerSignal =
                analyzerState?.signal?.signalId
                    ? analyzerState.signal
                    : this.analyzerSignal;

            if (source !== 'ANALYZER_EARLY_SELL') {
                return false;
            }

            // This method is reached only from the Analyzer command path.
            // Do not require a second transient UI/state flag before sending the
            // sell request. The exact Analyzer signal is the authorization and
            // the Deriv contract_id below is the only financial execution handle.
            if (!analyzerSignal?.signalId) {
                return false;
            }

            // EARLY_SELL_READY must be able to close the already-purchased
            // Deriv contract even if a UI refresh cleared the local tracking ID.
            if (!this.derivContractId && !this.contractId) return false;
            if (this.isSold) return true;
            if (
                this.analyzerDerivSignalId &&
                String(this.analyzerDerivSignalId) !== String(analyzerSignal.signalId)
            ) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER COMMAND → DERIV CONTRACT/SIGNAL OWNERSHIP MISMATCH; SELL BLOCKED'
                );
                return false;
            }

            // Read the live Analyzer exit first. Only fall back to the
            // engine helper when the shared state does not carry the ready exit.
            const exit =
                analyzerState?.exit?.status === 'EARLY_SELL_READY'
                    ? analyzerState.exit
                    : this.getAnalyzerExit?.();
            const exitStatus = String(exit?.status || analyzerState?.exit?.status || '');
            const exitDigit = Number(exit?.digit ?? analyzerState?.exit?.digit);
            // Defensive validation at the financial boundary too: the SELL is
            // allowed only for this exact Analyzer signal and its exact hot digit.
            if (
                exitStatus !== 'EARLY_SELL_READY' ||
                !Number.isInteger(exitDigit) ||
                exitDigit !== Number(analyzerSignal.hotDigit)
            ) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER COMMAND → EARLY_SELL_READY REJECTED: exit digit/status mismatch'
                );
                return false;
            }
            const contract = this.data?.contract || {};
            const fallbackStake = Number(contract.buy_price ?? this.tradeOptions?.amount ?? 0);

            // Analyzer command has reached the real execution boundary.
            // There is no local simulation, Builder rule, expiry fallback, or
            // second approval here: send SELL against the SAME Deriv contract ID.
            globalObserver.emit(
                'ui.log',
                'TRAPKID ANALYZER COMMAND → FORCED REAL DERIV SELL → contract=' +
                    String(this.derivContractId || this.contractId) +
                    ' → signal=' + String(analyzerSignal.signalId) +
                    ' → exit=EARLY_SELL_READY'
            );

            // Analyzer is authoritative for the exit decision. Once the Analyzer
            // verifies EARLY_SELL_READY, execute the real Deriv early-sell request.
            // Deriv is used only for the actual amount returned (sold_for), transaction
            // ID, and resulting balance. Do not wait for contract expiry here.
            let derivSettlement = null;
            try {
                derivSettlement = await this.sellAnalyzerDerivContract?.();
            } catch (error) {
                globalObserver.emit(
                    'ui.log.error',
                    `TRAPKID DERIV EARLY SELL ERROR → ${error?.message || 'Unknown error'}`
                );
            }

            if (!derivSettlement) {
                // Allow a later Analyzer command to retry the SAME Deriv contract.
                // Never fabricate a local settlement when Deriv did not confirm it.
                this.analyzerDerivSellPromise = null;
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID ANALYZER COMMAND → REAL DERIV SELL DID NOT RETURN PROCEEDS; SAME contract remains open/terminal and was not locally closed'
                );
                return false;
            }

            const actualBuyPrice = Number(derivSettlement?.buy_price ?? this.derivBuy?.buy_price);
            const stake = Number.isFinite(actualBuyPrice) ? actualBuyPrice : fallbackStake;
            const payoutValue = Number(
                derivSettlement?.payout ??
                derivSettlement?.sold_for
            );
            const derivPayout = Number.isFinite(payoutValue) ? payoutValue : NaN;
            // Deriv's early-sell response supplies the actual proceeds as
            // sold_for. Realized P/L is simply those Deriv proceeds minus the
            // actual Deriv buy price; no Analyzer-estimated payout is used.
            const reportedDerivProfit = Number(derivSettlement?.profit);
            const derivedDerivProfit =
                Number.isFinite(reportedDerivProfit)
                    ? reportedDerivProfit
                    : Number.isFinite(derivPayout) && Number.isFinite(stake)
                      ? derivPayout - stake
                      : NaN;
            if (!Number.isFinite(derivPayout) || !Number.isFinite(derivedDerivProfit)) {
                globalObserver.emit(
                    'ui.log.error',
                    'TRAPKID DERIV EARLY SELL → sold_for or Deriv buy price missing; transaction remains open'
                );
                return false;
            }
            const payout = derivPayout;
            const finalProfit = derivedDerivProfit;
            const derivSellTransactionId =
                derivSettlement?.sell_transaction_id ??
                derivSettlement?.transaction_ids?.sell ??
                derivSettlement?.transaction_id ??
                null;
            const derivBuyTransactionId =
                derivSettlement?.buy_transaction_id ??
                derivSettlement?.transaction_ids?.buy ??
                this.derivBuyTransactionId ??
                null;

            const analyzerExitQuoteValue = Number(exit?.quote ?? analyzerState?.exit?.quote);
            const derivExitSpot = Number(derivSettlement?.exit_spot);
            const derivExitSpotTime = Number(derivSettlement?.exit_spot_time);
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
            const settledExitDigit = Number(exit?.digit ?? analyzerState?.exit?.digit);
            const settledAtMs = Number(exit?.epoch) > 0 ? Number(exit.epoch) * 1000 : Date.now();

            this.data.contract = {
                ...contract,
                id: contractId,
                contract_id: contractId,
                transaction_ids: {
                    ...(contract.transaction_ids || {}),
                    buy: derivBuyTransactionId || contract.transaction_ids?.buy || null,
                    sell: derivSellTransactionId || contract.transaction_ids?.sell || null,
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
                analyzer_exit_quote: Number.isFinite(analyzerExitQuoteValue) ? analyzerExitQuoteValue : null,
                analyzer_exit_digit: Number.isInteger(settledExitDigit) ? settledExitDigit : null,
                analyzer_exit_status: 'EARLY_SELL_READY',
                sell_price: payout,
                bid_price: Number.isFinite(derivSettlement?.bid_price)
                    ? Number(derivSettlement.bid_price)
                    : payout,
                payout,
                profit: finalProfit,
                deriv_contract_id: this.derivContractId || contract.deriv_contract_id || null,
                deriv_transaction_id: derivBuyTransactionId || contract.deriv_transaction_id || null,
                deriv_sell_transaction_id: derivSellTransactionId || contract.deriv_sell_transaction_id || null,
                deriv_sell_price: Number.isFinite(derivPayout) ? derivPayout : null,
                deriv_balance_after_sell: Number.isFinite(Number(derivSettlement?.balance_after))
                    ? Number(derivSettlement.balance_after)
                    : null,
                financial_status: 'DERIV_SELL_CONFIRMED',
                exit_spot: Number.isFinite(analyzerExitQuoteValue) ? analyzerExitQuoteValue : derivExitSpot,
                exit_tick: Number.isFinite(derivExitSpot)
                    ? Math.abs(Math.trunc(derivExitSpot * 100)) % 10
                    : Number.isInteger(exitDigit)
                      ? exitDigit
                      : null,
                exit_tick_time: Number.isFinite(derivExitSpotTime)
                    ? Math.floor(derivExitSpotTime)
                    : Math.floor(settledAtMs / 1000),
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
                    settlementSource: 'ANALYZER_EARLY_SELL',
                    analyzerContractId: contractId,
                    analyzerEntryCode: this.data.contract.analyzer_entry_code,
                    analyzerExitCode: this.data.contract.analyzer_exit_code,
                    analyzerEntryQuote: this.data.contract.analyzer_entry_quote,
                    analyzerExitQuote: this.data.contract.analyzer_exit_quote,
                    derivExitSpot: this.data.contract.exit_spot,
                    payout,
                    profit: finalProfit,
                    derivPayout: Number.isFinite(derivPayout) ? derivPayout : null,
                    derivBalanceAfterSell: Number.isFinite(Number(derivSettlement?.balance_after))
                        ? Number(derivSettlement.balance_after)
                        : null,
                    exit: exit || analyzerState.exit,
                },
            });

            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            globalObserver.emit(
                'ui.log',
                `TRAPKID ANALYZER EXIT EXECUTED → ${contractId} → Deriv proceeds=${payout} → profit=${finalProfit}`
            );

            if (this.afterPromise) {
                this.afterPromise();
                this.afterPromise = null;
            }

            this.store.dispatch(sell());
            return true;
        }
    };
