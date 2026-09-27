// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Text from '@/components/shared_ui/text';
import { getContractTypeDisplay } from '@/constants/contract';
import { useStore } from '@/hooks/useStore';
import { getSymbolDisplayNameSync } from '@/utils/symbol-display-name';
import { localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import ContractCardLoader from '../contract-card-loading';
import { getCardLabels } from '../shared';
import ContractCard from '../shared_ui/contract-card';
import { TSummaryCardProps } from './summary-card.types';

const SummaryCard = observer(({ contract_info, is_contract_loading, is_bot_running }: TSummaryCardProps) => {
    const { summary_card, run_panel, ui, common } = useStore();
    const { is_contract_completed, is_contract_inactive, is_multiplier, is_accumulator, setIsBotRunning } =
        summary_card;
    const { onClickSell, is_sell_requested, contract_stage } = run_panel;
    const { addToast, current_focus, removeToast, setCurrentFocus } = ui;
    const { server_time } = common;

    const { isDesktop } = useDevice();

    React.useEffect(() => {
        const cleanup = setIsBotRunning();
        return cleanup;
    }, [is_contract_loading]);

    const card_header = (
        <ContractCard.Header
            contract_info={contract_info}
            display_name={
                (contract_info as any)?.underlying_symbol
                    ? getSymbolDisplayNameSync((contract_info as any).underlying_symbol)
                    : ''
            }
            getCardLabels={getCardLabels}
            getContractTypeDisplay={getContractTypeDisplay}
            has_progress_slider={!is_multiplier}
            is_sold={is_contract_completed}
            server_time={server_time}
        />
    );

    const card_body = (
        <ContractCard.Body
            addToast={addToast}
            contract_info={contract_info}
            currency={contract_info?.currency ?? ''}
            current_focus={current_focus}
            error_message_alignment='left'
            getCardLabels={getCardLabels}
            getContractById={() => summary_card}
            is_mobile={!isDesktop}
            is_multiplier={is_multiplier}
            is_accumulator={is_accumulator}
            is_sold={is_contract_completed}
            removeToast={removeToast}
            server_time={server_time}
            setCurrentFocus={setCurrentFocus}
        />
    );

    const card_footer = (
        <ContractCard.Footer
            contract_info={contract_info}
            getCardLabels={getCardLabels}
            is_multiplier={is_multiplier}
            is_sell_requested={is_sell_requested}
            onClickSell={onClickSell}
        />
    );

    const contract_el = (
        <React.Fragment>
            {card_header}
            {card_body}
            {card_footer}
        </React.Fragment>
    );

    return (
        <div
            className={classNames('db-summary-card', {
                'db-summary-card--mobile': !isDesktop,
                'db-summary-card--inactive': is_contract_inactive && !is_contract_loading && !contract_info,
                'db-summary-card--completed': is_contract_completed,
                'db-summary-card--completed-mobile': is_contract_completed && !isDesktop,
                'db-summary-card--delayed-loading': is_bot_running,
            })}
            data-testid='dt_mock_summary_card'
        >
            {is_contract_loading && !is_bot_running && <ContractCardLoader speed={2} />}
            {is_bot_running && !contract_info && <ContractCardLoader speed={2} contract_stage={contract_stage} />}
            {!is_contract_loading && contract_info && (
                <ContractCard
                    contract_info={contract_info}
                    getCardLabels={getCardLabels}
                    is_multiplier={is_multiplier}
                    profit_loss={contract_info.profit}
                    should_show_result_overlay={true}
                >
                    <div
                        className={classNames('dc-contract-card', {
                            'dc-contract-card--green': contract_info.profit > 0,
                            'dc-contract-card--red': contract_info.profit < 0,
                        })}
                    >
                        {contract_el}
                        {(contract_info as any)?.analyzer_source === 'ANALYZER_ONLY' && (
                            <div
                                style={{
                                    margin: '0 12px 12px',
                                    padding: '10px 12px',
                                    borderRadius: 8,
                                    background: 'var(--general-section-1)',
                                    border: '1px solid var(--general-section-2)',
                                }}
                            >
                                <div style={{ fontWeight: 700, marginBottom: 6 }}>TRAPKID ANALYZER → DBOT</div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12 }}>
                                    <span>Market: <b>{(contract_info as any)?.underlying_symbol || '—'}</b></span>
                                    <span>Prediction / Hot: <b>{(contract_info as any)?.analyzer_hot_digit ?? (contract_info as any)?.prediction ?? '—'}</b></span>
                                    <span>Entry digit: <b>{(contract_info as any)?.analyzer_entry_digit ?? '—'}</b></span>
                                    <span>Locked entry quote: <b>{(contract_info as any)?.analyzer_entry_quote ?? (contract_info as any)?.analyzer_locked_quote ?? '—'}</b></span>
                                    <span>Execution: <b>1 tick DIGITMATCH</b></span>
                                    <span>Lifecycle: <b>{(contract_info as any)?.analyzer_execution_status || 'EARLY_SELL_READY'}</b></span>
                                </div>
                            </div>
                        )} 
                    </div>
                </ContractCard>
            )}
            {!is_contract_loading && !contract_info && !is_bot_running && (
                <Text as='p' align='center' lineHeight='s' size='xs'>
                    {localize('When you’re ready to trade, hit ')}
                    <strong className='summary-panel-inactive__strong'>{localize('Run')}</strong>
                    {localize('. You’ll be able to track your bot’s performance here.')}
                </Text>
            )}
        </div>
    );
});

export default SummaryCard;
