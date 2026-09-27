import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';
import './matches-terminal.scss';

// TrapKid Analyzer ONLY execution gate • COMMAND BUS V5

type Market = {
    symbol: string;
    name: string;
    type: string;
    pipSize: number;
    quote?: number;
};

type Trade = {
    signalId: string;
    contractId: string;
    prediction: number;
    symbol: string;
    stake: number;
    payout: number;
    buyPrice: number;
    bidPrice: number;
    openedAt: number;
    holdTicks: number;
    entryDigit: number | null;
    hotDigit: number | null;
    lockedDigit: number;
};

const ANALYZER_API = (process.env.NEXT_PUBLIC_ANALYZER_API_URL || 'https://copper-philosophy-smart-competition.trycloudflare.com').trim();
const ANALYZER_WS = (process.env.NEXT_PUBLIC_ANALYZER_WS_URL || ANALYZER_API.replace(/^http/i, 'ws')).trim();
const ANALYZER_EXECUTION_VERSION = 'ANALYZER-COMMAND-BUS-V5';
const ANALYZER_EXECUTION_DURATION = 1;
const ANALYZER_EXECUTION_DURATION_UNIT = 't';

const lastDigit = (quote: number, pipSize = 2) => {
    const fixed = Number(quote).toFixed(Math.max(0, pipSize));
    return Number(fixed.replace(/\D/g, '').slice(-1));
};

const formatMoney = (value: number, currency = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

const requestId = (() => {
    let id = 9000;
    return () => ++id;
})();

const waitForApiMessage = (reqId: number, timeout = 10000) =>
    new Promise<any>((resolve, reject) => {
        const api = api_base.api;
        if (!api) {
            reject(new Error('Deriv connection is not ready. Log in first.'));
            return;
        }

        const sub = api.onMessage().subscribe((raw: any) => {
            const message = raw?.data ? raw.data : raw;
            if (message?.req_id !== reqId) return;
            sub.unsubscribe();
            if (message.error) reject(new Error(message.error.message || 'Deriv API error'));
            else resolve(message);
        });

        window.setTimeout(() => {
            try { sub.unsubscribe(); } catch { /* noop */ }
            reject(new Error('Deriv request timed out.'));
        }, timeout);
    });

const sendApiRequest = async (payload: Record<string, any>) => {
    const api = api_base.api;
    if (!api) throw new Error('Deriv connection is not ready. Log in first.');
    const req_id = requestId();
    const promise = waitForApiMessage(req_id);
    api.send({ ...payload, req_id });
    return promise;
};

const buildSparkline = (prices: number[], width = 900, height = 520) => {
    if (prices.length < 2) return '';
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const pad = 20;
    return prices
        .map((p, i) => {
            const x = pad + (i / (prices.length - 1)) * (width - pad * 2);
            const y = height - pad - ((p - min) / range) * (height - pad * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
};

const MatchesTerminal = () => {
    const authSubscription = useRef<{ unsubscribe: () => void } | null>(null);
    const reqIdRef = useRef(1);
    const tradeRef = useRef<Trade | null>(null);
    const sellingRef = useRef(false);

    const [markets, setMarkets] = useState<Market[]>([]);
    const [symbol, setSymbol] = useState('R_100');
    const [prices, setPrices] = useState<number[]>([]);
    const [tick, setTick] = useState<number | null>(null);
    const [digit, setDigit] = useState<number | null>(null);
    const [prediction, setPrediction] = useState<number | null>(null);
    const [stake, setStake] = useState(2);
    const [balance, setBalance] = useState<number | null>(null);
    const [currency, setCurrency] = useState('USD');
    const [accountId, setAccountId] = useState<string | null>(null);
    const [accountType, setAccountType] = useState<'demo' | 'real'>('demo');
    const [payout, setPayout] = useState<number | null>(null);
    const [proposalId, setProposalId] = useState<string | null>(null);
    const [contractAvailable, setContractAvailable] = useState(true);
    const [trade, setTrade] = useState<Trade | null>(null);
    const [status, setStatus] = useState('Connecting to live market data…');
    const [error, setError] = useState('');
    const [historyDigits, setHistoryDigits] = useState<number[]>([]);
    const [aiDigit, setAiDigit] = useState<number | null>(null);
    const [aiScore, setAiScore] = useState(0);
    const [aiReason, setAiReason] = useState('Waiting for tick history');
    const [trades, setTrades] = useState<{ time: string; digit: number; result: string; pnl: number }[]>([]);
    const [analyzerDetails, setAnalyzerDetails] = useState<any>(null);
    const [analyzerPanelOpen, setAnalyzerPanelOpen] = useState(false);
    const [analyzerPos, setAnalyzerPos] = useState({ x: 24, y: 88 });
    const analyzerDrag = useRef<{ dx: number; dy: number } | null>(null);
    const analyzerInitializedRef = useRef(false);
    const analyzerBaselineSignalRef = useRef<string | null>(null);
    const analyzerProcessedSignalRef = useRef<string | null>(null);
    const analyzerAuthorizedSignalRef = useRef<string | null>(null);
    const analyzerTickRef = useRef<number | null>(null);
    const analyzerMountedAtRef = useRef(Date.now());

    const selectedMarket = useMemo(() => markets.find(m => m.symbol === symbol), [markets, symbol]);
    const points = useMemo(() => buildSparkline(prices), [prices]);

    const subscribeMarket = useCallback((nextSymbol: string) => {
        setStatus(`Waiting for ${nextSymbol} from TrapKid Analyzer…`);
        setError('');
        setPrices([]);
        setHistoryDigits([]);
        setTick(null);
        setDigit(null);
        setPayout(null);
        setProposalId(null);

    }, []);

    useEffect(() => {
        let cancelled = false;
        let lastEpoch: number | null = null;
        let polling = false;
        let ws: WebSocket | null = null;
        let reconnectTimer: number | null = null;

        const applyAnalyzerState = (data: any) => {
            if (cancelled || !data) return;
            setAnalyzerDetails((current: any) => ({ ...(current || {}), ...data }));

            const analyzerMarkets: Market[] = Array.isArray(data.markets)
                ? data.markets.map((m: any) => ({
                    symbol: String(m.symbol),
                    name: String(m.name || m.symbol),
                    type: String(m.type || 'synthetic'),
                    pipSize: Number(m.pipSize ?? 2),
                }))
                : [];
            if (analyzerMarkets.length) setMarkets(analyzerMarkets);

            const nextSymbol = String(data.symbol || symbol);
            if (nextSymbol !== symbol) {
                setSymbol(nextSymbol);
                subscribeMarket(nextSymbol);
            }

            const signal = data.signal;
            const analysis = data.analysis || {};

            // First snapshot is a baseline only. A later signal produced by
            // Analyze Market becomes the sole execution trigger.
            const signalId = String(signal?.signalId || '');
            const lockedAt = Number(signal?.lockedAt);
            const signalKey = signalId
                ? signalId + ':' + (Number.isFinite(lockedAt) ? lockedAt : '')
                : '';
            if (!analyzerInitializedRef.current) {
                analyzerInitializedRef.current = true;
                // A signal locked within 30 seconds of this page mounting
                // is treated as the user's Analyze-created entry signal, not
                // as an old baseline. Older signals are baseline-only.
                const freshAfterAnalyze = Number.isFinite(lockedAt) &&
                    lockedAt >= analyzerMountedAtRef.current - 30000;
                if (freshAfterAnalyze) {
                    analyzerBaselineSignalRef.current = null;
                    analyzerProcessedSignalRef.current = null;
                } else {
                    analyzerBaselineSignalRef.current = signalKey || null;
                    analyzerProcessedSignalRef.current = signalKey || null;
                }
            }
            if (signal && Number.isInteger(Number(signal.prediction ?? signal.lockedDigit))) {
                const nextPrediction = Number(signal.prediction ?? signal.lockedDigit);
                const nextSignalId = String(signal.signalId || '');
                setPrediction(nextPrediction);
                setAiDigit(Number.isInteger(Number(analysis.hotDigit)) ? Number(analysis.hotDigit) : nextPrediction);
                if (Number.isFinite(Number(analysis.score))) setAiScore(Math.round(Number(analysis.score)));
                setAiReason(String(signal.reason || analysis.reason || ('Analyzer locked digit ' + nextPrediction + (nextSignalId ? ' — ' + nextSignalId : '') + '.')));
            } else if (Number.isInteger(Number(analysis.hotDigit))) {
                setAiDigit(Number(analysis.hotDigit));
                if (Number.isFinite(Number(analysis.score))) setAiScore(Math.round(Number(analysis.score)));
                if (analysis.reason) setAiReason(String(analysis.reason));
            }
        };

        const applyAnalyzerTick = (tick: any) => {
            if (cancelled || !tick) return;
            const quote = Number(tick.quote);
            const d = Number(tick.digit);
            const epoch = Number(tick.epoch);
            if (!Number.isFinite(epoch) || epoch === lastEpoch) return;
            lastEpoch = epoch;

            setAnalyzerDetails((current: any) => ({
                ...(current || {}),
                connected: true,
                lastTick: { ...(current?.lastTick || {}), ...tick },
            }));
            if (Number.isFinite(quote)) {
                setTick(quote);
                setPrices(prev => [...prev.slice(-99), quote]);
            }
            if (Number.isInteger(d)) {
                setDigit(d);
                setHistoryDigits(prev => [...prev.slice(-99), d]);
            }
            setStatus('Analyzer LIVE STREAM • ' + (analyzerDetails?.symbol || symbol) + ' • tick ' + epoch);
            setError('');
        };

        const connectWs = () => {
            if (cancelled) return;
            try {
                const wsUrl = (process.env.NEXT_PUBLIC_ANALYZER_WS_URL || ANALYZER_API.replace(/^http/i, 'ws')).replace(/\/$/, '') + '/ws/ticks';
                ws = new WebSocket(wsUrl);
                ws.onopen = () => {
                    if (!cancelled) setStatus('Analyzer LIVE STREAM CONNECTED • waiting for ticks…');
                };
                ws.onmessage = event => {
                    try {
                        const message = JSON.parse(event.data);
                        const data = message?.data || message?.state || message;
                        if (message?.type === 'tick' || data?.quote !== undefined && data?.epoch !== undefined && data?.digit !== undefined) {
                            applyAnalyzerTick(data?.lastTick || data);
                        }
                        if (message?.type === 'state' || data?.signal || data?.symbol || data?.analysis) {
                            applyAnalyzerState(data);
                        }
                    } catch {
                        // Ignore malformed stream frames; HTTP snapshot remains available.
                    }
                };
                ws.onerror = () => {
                    if (!cancelled) setStatus('Analyzer stream reconnecting…');
                };
                ws.onclose = () => {
                    if (cancelled) return;
                    if (reconnectTimer) window.clearTimeout(reconnectTimer);
                    reconnectTimer = window.setTimeout(connectWs, 1000);
                };
            } catch {
                if (!cancelled) setStatus('Analyzer stream unavailable — using HTTP snapshot');
                reconnectTimer = window.setTimeout(connectWs, 1500);
            }
        };

        const poll = async () => {
            if (cancelled || polling) return;
            polling = true;
            try {
                const response = await fetch(ANALYZER_API + '/api/status?client=dbot&t=' + Date.now(), {
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                if (!response.ok) throw new Error('Analyzer HTTP ' + response.status);
                const data = await response.json();
                if (!cancelled) {
                    applyAnalyzerState(data);
                    if (data.lastTick) applyAnalyzerTick(data.lastTick);
                    setStatus(ws?.readyState === WebSocket.OPEN
                        ? 'Analyzer LIVE STREAM • ' + (data.symbol || symbol)
                        : 'Analyzer HTTP LIVE • ' + (data.symbol || symbol));
                }
            } catch {
                if (!cancelled) setStatus('Analyzer connection offline');
            } finally {
                polling = false;
            }
        };

        void poll();
        connectWs();
        const timer = window.setInterval(poll, 1000);

        return () => {
            cancelled = true;
            window.clearInterval(timer);
            if (reconnectTimer) window.clearTimeout(reconnectTimer);
            try { ws?.close(); } catch { /* noop */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ANALYZER_API]);

    useEffect(() => {
        const active = localStorage.getItem('active_loginid');
        const type = localStorage.getItem('account_type') === 'real' ? 'real' : 'demo';
        if (active) setAccountId(active);
        setAccountType(type);

        const refresh = async () => {
            try {
                if (!api_base.api) await api_base.init();
                if (!api_base.api) return;

                const sub = api_base.api.onMessage().subscribe((raw: any) => {
                    const message = raw?.data ? raw.data : raw;
                    if (message?.msg_type === 'balance' && message.balance) {
                        setBalance(Number(message.balance.balance));
                        setCurrency(message.balance.currency || 'USD');
                        if (message.balance.loginid) setAccountId(message.balance.loginid);
                    }

                    if (message?.msg_type === 'proposal_open_contract' && message.proposal_open_contract) {
                        const open = message.proposal_open_contract;
                        if (tradeRef.current?.contractId === String(open.contract_id)) {
                            const bid = Number(open.bid_price);
                            if (Number.isFinite(bid)) {
                                setTrade(prev => prev ? { ...prev, bidPrice: bid } : prev);
                                tradeRef.current = { ...tradeRef.current, bidPrice: bid };
                            }
                            if (open.is_sold || open.status === 'sold' || open.is_expired) {
                                tradeRef.current = null;
                                sellingRef.current = false;
                            }
                        }
                    }
                });
                authSubscription.current = sub;

                if (api_base.is_authorized) {
                    const result = await api_base.api.balance();
                    if (result?.balance) {
                        setBalance(Number(result.balance.balance));
                        setCurrency(result.balance.currency || 'USD');
                        setAccountId(result.balance.loginid || active);
                    }
                    api_base.api.send({ balance: 1, subscribe: 1 });
                }
            } catch (e) {
                console.warn('[MatchesTerminal] auth sync:', e);
            }
        };

        void refresh();

        return () => {
            authSubscription.current?.unsubscribe();
            authSubscription.current = null;
        };
    }, []);

    // The TradeEngine is the single financial executor.
    // This terminal never sends its own BUY or SELL requests. It only reflects
    // Analyzer commands and the authoritative Deriv contract state published
    // by the engine.
    useEffect(() => {
        const applyExecutionState = (state: any) => {
            if (!state) return;

            if (state.status === 'ANALYZER_SETTLED' || state.status === 'WAITING_FOR_ANALYZER') {
                tradeRef.current = null;
                sellingRef.current = false;
                setTrade(null);
                if (state.status === 'ANALYZER_SETTLED') {
                    setStatus(
                        'ANALYZER EARLY_SELL_READY → SAME DERIV CONTRACT SETTLED' +
                        (state.derivPayout != null ? ' • ' + formatMoney(Number(state.derivPayout), currency) : '')
                    );
                }
                return;
            }

            const contractId = String(state.derivContractId || state.analyzerContractId || '');
            const signal = state.signal;
            if (!contractId || !signal?.signalId) return;
            if (!['ANALYZER_EXECUTION', 'ANALYZER_PURCHASE_AUTHORIZED', 'RUNNING', 'EARLY_EXIT_COMMAND_RECEIVED', 'ANALYZER_DATA_BOUND'].includes(String(state.status || ''))) return;

            const prediction = Number(state.hotDigit ?? state.prediction ?? signal.hotDigit ?? signal.prediction);
            const buyPrice = Number(state.derivBuyPrice);
            const nextTrade: Trade = {
                signalId: String(signal.signalId),
                contractId,
                prediction: Number.isInteger(prediction) ? prediction : 0,
                symbol: String(state.symbol || signal.symbol || symbol),
                stake: Number.isFinite(Number(buyPrice)) && Number(buyPrice) > 0 ? Number(buyPrice) : stake,
                payout: Number.isFinite(Number(state.analyzerPotentialPayout ?? state.payout)) ? Number(state.analyzerPotentialPayout ?? state.payout) : 0,
                buyPrice: Number.isFinite(Number(buyPrice)) ? Number(buyPrice) : 0,
                bidPrice: Number.isFinite(Number(state.derivBuyPrice)) ? Number(state.derivBuyPrice) : 0,
                openedAt: Number(state.analyzerBoundAt || Date.now()),
                holdTicks: ANALYZER_EXECUTION_DURATION,
                entryDigit: Number.isInteger(Number(signal.entryDigit)) ? Number(signal.entryDigit) : prediction,
                hotDigit: Number.isInteger(Number(signal.hotDigit)) ? Number(signal.hotDigit) : prediction,
                lockedDigit: Number.isInteger(Number(signal.lockedDigit)) ? Number(signal.lockedDigit) : prediction,
            };

            tradeRef.current = nextTrade;
            setTrade(nextTrade);
            setSymbol(nextTrade.symbol);
            setPrediction(nextTrade.prediction);
            setStatus(
                state.status === 'RUNNING'
                    ? 'ANALYZER BUY CONFIRMED • 1-TICK EXECUTION • MATCH OPEN • waiting for hot digit'
                    : 'ANALYZER COMMAND RECEIVED • TradeEngine executing ' + nextTrade.signalId
            );
        };

        const onAnalyzerUpdated = (state: any) => applyExecutionState(state);
        globalObserver.register('trapkid.analyzer.updated', onAnalyzerUpdated);
        applyExecutionState(globalObserver.getState('trapkid_analyzer') || {});

        return () => {
            globalObserver.unregister('trapkid.analyzer.updated', onAnalyzerUpdated);
        };
    }, [currency, stake, symbol]);

    const selectMarket = (next: string) => {
        if (analyzerDetails?.symbol && next !== analyzerDetails.symbol) {
            setStatus('Analyzer controls the active market: ' + analyzerDetails.symbol);
            return;
        }
        setSymbol(next);
        subscribeMarket(next);
    };

    const loginHint = !accountId ? 'Log in with Deriv from the top-right account controls to enable real/demo trading.' : '';

    return (
        <div className='tk-matches-terminal'>
            <div className='tk-topbar'>
                <div className='tk-brand'>
                    <div className='tk-brand-mark'>TK</div>
                    <div>
                        <div className='tk-brand-name'>TRAPKID MATCHES</div>
                        <div className='tk-brand-sub'>Analyzer-controlled Match terminal • {ANALYZER_EXECUTION_VERSION}</div>
                    </div>
                </div>
                <div className='tk-account'>
                    <span className={accountType === 'real' ? 'live-dot real' : 'live-dot'} />
                    <span>{accountId ? (accountType === 'real' ? 'Real account' : 'Demo account') : 'Not logged in'}</span>
                    <strong>{balance === null ? '—' : formatMoney(balance, currency)}</strong>
                </div>
            </div>

            <div className='tk-layout'>
                <aside className='tk-sidebar'>
                    <button className='tk-add'>＋</button>
                    <div className='tk-market-title'>MATCH MARKETS</div>
                    <div className='tk-market-list'>
                        {(markets.length ? markets : [{ symbol: 'R_100', name: 'Volatility 100 Index', type: 'synthetic', pipSize: 2 }]).map(m => (
                            <button
                                key={m.symbol}
                                className={m.symbol === symbol ? 'tk-market active' : 'tk-market'}
                                onClick={() => {
                                    setStatus('Analyzer controls the active market: ' + (analyzerDetails?.symbol || m.symbol));
                                }}
                            >
                                <span className='market-icon'>▥</span>
                                <span>
                                    <b>{m.name}</b>
                                    <small>{m.symbol}</small>
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>

                <main className='tk-chart-area'>
                    <div className='tk-chart-header'>
                        <div>
                            <b>{selectedMarket?.name || symbol}</b>
                            <span>{symbol}</span>
                            <span className='tk-chip'>Matches</span>
                        </div>
                        <div className='tk-feed'>{status}</div>
                        <div className='tk-command-badge'>ANALYZER COMMAND BUS • V5</div>
                    </div>

                    <div className='tk-chart'>
                        <div className='tk-grid' />
                        {points ? (
                            <svg viewBox='0 0 900 520' preserveAspectRatio='none' className='tk-svg'>
                                <defs>
                                    <linearGradient id='tk-area' x1='0' y1='0' x2='0' y2='1'>
                                        <stop offset='0%' stopColor='rgba(148,163,184,.28)' />
                                        <stop offset='100%' stopColor='rgba(148,163,184,.04)' />
                                    </linearGradient>
                                </defs>
                                <polyline points={`20,500 ${points} 880,500`} fill='url(#tk-area)' stroke='none' />
                                <polyline points={points} fill='none' stroke='#cbd5e1' strokeWidth='1.5' vectorEffect='non-scaling-stroke' />
                            </svg>
                        ) : <div className='tk-chart-empty'>Waiting for live ticks…</div>}

                        <div className='tk-price'>{tick === null ? '—' : tick.toFixed(selectedMarket?.pipSize ?? 2)}</div>
                        <div className='tk-chart-time'>Live • 1 tick stream</div>
                    </div>

                    <div className='tk-bottom-strip'>
                        <div><span>Last digit</span><strong>{digit ?? '—'}</strong></div>
                        <div><span>AI signal</span><strong>{aiDigit ?? '—'}</strong></div>
                        <div><span>AI score</span><strong>{aiScore}%</strong></div>
                        <div className='reason'>{aiReason}</div>
                    </div>
                </main>

                <aside className='tk-trade-panel'>
                    <div className='tk-help'>How to trade Matches? <span>›</span></div>

                    <div className='tk-tabs'>
                        <button className='active'>Matches</button>
                        <button disabled>Differs</button>
                    </div>

                    <div className='tk-panel-section'>
                        <label>Analyzer prediction</label>
                        <div className='digit-grid'>
                            {Array.from({ length: 10 }, (_, d) => (
                                <button
                                    key={d}
                                    className={prediction === d ? 'selected' : ''}
                                    onClick={() => setStatus('Analyzer controls the locked prediction. DBot uses Analyzer signal data only.')}
                                >
                                    <b>{d}</b>
                                    <small>{historyDigits.length ? ((historyDigits.filter(x => x === d).length / historyDigits.length) * 100).toFixed(1) : '—'}%</small>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className='tk-panel-section'>
                        <label>Execution</label>
                        <div className='tk-live-fixed'>1 tick <span>Analyzer signal execution</span></div>
                        <small className='tk-note'>The financial DIGITMATCH proposal executes for 1 tick. Analyzer lifecycle remains OPEN until the Analyzer live stream produces EARLY_SELL_READY for the hot digit.</small>
                    </div>

                    <div className='tk-panel-section'>
                        <label>Stake</label>
                        <input type='number' min='0.35' step='0.01' value={stake} onChange={e => setStake(Math.max(0.35, Number(e.target.value) || 0.35))} />
                    </div>

                    <div className='tk-live-quote'>
                        <div><span>Strategy source</span><strong>TRAPKID ANALYZER ONLY</strong></div>
                        <div><span>Execution gate</span><strong>{analyzerAuthorizedSignalRef.current ? 'AUTHORIZED • ' + analyzerAuthorizedSignalRef.current : trade ? 'COMMAND ACTIVE' : 'LOCKED • ANALYZE MARKET'}</strong></div>
                        <div><span>Live stream</span><strong>{analyzerDetails?.lastTick?.epoch ? 'LIVE TICK' : 'WAITING'}</strong></div>
                        <div><span>Analyzer feed</span><strong>{analyzerDetails?.connected ? 'CONNECTED' : 'DISCONNECTED'}</strong></div>
                        <div><span>Analyzer lifecycle</span><strong>{analyzerDetails?.status === 'EARLY_SELL_READY' || analyzerDetails?.analyzerExitStatus === 'EARLY_SELL_READY' ? 'EARLY_SELL_READY' : trade ? 'ANALYZER_ACTIVE' : 'WAITING'}</strong></div>
                        <div><span>Analyzer exit digit</span><strong>{analyzerDetails?.signal?.hotDigit ?? '—'}</strong></div>
                        <div><span>Analyzer exit event</span><strong>{analyzerDetails?.analyzerExitStatus || 'WAITING_FOR_EARLY_SELL_READY'}</strong></div>
                        <div><span>Analyzer market</span><strong>{analyzerDetails?.symbol || '—'}</strong></div>
                        <div><span>Analyzer signal</span><strong>{analyzerDetails?.signal?.signalId || 'WAITING'}</strong></div>
                        <div><span>Entry digit</span><strong>{analyzerDetails?.signal?.entryDigit ?? '—'}</strong></div>
                        <div><span>Locked entry quote</span><strong>{analyzerDetails?.signal?.entryQuote ?? analyzerDetails?.signal?.lockedQuote ?? '—'}</strong></div>
                        <div><span>Hot digit</span><strong>{analyzerDetails?.signal?.hotDigit ?? analyzerDetails?.analysis?.hotDigit ?? '—'}</strong></div>
                        <div><span>Broker proposal payout</span><strong>{payout ? formatMoney(payout, currency) : '—'}</strong></div>
                        <div><span>Execution transport</span><strong>{contractAvailable ? 'Broker transport only' : 'Unavailable'}</strong></div>
                    </div>

                    <button className='tk-buy tk-run tk-analyzer-trigger' disabled>
                        <span>RUN DISABLED</span>
                        <strong>Analyze Market is the DBot trigger</strong>
                    </button>

                    {trade ? (
                        <div className='tk-active'>
                            <div className='active-title'><span className='pulse' /> ANALYZER COMMAND ACTIVE</div>
                            <div className='active-main'>{trade.symbol} • DIGITMATCH <b>{trade.hotDigit ?? trade.lockedDigit}</b> • 1 TICK EXECUTION</div>
                            <div className='active-meta'>Entry digit: {trade.entryDigit ?? '—'} • Locked entry quote: {analyzerDetails?.signal?.entryQuote ?? analyzerDetails?.signal?.lockedQuote ?? '—'}</div>
                            <div className='active-meta'>MATCH OPEN • waiting for hot digit {trade.hotDigit ?? '—'} • Signal: {trade.signalId}</div>
                        </div>
                    ) : (
                        <button className='tk-buy' disabled>
                            <span>WAITING FOR ANALYZER SIGNAL</span>
                            <strong>Analyze Market starts the execution path</strong>
                        </button>
                    )}

                    {loginHint && <div className='tk-login-hint'>{loginHint}</div>}
                    {error && <div className='tk-error'>{error}</div>}

                    <div className='tk-journal'>
                        <div className='journal-head'><b>Match Journal</b><span>{trades.length}</span></div>
                        {trades.length === 0 ? (
                            <div className='journal-empty'>Trades will appear here after an exit.</div>
                        ) : trades.map((row, i) => (
                            <div className='journal-row' key={`${row.time}-${i}`}>
                                <span>{row.time}</span>
                                <b>{row.digit}</b>
                                <span>{row.result}</span>
                                <strong className={row.pnl >= 0 ? 'profit' : 'loss'}>{row.pnl >= 0 ? '+' : ''}{formatMoney(row.pnl, currency)}</strong>
                            </div>
                        ))}
                    </div>
                </aside>
            </div>

            <div className='tk-disclaimer'>
                <b>ANALYZER-COMMAND DBOT:</b> Analyze Market produces the execution signal. The DBot opens a DIGITMATCH proposal for 1 tick using the Analyzer market and hot digit, while the Analyzer live stream remains authoritative for the Analyzer lifecycle. <b>Match exit:</b> only the same Analyzer signal's <code>EARLY_SELL_READY</code> closes the contract. <code>EARLY_SELL_READY</code> is informational and is never the Match trigger. The locked entry quote is retained as Analyzer transaction metadata.
            </div>
        </div>
    );
};

export default MatchesTerminal;