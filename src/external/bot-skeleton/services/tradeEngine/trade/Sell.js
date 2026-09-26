import { contractStatus } from '../utils/broadcast';
import { sell } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            return Boolean(this.contractId && !this.isSold);
        }

        sellAtMarket(source = 'BLOCKLY') {
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
            const stake = Number(contract.buy_price ?? this.tradeOptions?.amount ?? 0);

            const payoutValue = Number(
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
            const payout = Number.isFinite(payoutValue) ? payoutValue : stake;

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

            this.data.contract = {
                ...contract,
                contract_id: contractId,
                transaction_ids: {
                    ...(contract.transaction_ids || {}),
                    sell: contract.transaction_ids?.sell || contractId,
                },
                analyzer_contract_id: contractId,
                analyzer_entry_code:
                    this.tradeOptions?.analyzerEntryCode ||
                    analyzerSignal?.entryCode ||
                    analyzerSignal?.entry_code ||
                    analyzerSignal?.signalId,
                analyzer_exit_code:
                    exit?.exitCode ||
                    analyzerState?.exit?.exitCode ||
                    analyzerSignal?.exitCode ||
                    null,
                analyzer_entry_quote:
                    this.tradeOptions?.analyzerEntryQuote ??
                    analyzerSignal?.entryQuote ??
                    analyzerSignal?.entry_quote ??
                    analyzerSignal?.quote,
                analyzer_exit_quote: Number.isFinite(exitQuoteValue) ? exitQuoteValue : null,
                sell_price: payout,
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
                data: contractId,
                contract: this.data.contract,
            });

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
                    profit: payout - stake,
                    exit: exit || analyzerState.exit,
                },
            });

            globalObserver.emit('trapkid.analyzer.updated', globalObserver.getState('trapkid_analyzer'));
            globalObserver.emit(
                'ui.log',
                `TRAPKID ANALYZER SETTLED → ${contractId} → payout=${payout}`
            );

            if (this.afterPromise) {
                this.afterPromise();
                this.afterPromise = null;
            }

            this.store.dispatch(sell());
            return Promise.resolve();
        }
    };
