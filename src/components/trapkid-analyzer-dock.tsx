import React from 'react';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';

const ANALYZER_API = (process.env.NEXT_PUBLIC_ANALYZER_API_URL || 'https://thesis-quality-remote-rendered.trycloudflare.com').trim();
const LINK_VERSION = 'ANALYZER-DBOT-BRIDGE-01';

const TrapKidAnalyzerDock = () => {
    const [details, setDetails] = React.useState<any>(null);
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState({ x: 22, y: 120 });
    const [lastSeen, setLastSeen] = React.useState<number | null>(null);
    const drag = React.useRef<{ dx: number; dy: number } | null>(null);
    const analyzerSignalKeyRef = React.useRef<string | null>(null);
    const analyzerExitKeyRef = React.useRef<string | null>(null);
    const mountedAtRef = React.useRef(Date.now());

    React.useEffect(() => {
        let cancelled = false;
        let polling = false;

        const poll = async () => {
            if (cancelled || polling) return;
            polling = true;
            try {
                const res = await fetch(ANALYZER_API + '/api/status?client=global-link&t=' + Date.now(), {
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                if (!cancelled) {
                    const now = Date.now();
                    setDetails(data);
                    setLastSeen(now);

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

                    const currentAnalyzerState = globalObserver.getState('trapkid_analyzer') || {};
                    const commandBoundToSignal =
                        signalKey && String(currentAnalyzerState.commandKey || '') === signalKey;
                    const preservedCommandStatus =
                        commandBoundToSignal &&
                        [
                            'COMMAND_RECEIVED',
                            'COMMAND_ACCEPTED',
                            'RUNNING',
                            'ANALYZER_DATA_BOUND',
                            'ANALYZER_PURCHASE_BOUND',
                            'EARLY_EXIT_COMMAND_RECEIVED',
                            'EARLY_EXIT_EXECUTING',
                        ].includes(String(currentAnalyzerState.status || ''));

                    globalObserver.setState({
                        trapkid_analyzer: {
                            ...currentAnalyzerState,
                            ...data,
                            ...(isNewSignal || initialSignalIsFresh ? { exit: null } : {}),
                            status: preservedCommandStatus
                                ? currentAnalyzerState.status
                                : signalKey
                                  ? 'CONNECTED'
                                  : 'CONNECTED_WAITING',
                            ...(commandBoundToSignal ? { commandKey: signalKey } : {}),
                            lastSeen: now,
                        },
                    });
                    // Publish the merged observer state so commandKey/status are not lost.
                    globalObserver.emit(
                        'trapkid.analyzer.updated',
                        globalObserver.getState('trapkid_analyzer') || {}
                    );

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

                    if (
                        signalKey &&
                        (isNewSignal || initialSignalIsFresh) &&
                        String(globalObserver.getState('trapkid_analyzer')?.commandKey || '') !== signalKey
                    ) {
                        analyzerSignalKeyRef.current = signalKey;

                        const command = {
                            source: 'TRAPKID_ANALYZER_HTTP',
                            command: 'EXECUTE_ANALYZER_SIGNAL',
                            commandKey: signalKey,
                            receivedAt: now,
                            signal,
                            analyzer: data,
                        };

                        globalObserver.setState({
                            trapkid_analyzer: {
                                ...(globalObserver.getState('trapkid_analyzer') || {}),
                                ...data,
                                status: 'COMMAND_RECEIVED',
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
            } catch {
                if (!cancelled) {
                    const offline = {
                        ...(globalObserver.getState('trapkid_analyzer') || {}),
                        status: 'DISCONNECTED',
                        connected: false,
                        lastSeen: null,
                    };
                    setDetails((current: any) => current ? { ...current, connected: false } : { connected: false });
                    globalObserver.setState({ trapkid_analyzer: offline });
                    globalObserver.emit('trapkid.analyzer.updated', offline);
                }
            } finally {
                polling = false;
            }
        };

        void poll();
        const timer = window.setInterval(poll, 700);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, []);

    const connected = Boolean(details?.connected);

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
                        {ANALYZER_API}/api/status
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
                        <span>EXIT<b>{details?.exit?.status || details?.signal?.exitStatus || 'IDLE'}</b></span>
                        <span>EXIT DIGIT<b>{details?.exit?.digit ?? details?.signal?.exitDigit ?? '—'}</b></span>
                    </div>

                    <div className='tk-analyzer-global-dbot'>
                        <strong>ANALYZER → DBOT COMMAND LINK</strong>
                        <div className='tk-link-proof'><span className={connected ? 'is-live' : 'is-offline'} /> {connected ? 'ANALYZER DATA CHANNEL LIVE' : 'ANALYZER DATA CHANNEL OFFLINE'}</div>
                        <code>GET /api/status?client=dbot</code>
                        <small>HTTP only. No browser WebSocket is required for the Analyzer link. Last successful read: {lastSeen ? new Date(lastSeen).toLocaleTimeString() : 'waiting…'}</small>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrapKidAnalyzerDock;
