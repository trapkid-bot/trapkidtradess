import { getFormattedText } from '@/components/shared';
import { info } from '../utils/broadcast';
import { observer as globalObserver } from '../../../utils/observer';

let balance_string = '';

export default Engine =>
    class Balance extends Engine {
        observeBalance() {
            // Analyzer-only: balance is local Analyzer state, never a Deriv
            // balance subscription.
        }

        // eslint-disable-next-line class-methods-use-this
        getBalance(type) {
            const state = globalObserver.getState('trapkid_analyzer') || {};
            const balance = Number(state.analyzerBalance ?? state.balance ?? 0);
            const currency = state.currency || 'USD';

            balance_string = getFormattedText(balance, currency, false);
            return type === 'STR' ? balance_string : balance;
        }
    };
