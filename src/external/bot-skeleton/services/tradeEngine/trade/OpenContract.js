export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            // Analyzer owns the complete contract lifecycle. No Deriv
            // proposal_open_contract subscription is created.
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick } = contract;

            this.isSold = Boolean(is_sold);
            this.isSellAvailable = !this.isSold && Boolean(is_valid_to_sell);
            this.isExpired = Boolean(is_expired);
            this.hasEntryTick = Boolean(entry_tick);
        }

        expectedContractId(contractId) {
            return this.contractId && contractId === this.contractId;
        }

        getSellPrice() {
            const contract = this.data?.contract || {};
            return Number(contract.sell_price || 0) - Number(contract.buy_price || 0);
        }
    };
