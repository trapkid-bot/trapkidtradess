import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import './matches-terminal.scss';

// TrapKid Analyzer WS + exact signal handoff

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
};

const ANALYZER_API = (process.env.NEXT_PUBLIC_ANALYZER_API_URL || 'https://thesis-quality-remote-rendered.trycloudflare.com').trim();
const ANALYZER_WS = (process.env.NEXT_PUBLIC_ANALYZER_WS_URL || ANALYZER_API.replace(/^http/i, 'ws')).trim();

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
    const [prediction, setPrediction] = useState(5);
    const [stake, setStake] = useState(2);
    const [holdTicks, setHoldTicks] = useState(10);
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
    const [autoRun, setAutoRun] = useState(false);
    const analyzerDrag = useRef<{ dx: number; dy: number } | null>(null);
    const analyzerSignalRef = useRef<string | null>(null);
    const analyzerTickRef = useRef<number | null>(null);

    const selectedMarket = useMemo(() => markets.find(m => m.symbol === symbol), [markets, symbol]);
    const points = useMemo(() => buildSparkline(prices), [prices]);

    const analyze = useCallback((digits: number[]) => {
        if (!digits.length) return;
        const counts = Array.from({ length: 10 }, (_, d) => digits.filter(x => x === d).length);
        const recent = digits.slice(-30);
        const recentCounts = Array.from({ length: 10 }, (_, d) => recent.filter(x => x === d).length);
        const scores = counts.map((count, d) => count * 0.65 + recentCounts[d] * 1.35);
        const top = scores.indexOf(Math.max(...scores));
        const baseline = digits.length / 10;
        const score = Math.max(0, Math.min(99, ((scores[top] / Math.max(1, baseline)) - 1) * 16 + 50));
        const streak = [...digits].reverse().findIndex(d => d !== top);
        setAiDigit(top);
        setAiScore(Math.round(score));
        setAiReason(
            `Digit ${top} is most frequent in the weighted 100-tick sample; recent-window count ${recentCounts[top]}/${recent.length}.${streak > 1 ? ` Current run: ${streak}.` : ''}`
        );
    }, []);

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

        const applyAnalyzerState = (data: any) => {
            if (cancelled || !data) return;
            setAnalyzerDetails(data);

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

            if (data.lastTick) {
                const quote = Number(data.lastTick.quote);
                const d = Number(data.lastTick.digit);
                const epoch = Number(data.lastTick.epoch);
                const isNewTick = Number.isFinite(epoch) && epoch !== lastEpoch;

                if (isNewTick) {
                    lastEpoch = epoch;
                    if (Number.isFinite(quote)) {
                        setTick(quote);
                        setPrices(prev => [...prev.slice(-99), quote]);
                    }
                    if (Number.isInteger(d)) {
                        setDigit(d);
                        setHistoryDigits(prev => {
                            const next = [...prev.slice(-99), d];
                            analyze(next);
                            return next;
                        });
                    }
                }
            }

            const signal = data.signal;
            if (signal && Number.isInteger(Number(signal.prediction ?? signal.lockedDigit))) {
                const nextPrediction = Number(signal.prediction ?? signal.lockedDigit);
                const nextSignalId = String(signal.signalId || '');
                setPrediction(nextPrediction);
                setAiDigit(nextPrediction);
                if (Number.isFinite(Number(signal.score))) setAiScore(Math.round(Number(signal.score)));
                setAiReason('Analyzer locked digit ' + nextPrediction + (nextSignalId ? ' — ' + nextSignalId : '') + '.');
            } else if (data.analysis) {
                const analysis = data.analysis;
                if (Number.isInteger(Number(analysis.hotDigit))) setAiDigit(Number(analysis.hotDigit));
                if (Number.isFinite(Number(analysis.score))) setAiScore(Math.round(Number(analysis.score)));
                setAiReason('Analyzer hot digit ' + Number(analysis.hotDigit ?? 0) + ' • score ' + Number(analysis.score ?? 0).toFixed(2) + '.');
            }

            setStatus(data.connected ? 'TrapKid Analyzer HTTP LIVE • ' + nextSymbol : 'Analyzer disconnected');
            if (data.connected) setError('');
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
                applyAnalyzerState(data);
            } catch {
                if (!cancelled) setStatus('Analyzer HTTP connection offline');
            } finally {
                polling = false;
            }
        };

        void poll();
        const timer = window.setInterval(poll, 500);

        return () => {
            cancelled = true;
            window.clearInterval(timer);
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

    const requestProposal = useCallback(async (entry: {
        symbol: string;
        prediction: number;
        holdTicks: number;
        stake: number;
    }) => {
        setError('');
        setStatus('Requesting live Match proposal…');
        if (!api_base.is_authorized || !api_base.api) {
            throw new Error('Log in to Deriv first. The existing Deriv account switcher controls demo/real.');
        }

        const response = await sendApiRequest({
            proposal: 1,
            amount: entry.stake,
            basis: 'stake',
            contract_type: 'DIGITMATCH',
            currency,
            duration: entry.holdTicks,
            duration_unit: 't',
            barrier: String(entry.prediction),
            underlying_symbol: entry.symbol,
        });

        if (!response?.proposal) throw new Error('No Match proposal returned by Deriv.');
        const p = response.proposal;
        const ask = Number(p.ask_price ?? p.display_value ?? entry.stake);
        const nextPayout = Number(p.payout ?? p.payout_amount ?? 0);
        setProposalId(String(p.id));
        setPayout(nextPayout || null);
        setStatus(`Proposal ready — ${entry.symbol} / MATCH ${entry.prediction} / ${entry.holdTicks} ticks`);
        return { id: String(p.id), ask, payout: nextPayout };
    }, [currency]);

    const buyFromAnalyzerSignal = useCallback(async (signal: any) => {
        try {
            const signalId = String(signal?.signalId || '');
            const entrySymbol = String(signal?.symbol || analyzerDetails?.symbol || symbol);
            const entryPrediction = Number(signal?.prediction ?? signal?.lockedDigit);
            const entryHoldTicks = Math.max(2, Number(holdTicks));
            const entryStake = Number(stake);

            if (!signalId) throw new Error('Analyzer signal has no signalId.');
            if (!Number.isInteger(entryPrediction)) throw new Error('Analyzer signal has no valid locked digit.');
            if (signal.expiresAt && Number.isFinite(Number(signal.expiresAt)) && Date.now() > Number(signal.expiresAt)) {
                throw new Error('Analyzer signal expired before DBot could open the contract.');
            }
            if (entryHoldTicks < 2) throw new Error('Hold-until-hit mode requires at least 2 ticks.');
            if (tradeRef.current || sellingRef.current) return;

            setError('');
            const proposal = await requestProposal({
                symbol: entrySymbol,
                prediction: entryPrediction,
                holdTicks: entryHoldTicks,
                stake: entryStake,
            });
            const response = await sendApiRequest({ buy: proposal.id, price: Math.max(0, proposal.ask) });
            const b = response?.buy;
            if (!b?.contract_id) throw new Error('Deriv did not return a contract id.');

            const nextTrade: Trade = {
                signalId,
                contractId: String(b.contract_id),
                prediction: entryPrediction,
                symbol: entrySymbol,
                stake: entryStake,
                payout: Number(b.payout ?? proposal.payout ?? 0),
                buyPrice: Number(b.buy_price ?? proposal.ask),
                bidPrice: Number(b.buy_price ?? proposal.ask),
                openedAt: Date.now(),
                holdTicks: entryHoldTicks,
            };

            tradeRef.current = nextTrade;
            sellingRef.current = false;
            setTrade(nextTrade);
            setPrediction(entryPrediction);
            setSymbol(entrySymbol);
            setStatus(`MATCH ${entryPrediction} locked • signal ${signalId} • waiting for digit ${entryPrediction}`);
            setProposalId(null);

            api_base.api?.send({
                proposal_open_contract: 1,
                contract_id: nextTrade.contractId,
                subscribe: 1,
            });
            return true;
        } catch (e: any) {
            setError(e?.message || 'Analyzer signal buy failed');
            setStatus('Analyzer signal received — trade not opened');
            return false;
        }
    }, [analyzerDetails?.symbol, holdTicks, requestProposal, stake, symbol]);

    const buy = useCallback(async () => {
        const signal = analyzerDetails?.signal;
        if (signal?.signalId) return buyFromAnalyzerSignal(signal);
        setError('No locked Analyzer signal is available yet.');
        setStatus('Waiting for Analyzer signal');
        return false;
    }, [analyzerDetails, buyFromAnalyzerSignal]);

    const exitOnHit = async (active: Trade, quote: number, hitDigit: number) => {
        try {
            if (!api_base.api) throw new Error('Deriv connection is not available.');
            const bid = Number(tradeRef.current?.bidPrice ?? active.bidPrice ?? 0);
            if (!Number.isFinite(bid) || bid <= 0) {
                throw new Error('The broker has not returned a positive resale price yet; the position was not force-sold at an arbitrary price.');
            }
            const response = await sendApiRequest({
                sell: active.contractId,
                price: bid,
            });

            const sold = response?.sell;
            const soldFor = Number(sold?.sold_for ?? bid);
            const pnl = soldFor - active.buyPrice;

            setTrades(prev => [
                {
                    time: new Date().toLocaleTimeString(),
                    digit: hitDigit,
                    result: 'EXIT ON HIT',
                    pnl,
                },
                ...prev,
            ].slice(0, 20));

            setStatus(`Digit ${hitDigit} appeared — contract sold early at ${formatMoney(soldFor, currency)}`);
            setTrade(null);
            tradeRef.current = null;
            sellingRef.current = false;
            void quote;
        } catch (e: any) {
            setError(e?.message || 'Early exit failed');
            setStatus('Target appeared, but the broker rejected the early sale.');
            sellingRef.current = false;
        }
    };

    useEffect(() => {
        const signal = analyzerDetails?.signal;
        const signalId = String(signal?.signalId || '');
        if (!autoRun || !signalId || analyzerSignalRef.current === signalId) return;

        const signalReady =
            signal.exitStatus !== 'EARLY_EXIT_TRIGGERED' &&
            signal.exitStatus !== 'EXPIRED' &&
            signal.earlyExit !== true &&
            (!signal.expiresAt || Date.now() <= Number(signal.expiresAt));

        if (!signalReady) return;

        if (!tradeRef.current && !sellingRef.current) {
            analyzerSignalRef.current = signalId;
            void buyFromAnalyzerSignal(signal).then(ok => {
                if (!ok) analyzerSignalRef.current = null;
            });
        }
    }, [analyzerDetails, autoRun, buy]);

    useEffect(() => {
        const tick = analyzerDetails?.lastTick;
        if (!tick) return;

        const epoch = Number(tick.epoch);
        const quote = Number(tick.quote);
        const d = Number(tick.digit);
        if (!Number.isFinite(epoch) || analyzerTickRef.current === epoch) return;
        analyzerTickRef.current = epoch;

        const active = tradeRef.current;
        const analyzerExit = analyzerDetails?.exit;
        const exitReady = analyzerExit?.status === 'EARLY_SELL_READY';
        const exitDigit = Number(analyzerExit?.digit);
        const exitQuote = Number(analyzerExit?.quote);

        if (
            active &&
            !sellingRef.current &&
            exitReady &&
            Number.isInteger(exitDigit) &&
            exitDigit === active.prediction &&
            String(analyzerDetails?.signal?.signalId || '') === active.signalId
        ) {
            sellingRef.current = true;
            void exitOnHit(
                active,
                Number.isFinite(exitQuote) ? exitQuote : quote,
                exitDigit
            );
            return;
        }

        if (active && Number.isInteger(d) && Number.isFinite(quote) && d === active.prediction && !sellingRef.current) {
            sellingRef.current = true;
            void exitOnHit(active, quote, d);
        }
    }, [analyzerDetails, trade]);

    const toggleRun = useCallback(() => {
        if (autoRun) {
            setAutoRun(false);
            setStatus('Analyzer DBot stopped — no new automatic entries.');
            return;
        }

        if (!api_base.is_authorized || !api_base.api) {
            setError('Log in to Deriv first. Analyzer data is live, but broker execution needs your authenticated account.');
            return;
        }

        // Reset the consumed-signal guard so RUN can execute the signal currently
        // displayed by the Analyzer, then follow every new signal exactly once.
        analyzerSignalRef.current = null;
        setAutoRun(true);
        setError('');
        setStatus('Analyzer DBot RUNNING — using the current Analyzer signal and live Analyzer ticks.');

    }, [autoRun]);

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
                        <div className='tk-brand-sub'>Deriv broker • Match-only terminal</div>
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
                                onClick={() => selectMarket(m.symbol)}
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
                        <label>Last digit prediction</label>
                        <div className='digit-grid'>
                            {Array.from({ length: 10 }, (_, d) => (
                                <button
                                    key={d}
                                    className={prediction === d ? 'selected' : ''}
                                    onClick={() => {
                                        if (autoRun) {
                                            setStatus('Analyzer controls the locked prediction while DBot RUN is active.');
                                            return;
                                        }
                                        setPrediction(d);
                                    }}
                                >
                                    <b>{d}</b>
                                    <small>{historyDigits.length ? ((historyDigits.filter(x => x === d).length / historyDigits.length) * 100).toFixed(1) : '—'}%</small>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className='tk-panel-section'>
                        <label>Hold-until-hit window</label>
                        <select value={holdTicks} onChange={e => setHoldTicks(Number(e.target.value))}>
                            {[2, 3, 5, 7, 10].map(n => <option key={n} value={n}>{n} ticks</option>)}
                        </select>
                        <small className='tk-note'>The native 1-tick Match would settle immediately. This terminal uses a longer open contract and attempts an early broker sell when the locked digit appears.</small>
                    </div>

                    <div className='tk-panel-section'>
                        <label>Stake</label>
                        <input type='number' min='0.35' step='0.01' value={stake} onChange={e => setStake(Math.max(0.35, Number(e.target.value) || 0.35))} />
                    </div>

                    <div className='tk-live-quote'>
                        <div><span>Analyzer feed</span><strong>{analyzerDetails?.connected ? 'CONNECTED' : 'DISCONNECTED'}</strong></div>
                        <div><span>Analyzer market</span><strong>{analyzerDetails?.symbol || '—'}</strong></div>
                        <div><span>Broker proposal payout</span><strong>{payout ? formatMoney(payout, currency) : '—'}</strong></div>
                        <div><span>Execution</span><strong>{contractAvailable ? 'Deriv authenticated' : 'Unavailable'}</strong></div>
                    </div>

                    <button
                        className={autoRun ? 'tk-buy tk-run active' : 'tk-buy tk-run'}
                        onClick={toggleRun}
                        disabled={!api_base.is_authorized}
                    >
                        <span>{autoRun ? 'STOP DBOT' : 'RUN DBOT'}</span>
                        <strong>{autoRun ? 'Auto-follow Analyzer signals' : 'Follow Analyzer market + prediction'}</strong>
                    </button>

                    {trade ? (
                        <div className='tk-active'>
                            <div className='active-title'><span className='pulse' /> MATCH {trade.prediction} ACTIVE</div>
                            <div className='active-main'>Waiting for <b>{trade.prediction}</b></div>
                            <div className='active-meta'>Exit price: {formatMoney(trade.bidPrice || 0, currency)}</div>
                        </div>
                    ) : (
                        <button className='tk-buy' onClick={buy} disabled={!autoRun || !contractAvailable || !!proposalId || holdTicks < 2}>
                            <span>{autoRun ? `Armed: Match ${prediction}` : 'Start DBot first'}</span>
                            <strong>{autoRun ? (payout ? `Payout ${payout.toFixed(2)} ${currency}` : 'Waiting for Analyzer signal') : 'Analyzer-controlled execution'}</strong>
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
                <b>Data flow:</b> TrapKid Analyzer is the source of truth for the selected market, live ticks, digits and locked signals. The DBot no longer subscribes to a separate Deriv market tick stream for strategy decisions. The authenticated Deriv connection is used only for account/balance data and the broker operations required to open and close the contract. <b>Execution note:</b> Deriv remains the broker for contract execution. A Match contract normally settles at its expiry. “Hold until digit appears” here means the app buys a longer-lived Match contract and sends an authenticated <code>sell</code> request when the locked digit appears; the broker records that as an early sale, not as a native 1-tick Match settlement.
            </div>
        </div>
    );
};

export default MatchesTerminal;
