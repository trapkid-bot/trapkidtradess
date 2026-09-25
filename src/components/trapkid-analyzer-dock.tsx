import React from 'react';

const ANALYZER_API = (process.env.NEXT_PUBLIC_ANALYZER_API_URL || 'https://thesis-quality-remote-rendered.trycloudflare.com').trim();
const LINK_VERSION = 'HTTP-LINK-02';

const TrapKidAnalyzerDock = () => {
    const [details, setDetails] = React.useState<any>(null);
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState({ x: 22, y: 120 });
    const [lastSeen, setLastSeen] = React.useState<number | null>(null);
    const drag = React.useRef<{ dx: number; dy: number } | null>(null);

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
                    setDetails(data);
                    setLastSeen(Date.now());
                }
            } catch {
                if (!cancelled) setDetails((current: any) => current ? { ...current, connected: false } : { connected: false });
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
                        <b>{connected ? 'CONNECTED' : 'DISCONNECTED'}</b>
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
                        <strong>DBOT → ANALYZER</strong>
                        <div className='tk-link-proof'><span className={connected ? 'is-live' : 'is-offline'} /> {connected ? 'HANDSHAKE OK • HTTP STATUS RECEIVED' : 'HANDSHAKE FAILED'}</div>
                        <code>GET /api/status?client=dbot</code>
                        <small>HTTP only. No browser WebSocket is required for the Analyzer link. Last successful read: {lastSeen ? new Date(lastSeen).toLocaleTimeString() : 'waiting…'}</small>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrapKidAnalyzerDock;
