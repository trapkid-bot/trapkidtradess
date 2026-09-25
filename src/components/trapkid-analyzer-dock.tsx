import React from 'react';

const ANALYZER_API = (process.env.NEXT_PUBLIC_ANALYZER_API_URL || 'https://thesis-quality-remote-rendered.trycloudflare.com').trim();

const TrapKidAnalyzerDock = () => {
    const [details, setDetails] = React.useState<any>(null);
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState({ x: 24, y: 88 });
    const drag = React.useRef<{ dx: number; dy: number } | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch(`${ANALYZER_API}/api/status`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled) setDetails(data);
            } catch {
                if (!cancelled) setDetails((current: any) => current ? { ...current, connected: false } : { connected: false });
            }
        };

        poll();
        const timer = window.setInterval(poll, 1000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, []);

    const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setPos({
            x: Math.max(8, Math.min(window.innerWidth - 64, e.clientX - drag.current.dx)),
            y: Math.max(8, Math.min(window.innerHeight - 64, e.clientY - drag.current.dy)),
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
                className='tk-analyzer-global-orb'
                onClick={() => setOpen(value => !value)}
                title='TrapKid Analyzer connection'
                aria-label='Open TrapKid Analyzer connection'
            >
                <span className={details?.connected ? 'tk-analyzer-global-led live' : 'tk-analyzer-global-led'} />
                <b>TK</b>
            </button>

            {open && (
                <div className='tk-analyzer-global-popover' onPointerDown={e => e.stopPropagation()}>
                    <div className='tk-analyzer-global-head'>
                        <div>
                            <b>TRAPKID ANALYZER LINK</b>
                            <small>{details?.connected ? '● LIVE DATA' : '○ OFFLINE'}</small>
                        </div>
                        <button onClick={() => setOpen(false)} aria-label='Close Analyzer panel'>×</button>
                    </div>

                    <div className='tk-analyzer-global-url'>{ANALYZER_API}</div>

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
                        <strong>DBOT FETCH / USE</strong>
                        <code>GET {ANALYZER_API}/api/status</code>
                        <small>
                            DBot reads <b>symbol</b>, <b>prediction/lockedDigit</b>, <b>contractType</b>,
                            <b>entryQuote</b>, <b>lockedQuote</b>, <b>signalId</b> and <b>exit</b> from this live payload.
                        </small>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrapKidAnalyzerDock;
