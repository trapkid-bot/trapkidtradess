import React from 'react';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';

// Public Analyzer endpoint used by the Render site. Keep this direct so the browser connects to the Analyzer itself.
const ANALYZER_API = 'https://copper-philosophy-smart-competition.trycloudflare.com';
const ANALYZER_STATUS_URL = ANALYZER_API + '/api/status';
const LINK_VERSION = 'ANALYZER-DBOT-BRIDGE-01';

const TrapKidAnalyzerDock = () => {
    const [details, setDetails] = React.useState<any>(null);
    // Automatic connection: never depend on a manually entered URL or localStorage.
    // The Render site always watches the known Analyzer endpoint below.
    const [analyzerApi] = React.useState(ANALYZER_API);
    const [connectionError, setConnectionError] = React.useState('');
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState({ x: 22, y: 120 });
    const [lastSeen, setLastSeen] = React.useState<number | null>(null);
    const [executionState, setExecutionState] = React.useState<any>(() => (
        globalObserver.getState('trapkid_analyzer') || {}
    ));
    const drag = React.useRef<{ dx: number; dy: number } | null>(null);
    const analyzerSignalKeyRef = React.useRef<string | null>(null);
    const analyzerExitKeyRef = React.useRef<string | null>(null);
    const mountedAtRef = React.useRef(Date.now());

    React.useEffect(() => {
        let cancelled = false;
        let polling = false;
        let publishedKey = '';

        const poll = async () => {
            if (cancelled || polling) return;
            polling = true;
            try {
                const res = await fetch(ANALYZER_STATUS_URL + '?client=global-link&t=' + Date.now(), {
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                if (!cancelled) {
                    const now = Date.now();
                    setDetails(data);
                    setLastSeen(now);
                    setConnectionError('');

                    const signal = data?.signal;
                    const signalId = String(signal?.signalId || '');
                    const lockedAt = Number(signal?.lockedAt);
                    const signalKey = signalId
                        ? signalId + ':' + (Number.isFinite(lockedAt) ? lockedAt : '')
                        : '';

                    const previousSignalKey = analyzerSignalKeyRef.current;
                    const isFirstSignal = previousSignalKey === null;
                    const isNewSignal = !!signalKey && !isFirstSignal && previousSignalKey !== signalKey;
                    const initialSignalIsFresh =
                        isFirstSignal &&
                        Number.isFinite(lockedAt) &&
                        lockedAt >= mountedAtRef.current - 10000;

                    const analyzerStatus = String(data?.status || signal?.status || '').toUpperCase();
                    const explicitReady =
                        data?.entryReady === true ||
                        signal?.entryReady === true ||
                        analyzerStatus === 'READY' ||
                        String(signal?.status || '').toUpperCase() === 'READY' ||
                        String(data?.command?.status || '').toUpperCase() === 'READY';

                    // The user's Analyze click is represented by Analyzer creating
                    // a fresh LOCKED signal. No second READY button/command is
                    // required. A fresh lock is executable exactly once.
                    const lockStillFresh =
                        Number.isFinite(lockedAt) &&
                        (!Number.isFinite(Number(signal?.expiresAt)) ||
                            Date.now() < Number(signal.expiresAt));
                    const analyzeCreatedLock =
                        !!signalKey &&
                        !!signal?.signalId &&
                        !!signal?.symbol &&
                        Number.isInteger(Number(signal?.hotDigit ?? signal?.prediction ?? signal?.lockedDigit)) &&
                        lockStillFresh &&
                        (isNewSignal ||
                            initialSignalIsFresh ||
                            ['LOCKED', 'SIGNAL_LOCKED', 'ANALYZED'].includes(String(signal?.status || '').toUpperCase()) ||
                            ['LOCKED', 'SIGNAL_LOCKED', 'ANALYZED'].includes(analyzerStatus));

                    const entryReady = explicitReady || analyzeCreatedLock;

                    const currentAnalyzerState = globalObserver.getState('trapkid_analyzer') || {};
                    const commandBoundToSignal =
                        signalKey && String(currentAnalyzerState.commandKey || '') === signalKey;
                    const preservedCommandStatus =
                        commandBoundToSignal &&
                        [
                            'COMMAND_RECEIVED',
                            'COMMAND_ACCEPTED',
                            'RUNNING',
                            'WAITING_FOR_ANALYZER_EXIT',
                            'ANALYZER_EXECUTION',
                            'ANALYZER_DATA_BOUND',
                            'ANALYZER_PURCHASE_BOUND',
                            'EARLY_EXIT_COMMAND_RECEIVED',
                            'WAITING_FOR_ANALYZER_EXIT_DIGIT',
                            'EARLY_EXIT_EXECUTING',
                            'ANALYZER_SETTLED',
                        ].includes(String(currentAnalyzerState.status || ''));

                    // Keep the global observer intentionally small. The Analyzer
                    // endpoint can contain hundreds of ticks/history items; copying that
                    // payload into the application-wide observer every poll causes heavy
                    // garbage collection and UI stalls. Full data stays in local details.
                    const mergedAnalyzerState = {
                        ...currentAnalyzerState,
                        ok: data?.ok,
                        connected: Boolean(data?.connected),
                        connecting: Boolean(data?.connecting),
                        historyLoaded: Boolean(data?.historyLoaded),
                        symbol: data?.symbol || signal?.symbol || currentAnalyzerState.symbol || null,
                        analyzerStatus,
                        entryReady,
                        serverTime: data?.serverTime,
                        currency: data?.currency || currentAnalyzerState.currency || 'USD',
                        balance: data?.balance ?? currentAnalyzerState.balance,
                        analyzerBalance: data?.analyzerBalance ?? currentAnalyzerState.analyzerBalance,
                        lastTick: data?.lastTick || currentAnalyzerState.lastTick || null,
                        analysis: data?.analysis || currentAnalyzerState.analysis || null,
                        signal: signal || null,
                        exit: (isNewSignal || initialSignalIsFresh)
                            ? null
                            : data?.exit || currentAnalyzerState.exit || null,
                        status: preservedCommandStatus
                            ? currentAnalyzerState.status
                            : signalKey
                              ? 'CONNECTED'
                              : 'CONNECTED_WAITING',
                        ...(commandBoundToSignal ? { commandKey: signalKey } : {}),
                        lastSeen: now,
                    };
                    // A fresh Analyzer signal starts a new execution cycle.
                    // Never carry the previous cycle's Deriv contract/settlement
                    // fields into the new signal; doing so makes the LINK badge
                    // display an old contract while the engine is trading a new one.
                    if (isNewSignal || initialSignalIsFresh) {
                        mergedAnalyzerState.derivProposalId = null;
                        mergedAnalyzerState.derivProposalAskPrice = null;
                        mergedAnalyzerState.derivContractId = null;
                        mergedAnalyzerState.deriv_contract_id = null;
                        mergedAnalyzerState.derivTransactionId = null;
                        mergedAnalyzerState.derivBuyPrice = null;
                        mergedAnalyzerState.derivBuy = null;
                        mergedAnalyzerState.analyzerContractId = null;
                        mergedAnalyzerState.analyzerPotentialPayout = null;
                        mergedAnalyzerState.derivPayout = null;
                        mergedAnalyzerState.payout = null;
                        mergedAnalyzerState.derivBalanceAfterBuy = null;
                        mergedAnalyzerState.derivSellTransactionId = null;
                        mergedAnalyzerState.derivBalanceAfterSell = null;
                        mergedAnalyzerState.analyzerExitCode = null;
                        mergedAnalyzerState.analyzerExitStatus = null;
                        mergedAnalyzerState.analyzerExecutionStatus = null;
                        mergedAnalyzerState.pendingEarlyExit = null;
                        mergedAnalyzerState.exit = null;
                    }

                    const rawExitForPublish = data?.exit;
                    const exitPublishKey =
                        rawExitForPublish?.status === 'EARLY_SELL_READY'
                            ? String(rawExitForPublish.signalId || signalId) + ':' +
                              String(rawExitForPublish.epoch || rawExitForPublish.quote || '')
                            : String(rawExitForPublish?.status || 'IDLE');
                    const publishKey = [
                        Boolean(data?.connected),
                        signalKey,
                        String(data?.symbol || ''),
                        String(signal?.hotDigit ?? ''),
                        exitPublishKey,
                        String(currentAnalyzerState.commandKey || ''),
                        String(currentAnalyzerState.status || ''),
                    ].join('|');

                    globalObserver.setState({ trapkid_analyzer: mergedAnalyzerState });

                    // Do not broadcast every 700ms. The bridge may poll frequently,
                    // but React/observer consumers only need an event when execution-
                    // relevant Analyzer state actually changes.
                    if (publishKey !== publishedKey) {
                        publishedKey = publishKey;
                        globalObserver.emit('trapkid.analyzer.updated', mergedAnalyzerState);
                    }

                    // A new Analyze cycle starts with a clean exit state.
                    // This prevents EARLY_SELL_READY from the previous cycle
                    // from blocking the newly locked signal.
                    if (isNewSignal) {
                        analyzerExitKeyRef.current = null;
                    }

                    const rawExit = data?.exit;
                    const rawExitSignalId = String(rawExit?.signalId || '');

                    // The Analyzer endpoint may omit signalId on its exit object.
                    // On the first poll of a NEW signal, do not inherit an old
                    // EARLY_SELL_READY state. Subsequent polls may deliver the
                    // exit for this already-known signal.
                    const exit =
                        isNewSignal
                            ? null
                            : rawExitSignalId && rawExitSignalId !== signalId
                              ? null
                              : rawExit
                                ? { ...rawExit, signalId: rawExitSignalId || signalId }
                                : null;

                    const exitSignalId = String(exit?.signalId || '');
                    const exitKey = exit?.status === 'EARLY_SELL_READY' && exitSignalId
                        ? exitSignalId + ':' + String(exit.epoch || exit.quote || '')
                        : '';

                    if (exitKey && analyzerExitKeyRef.current !== exitKey) {
                        analyzerExitKeyRef.current = exitKey;
                        const exitCommand = {
                            source: 'TRAPKID_ANALYZER_HTTP',
                            command: 'ANALYZER_EARLY_EXIT',
                            commandKey: signalId
                                ? signalId + ':' + String(signal.lockedAt || '')
                                : '',
                            signalId: exitSignalId,
                            signal,
                            exit,
                            receivedAt: now,
                        };
                        globalObserver.emit('trapkid.analyzer.exit', exitCommand);
                        globalObserver.emit(
                            'trapkid.analyzer.updated',
                            globalObserver.getState('trapkid_analyzer') || {}
                        );
                    }

                    // Analyze is the entry command. A fresh Analyzer LOCKED
                    // signal is therefore executable once; READY remains compatible.
                    if (
                        signalKey &&
                        entryReady &&
                        String(globalObserver.getState('trapkid_analyzer')?.commandKey || '') !== signalKey
                    ) {
                        analyzerSignalKeyRef.current = signalKey;

                        const command = {
                            source: 'TRAPKID_ANALYZER_HTTP',
                            command: 'EXECUTE_ANALYZER_SIGNAL',
                            commandKey: signalKey,
                            status: 'READY',
                            entryReady: true,
                            executionTrigger: 'ANALYZER_ENTRY',
                            receivedAt: now,
                            signal,
                            analyzer: data,
                        };

                        globalObserver.setState({
                            trapkid_analyzer: {
                                ...(globalObserver.getState('trapkid_analyzer') || {}),
                                ...data,
                                status: 'COMMAND_RECEIVED',
                                analyzerStatus: 'ANALYZE_CLICK',
                                entryReady: true,
                                executionArmed: true,
                                executionTrigger: 'ANALYZER_ENTRY',
                                commandKey: signalKey,
                                lastSeen: now,
                            },
                        });
                        globalObserver.emit('trapkid.analyzer.command', command);
                        globalObserver.emit(
                            'trapkid.analyzer.updated',
                            globalObserver.getState('trapkid_analyzer') || {}
                        );
                    }
                }
            } catch (error) {
                if (!cancelled) {
                    const message = error instanceof Error ? error.message : String(error);
                    setConnectionError(message || 'Request failed');
                    const offline = {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'DISCONNECTED',
                        connected: false,
                        lastSeen: null,
                    };
                    setDetails((current: any) => current ? { ...current, connected: false } : { connected: false });
                    globalObserver.setState({ trapkid_analyzer: offline });
                    if (publishedKey !== 'OFFLINE') {
                        publishedKey = 'OFFLINE';
                        globalObserver.emit('trapkid.analyzer.updated', offline);
                    }
                }
            } finally {
                polling = false;
            }
        };

        void poll();
        const timer = window.setInterval(poll, 1000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [analyzerApi]);

    React.useEffect(() => {
        const onAnalyzerUpdated = (state: any) => {
            setExecutionState(state || {});
        };
        globalObserver.register('trapkid.analyzer.updated', onAnalyzerUpdated);
        setExecutionState(globalObserver.getState('trapkid_analyzer') || {});
        return () => {
            globalObserver.unregister('trapkid.analyzer.updated', onAnalyzerUpdated);
        };
    }, []);

    const connected = Boolean(details?.connected);
    const activeSignalId = String(details?.signal?.signalId || '');
    const executionSignalId = String(executionState?.signalId || executionState?.signal?.signalId || '');
    const signalMatches = !!activeSignalId && activeSignalId === executionSignalId;
    const hotDigit = Number(details?.analysis?.hotDigit ?? details?.signal?.hotDigit);
    const exitDigit = Number(details?.exit?.digit ?? executionState?.exit?.digit);
    const exitStatus = String(details?.exit?.status || executionState?.exit?.status || 'IDLE');
    const exitValid = exitStatus === 'EARLY_SELL_READY' && Number.isInteger(exitDigit) && exitDigit === hotDigit;
    const executionContractSignalId = String(
        executionState?.analyzerContractSignalId ||
        executionState?.analyzer_contract_signal_id ||
        ''
    );
    const rawDerivContractId = String(
        executionState?.derivContractId ||
        executionState?.analyzerContractId ||
        executionState?.signal?.contractId ||
        ''
    );
    // Never display a contract from another Analyzer cycle. If the bridge has
    // not yet associated the real BUY response with this signal, show waiting
    // instead of a stale contract ID.
    const derivContractId =
        executionContractSignalId && activeSignalId && executionContractSignalId !== activeSignalId
            ? '—'
            : rawDerivContractId || '—';
    const buyPrice = executionState?.derivBuyPrice ?? executionState?.derivBuy?.buy_price;
    const buyTransactionId = executionState?.derivTransactionId || executionState?.derivBuy?.transaction_id || '—';
    const sellTransactionId = executionState?.derivSellTransactionId || '—';
    const soldFor =
        executionState?.financialStatus === 'DERIV_SELL_CONFIRMED' ||
        executionState?.financial_status === 'DERIV_SELL_CONFIRMED'
            ? executionState?.derivSellPrice ?? executionState?.derivPayout ?? executionState?.payout
            : executionState?.derivSellPrice ?? executionState?.deriv_sell_price;
    const balanceAfterSell = executionState?.derivBalanceAfterSell;
    const sellConfirmed =
        String(executionState?.financialStatus || executionState?.financial_status || '') === 'DERIV_SELL_CONFIRMED' &&
        Boolean(executionState?.derivSellTransactionId || executionState?.deriv_sell_transaction_id);
    const lifecycle = String(executionState?.status || (connected ? 'CONNECTED_WAITING' : 'DISCONNECTED'));

    const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setPos({
            x: Math.max(8, Math.min(window.innerWidth - 72, e.clientX - drag.current.dx)),
            y: Math.max(8, Math.min(window.innerHeight - 72, e.clientY - drag.current.dy)),
        });
    };

    return (
        <div
            className={open ? 'tk-analyzer-global-dock open' : 'tk-analyzer-global-dock'}
            style={{ left: pos.x, top: pos.y }}
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
        >
            <button
                className={connected ? 'tk-analyzer-link-button live' : 'tk-analyzer-link-button'}
                onPointerDown={e => e.stopPropagation()}
                onPointerUp={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); setOpen(value => !value); }}
                title='TrapKid Analyzer HTTP link'
                aria-label='Open TrapKid Analyzer HTTP link'
            >
                <span className='tk-link-bars'><i /><i /><i /></span>
                <span className='tk-link-led' />
                <b>LINK</b>
            </button>

            {open && (
                <div className='tk-analyzer-global-popover' onPointerDown={e => e.stopPropagation()}>
                    <div className='tk-analyzer-global-head'>
                        <div>
                            <b>TRAPKID ANALYZER • HTTP LINK</b>
                            <small>{connected ? '● CONNECTED — LIVE POLLING' : '○ DISCONNECTED — CHECK ANALYZER'}</small>
                        </div>
                        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setOpen(false); }} aria-label='Close Analyzer panel'>×</button>
                    </div>

                    <div className='tk-analyzer-global-connection'>
                        <span className={connected ? 'is-live' : 'is-offline'} />
                        <b>{connected ? 'CONNECTED TO ANALYZER' : 'DISCONNECTED FROM ANALYZER'}</b>
                        <small>{connected ? 'DBot site is reading /api/status directly.' : 'No response from Analyzer.'}</small>
                    </div>

                    <div className='tk-analyzer-global-url'>
                        <b>LINK {LINK_VERSION}</b><br />
                        {ANALYZER_STATUS_URL}
                    </div>

                    <div className='tk-analyzer-global-grid'>
                        <span>MARKET<b>{details?.symbol || '—'}</b></span>
                        <span>LAST DIGIT<b>{details?.lastTick?.digit ?? '—'}</b></span>
                        <span>HOT DIGIT<b>{details?.analysis?.hotDigit ?? '—'}</b></span>
                        <span>SCORE<b>{Number(details?.analysis?.score ?? 0).toFixed(2)}</b></span>
                        <span>SIGNAL<b>{details?.signal?.signalId || 'NONE'}</b></span>
                        <span>PREDICTION<b>{details?.signal?.prediction ?? details?.signal?.lockedDigit ?? '—'}</b></span>
                        <span>ENTRY QUOTE<b>{details?.signal?.entryQuote ?? '—'}</b></span>
                        <span>LOCKED QUOTE<b>{details?.signal?.lockedQuote ?? '—'}</b></span>
                        <span>EXIT<b>{exitStatus}</b></span>
                        <span>EXIT DIGIT<b>{Number.isInteger(exitDigit) ? exitDigit : '—'}</b></span>
                        <span>SIGNAL MATCH<b>{signalMatches ? 'VALID' : 'WAITING'}</b></span>
                        <span>EXIT VALIDATION<b>{exitStatus === 'EARLY_SELL_READY' ? (exitValid ? 'HOT DIGIT MATCH' : 'REJECTED') : 'WAITING'}</b></span>
                        <span>LIFECYCLE<b>{lifecycle}</b></span>
                        <span>DERIV CONTRACT<b>{derivContractId}</b></span>
                        <span>STAKE / BUY<b>{Number.isFinite(Number(buyPrice)) ? Number(buyPrice).toFixed(2) : '—'}</b></span>
                        <span>BUY TX<b>{buyTransactionId}</b></span>
                        <span>SELL TX<b>{sellTransactionId}</b></span>
                        <span>SOLD FOR<b>{sellConfirmed && Number.isFinite(Number(soldFor)) ? Number(soldFor).toFixed(2) : '—'}</b></span>
                        <span>BALANCE AFTER<b>{sellConfirmed && Number.isFinite(Number(balanceAfterSell)) ? Number(balanceAfterSell).toFixed(2) : '—'}</b></span>
                    </div>

                    <div className='tk-analyzer-global-dbot'>
                        <strong>ANALYZER → DBOT COMMAND LINK</strong>
                        <div className='tk-link-proof'><span className={connected ? 'is-live' : 'is-offline'} /> {connected ? 'ANALYZER DATA CHANNEL LIVE' : 'ANALYZER DATA CHANNEL OFFLINE'}</div>
                        <code>GET /api/status?client=dbot</code>
                        <small>HTTP only. Last successful read: {lastSeen ? new Date(lastSeen).toLocaleTimeString() : 'waiting…'}</small>
                        <div style={{ marginTop: 8 }}>
                            <small>Automatic connection is enabled. The dock checks the Analyzer every second and reconnects whenever the Analyzer becomes available again.</small>
                        </div>
                        {connectionError && <small style={{ display: 'block', marginTop: 6 }}>Connection: {connectionError} — retrying automatically…</small>}
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrapKidAnalyzerDock;
