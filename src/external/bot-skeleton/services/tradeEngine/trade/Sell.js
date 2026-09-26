import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { contractStatus, log } from '../utils/broadcast';
import { doUntilDone, recoverFromError } from '../utils/helpers';
import { DURING_PURCHASE } from './state/constants';
import { sell } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return this.contractId && !this.isSold && this.isSellAvailable && !this.isExpired;
        }

        sellAtMarket(source = 'BLOCKLY') {
            const analyzerState = globalObserver.getState('trapkid_analyzer') || {};
            const analyzerSignal = this.analyzerSignal || analyzerState.signal;
            const analyzerActive =
                !!analyzerSignal?.signalId &&
                String(analyzerState.commandKey || '') ===
                    String(analyzerSignal.signalId) + ':' + String(analyzerSignal.lockedAt) &&
                ['COMMAND_ACCEPTED', 'COMMAND_RECEIVED', 'ANALYZER_EXECUTION', 'ANALYZER_TRADE_LOCKED', 'ANALYZER_PURCHASE_AUTHORIZED', 'ANALYZER_PURCHASE_BOUND', 'RUNNING', 'EARLY_EXIT_COMMAND_RECEIVED', 'WAITING_FOR_ANALYZER_EXIT_DIGIT', 'EARLY_EXIT_EXECUTING'].includes(
                    String(analyzerState.status || '')
                );

            const analyzerEarlySell = source === 'ANALYZER_EARLY_SELL';

            if (
                analyzerActive &&
                !analyzerEarlySell &&
                String(analyzerState.executionTrigger || '') !== 'EARLY_SELL_READY'
            ) {
                // Analyzer owns the position. Builder/manual selling is blocked.
                // The Analyzer EARLY_SELL_READY handler calls this method with
                // ANALYZER_EARLY_SELL, so it must never be blocked by the
                // normal Builder/manual sell gate.
                return Promise.resolve();
            }

            globalObserver.emit('bot.sell');

            // Analyzer early-sell is allowed to close the already-purchased
            // Analyzer contract even if the legacy Builder Redux scope has
            // already moved away from DURING_PURCHASE.
            // Normal Builder/manual sells keep the original scope gate.
            if (this.store.getState().scope !== DURING_PURCHASE && !analyzerEarlySell) {
                return Promise.resolve();
            }

            if (!this.isSellAtMarketAvailable(analyzerEarlySell)) {
                log(LogTypes.NOT_OFFERED);
                return Promise.resolve();
            }

            // Analyzer-only settlement: no Deriv SELL request, no broker
            // contract lookup, and no broker expiry/settlement state.
            if (analyzerEarlySell && analyzerActive) {
                const signal = analyzerSignal;
                const exit = this.getAnalyzerExit?.();
                const contract = this.data?.contract || {};
                const stake = Number(contract.buy_price ?? this.tradeOptions?.amount ?? 0);
                const analyzerPayout = Number(
                    exit?.payout ??
                    exit?.sellPrice ??
                    exit?.sell_price ??
                    analyzerState?.exit?.payout ??
                    analyzerState?.exit?.sellPrice ??
                    analyzerState?.exit?.sell_price ??
                    signal?.payout ??
                    signal?.sellPrice ??
                    signal?.sell_price
                );
                const payout = Number.isFinite(analyzerPayout) ? analyzerPayout : stake;
                const exitQuote = Number(exit?.quote ?? analyzerState?.exit?.quote);
                const soldFor = payout;
                const contractId =
                    String(
                        this.analyzerContractId ||
                        this.tradeOptions?.analyzerContractId ||
                        signal?.contractId ||
                        signal?.contract_id ||
                        this.contractId ||
                        signal?.entryCode ||
                        signal?.signalId
                    );

                this.data.contract = {
                    ...contract,
                    contract_id: contractId,
                    transaction_ids: {
                        ...(contract.transaction_ids || {}),
                        buy: contract.transaction_ids?.buy || String(
                            this.tradeOptions?.analyzerEntryCode || signal?.entryCode || signal?.signalId
                        ),
                        sell: contract.transaction_ids?.sell || contractId,
                    },
                    analyzer_contract_id: contractId,
                    analyzer_entry_code:
                        this.tradeOptions?.analyzerEntryCode ||
                        signal?.entryCode ||
                        signal?.entry_code ||
                        signal?.signalId,
                    analyzer_exit_code:
                        exit?.exitCode ||
                        analyzerState?.exit?.exitCode ||
                        signal?.exitCode ||
                        null,
                    analyzer_entry_quote:
                        this.tradeOptions?.analyzerEntryQuote ??
                        signal?.entryQuote ??
                        signal?.entry_quote ??
                        signal?.quote,
                    analyzer_exit_quote: Number.isFinite(exitQuote) ? exitQuote : null,
                    sell_price: soldFor,
                    status: 'sold',
                    is_sold: true,
                    is_expired: false,
                    is_valid_to_sell: false,
                };

                this.isSold = true;
                this.isExpired = false;
                this.isSellAvailable = false;
                this.contractId = '';
                this.updateTotals(this.data.contract);
                contractStatus({
                    id: 'contract.sold',
                    data: this.data.contract.transaction_ids.sell,
                    contract: this.data.contract,
                });

                globalObserver.setState({
                    trapkid_analyzer: {
                        ...analyzerState,
                        status: 'ANALYZER_SETTLED',
                        signal,
                        signalId: signal?.signalId,
                        commandKey: analyzerState.commandKey,
                        executionTrigger: 'ANALYZER_SETTLED',
                        holdUntilAnalyzerExit: false,
                        settlementSource: 'ANALYZER',
                        analyzerContractId: contractId,
                        analyzerEntryCode: this.data.contract.analyzer_entry_code,
                        analyzerExitCode: this.data.contract.analyzer_exit_code,
                        analyzerEntryQuote: this.data.contract.analyzer_entry_quote,
                        analyzerExitQuote: this.data.contract.analyzer_exit_quote,
                        payout: soldFor,
                        profit: soldFor - stake,
                        exit: exit || analyzerState.exit,
                    },
                });
                globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
                globalObserver.emit('ui.log', `TRAPKID ANALYZER SETTLED → ${contractId} → payout=${soldFor}`);

                if (this.afterPromise) {
                    this.afterPromise();
                    this.afterPromise = null;
                }
                this.store.dispatch(sell());
                this.waitForAfter = () => Promise.resolve();
                return Promise.resolve();
            }

            return Promise.resolve();

        }
    };
