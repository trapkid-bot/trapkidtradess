// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { formatDate, isEnded } from '@/components/shared';
import { LogTypes } from '@/external/bot-skeleton';
import { ProposalOpenContract } from '@deriv/api-types';
import { TPortfolioPosition, TStores } from '@deriv/stores/types';
import { TContractInfo } from '../components/summary/summary-card.types';
import { transaction_elements } from '../constants/transactions';
import { getStoredItemsByKey, getStoredItemsByUser, setStoredItemsByKey } from '../utils/session-storage';
import RootStore from './root-store';
import { observer as globalObserver } from '../external/bot-skeleton/utils/observer';

type TTransaction = {
    type: string;
    data?: string | TContractInfo;
};

type TElement = {
    [key: string]: TTransaction[];
};

export default class TransactionsStore {
    root_store: RootStore;
    core: TStores;
    disposeReactionsFn: () => void;
    deriv_ledger: Record<string, any> = {};

    constructor(root_store: RootStore, core: TStores) {
        this.root_store = root_store;
        this.core = core;
        this.is_transaction_details_modal_open = false;

        makeObservable(this, {
            elements: observable,
            active_transaction_id: observable,
            recovered_completed_transactions: observable,
            recovered_transactions: observable,
            is_called_proposal_open_contract: observable,
            is_transaction_details_modal_open: observable,
            transactions: computed,
            onBotContractEvent: action.bound,
            pushTransaction: action.bound,
            clear: action.bound,
            registerReactions: action.bound,
            recoverPendingContracts: action.bound,
            updateResultsCompletedContract: action.bound,
            sortOutPositionsBeforeAction: action.bound,
            recoverPendingContractsById: action.bound,
            onDerivBuyEvent: action.bound,
            onDerivOpenContractEvent: action.bound,
            onDerivSellEvent: action.bound,
        });

        // MobX must finish binding action methods before reactions and Observer
        // listeners capture them. This also keeps teardown using the same bound refs.
        this.disposeReactionsFn = this.registerReactions();

        globalObserver.register('deriv.contract.buy', this.onDerivBuyEvent);
        globalObserver.register('deriv.contract.open', this.onDerivOpenContractEvent);
        globalObserver.register('deriv.contract.sell', this.onDerivSellEvent);
    }
    TRANSACTION_CACHE = 'transaction_cache';

    elements: TElement = getStoredItemsByUser(this.TRANSACTION_CACHE, this.core?.client?.loginid, []);
    active_transaction_id: null | number = null;
    recovered_completed_transactions: number[] = [];
    recovered_transactions: number[] = [];
    is_called_proposal_open_contract = false;
    is_transaction_details_modal_open = false;

    get transactions(): TTransaction[] {
        if (this.core?.client?.loginid) return this.elements[this.core?.client?.loginid] ?? [];
        return [];
    }

    get statistics() {
        let total_runs = 0;
        // Filter out only contract transactions and remove dividers
        const trxs = this.transactions.filter(
            trx => trx.type === transaction_elements.CONTRACT && typeof trx.data === 'object'
        );
        const statistics = trxs.reduce(
            (stats, { data }) => {
                const contract = data as TContractInfo;
                const profit = Number(contract.profit) || 0;
                const is_completed = contract.is_completed || false;
                const buy_price = Number(contract.buy_price) || 0;
                const payout = Number(contract.payout) || Number(contract.bid_price) || 0;
                const bid_price = Number(contract.bid_price) || 0;

                if (is_completed) {
                    if (profit > 0) {
                        stats.won_contracts += 1;
                        stats.total_payout += payout ?? bid_price ?? 0;
                    } else {
                        stats.lost_contracts += 1;
                    }
                    stats.total_profit += profit;
                    stats.total_stake += buy_price;
                    total_runs += 1;
                }
                return stats;
            },
            {
                lost_contracts: 0,
                number_of_runs: 0,
                total_profit: 0,
                total_payout: 0,
                total_stake: 0,
                won_contracts: 0,
            }
        );
        statistics.number_of_runs = total_runs;
        return statistics;
    }

    toggleTransactionDetailsModal = (is_open: boolean) => {
        this.is_transaction_details_modal_open = is_open;
    };

    onBotContractEvent(data: TContractInfo) {
        this.pushTransaction(data);
    }

    private findDerivTransactionIndex(ledger: any) {
        const account = this.core?.client?.loginid as string;
        const items = this.elements[account] || [];
        const localId = String(ledger?.local_contract_id || '');
        const derivId = String(ledger?.contract_id || ledger?.deriv_contract_id || '');
        const buyTransactionId = String(
            ledger?.buy_transaction_id || ledger?.transaction_ids?.buy || ledger?.transaction_id || ''
        );

        return items.findIndex(item => {
            if (item.type !== transaction_elements.CONTRACT || typeof item.data === 'string') return false;
            const data: any = item.data;
            return (
                (localId && String(data.contract_id || '') === localId) ||
                (derivId && String(data.deriv_contract_id || '') === derivId) ||
                (derivId && String(data.contract_id || '') === derivId) ||
                (buyTransactionId && String(data.transaction_ids?.buy || '') === buyTransactionId) ||
                (buyTransactionId && String(data.deriv_transaction_id || '') === buyTransactionId)
            );
        });
    }

    private getDerivLedgerForContract(data: any) {
        const keys = [
            data?.deriv_contract_id,
            data?.contract_id,
            data?.analyzer_contract_id,
            data?.transaction_ids?.buy,
        ]
            .filter(value => value !== undefined && value !== null && String(value) !== '')
            .map(value => String(value));

        for (const key of keys) {
            if (this.deriv_ledger[key]) return this.deriv_ledger[key];
        }
        return null;
    }

    private storeDerivLedger(event: any) {
        const ledger = event || {};
        const keys = [
            ledger.contract_id,
            ledger.deriv_contract_id,
            ledger.local_contract_id,
            ledger.buy_transaction_id,
            ledger.transaction_id,
        ]
            .filter(value => value !== undefined && value !== null && String(value) !== '')
            .map(value => String(value));

        keys.forEach(key => {
            this.deriv_ledger[key] = ledger;
        });

        return ledger;
    }

    private mergeDerivLedgerIntoContract(data: any, ledger: any) {
        if (!ledger) return data;
        const merged = { ...data };
        if (Number.isFinite(Number(ledger.buy_price))) merged.buy_price = Number(ledger.buy_price);
        if (Number.isFinite(Number(ledger.bid_price))) merged.bid_price = Number(ledger.bid_price);
        if (Number.isFinite(Number(ledger.payout))) merged.payout = Number(ledger.payout);
        if (Number.isFinite(Number(ledger.profit))) merged.profit = Number(ledger.profit);
        if (ledger.currency) merged.currency = ledger.currency;
        if (Number.isFinite(Number(ledger.balance_after))) {
            merged.balance_after = Number(ledger.balance_after);
            merged.deriv_balance_after = Number(ledger.balance_after);
        }
        if (Number.isFinite(Number(ledger.exit_spot))) merged.exit_spot = Number(ledger.exit_spot);
        if (Number.isFinite(Number(ledger.exit_spot_time))) merged.exit_spot_time = Number(ledger.exit_spot_time);
        if (Number.isFinite(Number(ledger.entry_spot))) merged.entry_spot = Number(ledger.entry_spot);
        if (Number.isFinite(Number(ledger.entry_spot_time))) merged.entry_spot_time = Number(ledger.entry_spot_time);
        if (ledger.status) merged.deriv_status = ledger.status;
        if (ledger.is_sold !== undefined) merged.deriv_is_sold = ledger.is_sold;
        if (ledger.is_expired !== undefined) merged.deriv_is_expired = ledger.is_expired;
        if (ledger.contract_id) merged.deriv_contract_id = String(ledger.contract_id);
        if (ledger.buy_transaction_id || ledger.transaction_id) {
            merged.transaction_ids = {
                ...(merged.transaction_ids || {}),
                buy: ledger.buy_transaction_id || merged.transaction_ids?.buy,
            };
            merged.deriv_transaction_id = ledger.buy_transaction_id || ledger.transaction_id;
        }
        if (ledger.transaction_ids?.buy || ledger.buy_transaction_id) {
            merged.transaction_ids = {
                ...(merged.transaction_ids || {}),
                buy: ledger.transaction_ids?.buy || ledger.buy_transaction_id,
            };
            merged.deriv_transaction_id = ledger.transaction_ids?.buy || ledger.buy_transaction_id;
        }
        if (ledger.transaction_ids?.sell || ledger.sell_transaction_id) {
            merged.transaction_ids = {
                ...(merged.transaction_ids || {}),
                sell: ledger.transaction_ids?.sell || ledger.sell_transaction_id,
            };
            merged.deriv_sell_transaction_id = ledger.transaction_ids?.sell || ledger.sell_transaction_id;
        }
        if (Number.isFinite(Number(ledger.sold_for))) {
            merged.sell_price = Number(ledger.sold_for);
            merged.bid_price = Number(ledger.sold_for);
            merged.payout = Number(ledger.sold_for);
        }
        if (ledger.financial_status) merged.financial_status = ledger.financial_status;
        return merged;
    }

    onDerivBuyEvent(event: any) {
        const key = String(event?.contract_id || event?.local_contract_id || '');
        if (!key) return;
        const ledger = {
            ...(this.deriv_ledger[key] || {}),
            ...event,
            buy_transaction_id: event.buy_transaction_id || event.transaction_id || this.deriv_ledger[key]?.buy_transaction_id,
            balance_after: event.balance_after ?? this.deriv_ledger[key]?.balance_after,
            financial_status: 'DERIV_BUY_CONFIRMED',
        };
        this.storeDerivLedger(ledger);
        const account = this.core?.client?.loginid as string;
        const index = this.findDerivTransactionIndex(ledger);
        if (index >= 0) {
            const current = this.elements[account][index];
            this.elements[account].splice(index, 1, {
                ...current,
                data: this.mergeDerivLedgerIntoContract(current.data, ledger),
            });
            this.elements = { ...this.elements };
        }
    }

    onDerivOpenContractEvent(event: any) {
        const key = String(event?.contract_id || '');
        if (!key) return;
        const previous = this.deriv_ledger[key] || {};
        const ledger = {
            ...previous,
            ...event,
            financial_status: event?.is_closed ? 'DERIV_SETTLEMENT_CONFIRMED' : 'DERIV_OPEN_CONTRACT',
        };
        this.deriv_ledger[key] = ledger;
        const account = this.core?.client?.loginid as string;
        const index = this.findDerivTransactionIndex(ledger);
        if (index >= 0) {
            const current = this.elements[account][index];
            this.elements[account].splice(index, 1, {
                ...current,
                data: this.mergeDerivLedgerIntoContract(current.data, ledger),
            });
            this.elements = { ...this.elements };
        }
    }

    onDerivSellEvent(event: any) {
        const key = String(event?.contract_id || '');
        if (!key) return;
        const ledger = {
            ...(this.deriv_ledger[key] || {}),
            ...event,
            sell_transaction_id: event.sell_transaction_id || event.transaction_id || this.deriv_ledger[key]?.sell_transaction_id,
            balance_after: event.balance_after ?? this.deriv_ledger[key]?.balance_after,
            financial_status: 'DERIV_SELL_CONFIRMED',
        };
        this.deriv_ledger[key] = ledger;
        const account = this.core?.client?.loginid as string;
        const index = this.findDerivTransactionIndex(ledger);
        if (index >= 0) {
            const current = this.elements[account][index];
            this.elements[account].splice(index, 1, {
                ...current,
                data: this.mergeDerivLedgerIntoContract(current.data, ledger),
            });
            this.elements = { ...this.elements };
        }
    }

    pushTransaction(data: TContractInfo) {
        const ledger = this.getDerivLedgerForContract(data);
        if (ledger) data = this.mergeDerivLedgerIntoContract(data, ledger);
        const isAnalyzerOnly = String((data as any).analyzer_source || '') === 'ANALYZER_ONLY';
        const settlementConfirmed = [
            'ANALYZER_SIMULATED_SETTLEMENT',
            'DERIV_SELL_CONFIRMED',
            'DERIV_SETTLEMENT_CONFIRMED',
            'DERIV_SETTLEMENT_RECONCILED',
        ].includes(String((data as any).financial_status || ''));
        const is_completed = isAnalyzerOnly
            ? settlementConfirmed && isEnded(data as ProposalOpenContract)
            : isEnded(data as ProposalOpenContract);
        const { run_id } = this.root_store.run_panel;
        const current_account = this.core?.client?.loginid as string;

        const contract: TContractInfo = {
            ...data,
            is_completed,
            run_id,
            date_start: formatDate(data.date_start, 'YYYY-M-D HH:mm:ss [GMT]'),
            entry_tick: data.entry_spot,
            entry_tick_time: data.entry_tick_time && formatDate(data.entry_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            exit_tick: (data as any).exit_spot || data.exit_tick,
            exit_tick_time: data.exit_tick_time && formatDate(data.exit_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            profit: is_completed ? data.profit : 0,
        };

        if (!this.elements[current_account]) {
            this.elements = {
                ...this.elements,
                [current_account]: [],
            };
        }

        const same_contract_index = this.elements[current_account]?.findIndex(c => {
            if (typeof c.data === 'string') return false;
            return (
                c.type === transaction_elements.CONTRACT &&
                c.data?.transaction_ids &&
                c.data.transaction_ids.buy === data.transaction_ids?.buy
            );
        });

        if (same_contract_index === -1) {
            // Render a divider if the "run_id" for this contract is different.
            if (this.elements[current_account]?.length > 0) {
                const temp_contract = this.elements[current_account]?.[0];
                const is_contract = temp_contract.type === transaction_elements.CONTRACT;
                const is_new_run =
                    is_contract &&
                    typeof temp_contract.data === 'object' &&
                    contract.run_id !== temp_contract?.data?.run_id;

                if (is_new_run) {
                    this.elements[current_account]?.unshift({
                        type: transaction_elements.DIVIDER,
                        data: contract.run_id,
                    });
                }
            }

            this.elements[current_account]?.unshift({
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        } else {
            // If data belongs to existing contract in memory, update it.
            this.elements[current_account]?.splice(same_contract_index, 1, {
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        }

        this.elements = { ...this.elements }; // force update
    }

    clear() {
        if (this.elements && this.elements[this.core?.client?.loginid as string]?.length > 0) {
            this.elements[this.core?.client?.loginid as string] = [];
        }
        this.recovered_completed_transactions = this.recovered_completed_transactions?.slice(0, 0);
        this.recovered_transactions = this.recovered_transactions?.slice(0, 0);
        this.is_transaction_details_modal_open = false;
    }

    registerReactions() {
        const { client } = this.core;

        // Write transactions to session storage on each change in transaction elements.
        const disposeTransactionElementsListener = reaction(
            () => this.elements[client?.loginid as string],
            elements => {
                const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                stored_transactions[client.loginid as string] = elements?.slice(0, 5000) ?? [];
                setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
            }
        );

        // User could've left the page mid-contract. On initial load, try
        // to recover any pending contracts so we can reflect accurate stats
        // and transactions.
        const disposeRecoverContracts = reaction(
            () => this.transactions.length,
            () => this.recoverPendingContracts()
        );

        return () => {
            disposeTransactionElementsListener();
            disposeRecoverContracts();
            globalObserver.unregister('deriv.contract.buy', this.onDerivBuyEvent);
            globalObserver.unregister('deriv.contract.open', this.onDerivOpenContractEvent);
            globalObserver.unregister('deriv.contract.sell', this.onDerivSellEvent);
        };
    }

    recoverPendingContracts(contract = null) {
        this.transactions.forEach(({ data: trx }) => {
            if (
                typeof trx === 'string' ||
                trx?.is_completed ||
                !trx?.contract_id ||
                this.recovered_transactions.includes(trx?.contract_id)
            )
                return;
            this.recoverPendingContractsById(trx.contract_id, contract);
        });
    }

    updateResultsCompletedContract(contract: ProposalOpenContract) {
        const { journal, summary_card } = this.root_store;
        const { contract_info } = summary_card;
        const { currency, profit } = contract;

        if (contract.contract_id !== contract_info?.contract_id) {
            this.onBotContractEvent(contract);

            if (contract.contract_id && !this.recovered_transactions.includes(contract.contract_id)) {
                this.recovered_transactions.push(contract.contract_id);
            }
            if (
                contract.contract_id &&
                !this.recovered_completed_transactions.includes(contract.contract_id) &&
                isEnded(contract)
            ) {
                this.recovered_completed_transactions.push(contract.contract_id);

                const analyzerOnly = String((contract as any).analyzer_source || '') === 'ANALYZER_ONLY';
                const financialStatus = String((contract as any).financial_status || '');
                const derivSettled = [
                    'DERIV_SELL_CONFIRMED',
                    'DERIV_SETTLEMENT_CONFIRMED',
                    'DERIV_SETTLEMENT_RECONCILED',
                ].includes(financialStatus);
                if (!analyzerOnly || derivSettled || financialStatus === 'ANALYZER_SIMULATED_SETTLEMENT') {
                    journal.onLogSuccess({
                        log_type: profit && profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
                        extra: { currency, profit },
                    });
                }
            }
        }
    }

    sortOutPositionsBeforeAction(positions: TPortfolioPosition[], element_id?: number) {
        positions?.forEach(position => {
            if (!element_id || (element_id && position.id === element_id)) {
                const contract_details = position.contract_info;
                this.updateResultsCompletedContract(contract_details);
            }
        });
    }

    async recoverPendingContractsById(contract_id: number, contract: ProposalOpenContract | null = null) {
        // TODO: need to fix as the portfolio is not available now
        // const positions = this.core.portfolio.positions;
        const positions: unknown[] = [];

        if (contract) {
            this.is_called_proposal_open_contract = true;
            if (contract.contract_id === contract_id) {
                this.updateResultsCompletedContract(contract);
            }
        }

        if (!this.is_called_proposal_open_contract) {
            if (this.core?.client?.loginid) {
                const current_account = this.core?.client?.loginid;
                if (!this.elements[current_account]?.length) {
                    this.sortOutPositionsBeforeAction(positions);
                }

                const elements = this.elements[current_account];
                const [element = null] = elements;
                if (typeof element?.data === 'object' && !element?.data?.profit) {
                    const element_id = element.data.contract_id;
                    this.sortOutPositionsBeforeAction(positions, element_id);
                }
            }
        }
    }
}
