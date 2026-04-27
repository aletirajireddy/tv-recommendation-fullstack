import React, { useState, useEffect, useCallback, Component } from 'react';
import styles from './DailyCalendarWidget.module.css';

// Prevent a bad heatmap row from blanking the entire page.
class DrillErrorBoundary extends Component {
    constructor(props) { super(props); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    render() {
        if (this.state.err) {
            return (
                <div style={{ padding: '20px 16px', color: '#fc8181', fontSize: 13 }}>
                    ⚠ Failed to render drill-down: {this.state.err.message}
                    <br />
                    <button style={{ marginTop: 8, color: '#63b3ed', background: 'none', border: '1px solid #63b3ed', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
                        onClick={() => this.setState({ err: null })}>
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

/**
 * DailyCalendarWidget — 7-day grid showing market mood + trial outcomes per day.
 *
 * Per Q3/Q4: 7 days lookback, compact cells, click-through opens drill-down
 * heatmap modal showing every coin tracked that day with both day Δ% and
 * per-ticker trial win rate side-by-side.
 *
 * Use case: Spot opposite-direction opportunities (market falling but specific
 * coins ripping, or vice versa).
 */
export function DailyCalendarWidget() {
    const [calendar, setCalendar] = useState([]);
    const [loading, setLoading] = useState(true);
    const [drillDate, setDrillDate] = useState(null);

    const load = useCallback(async () => {
        try {
            const r = await fetch('/api/calendar/daily?days=7');
            if (r.ok) setCalendar((await r.json()).calendar || []);
        } catch {} finally { setLoading(false); }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
        return () => clearInterval(id);
    }, [load]);

    return (
        <div className={styles.widget}>
            <div className={styles.header}>
                <h3 className={styles.title}>📅 Daily Performance Calendar (7d)</h3>
                <span className={styles.hint}>Click any day for full coin heatmap →</span>
            </div>

            {loading ? (
                <div className={styles.loading}>Loading…</div>
            ) : (
                <div className={styles.grid}>
                    {calendar.map(day => <DayCell key={day.date} day={day} onClick={() => setDrillDate(day.date)} />)}
                </div>
            )}

            {drillDate && (
                <DrillErrorBoundary key={drillDate}>
                    <DayDrillModal date={drillDate} onClose={() => setDrillDate(null)} />
                </DrillErrorBoundary>
            )}
        </div>
    );
}

function DayCell({ day, onClick }) {
    const moodCls = MOOD_CLASS[day.market.mood] || styles.moodUnknown;
    const wr = day.trials.win_rate_pct;
    const wrCls = wr == null ? '' : wr >= 60 ? styles.wrHigh : wr >= 45 ? styles.wrMed : styles.wrLow;
    const dayLabel = new Date(day.date + 'T12:00:00Z').toLocaleDateString([], { weekday: 'short', day: 'numeric' });

    const topGain = day.top_gainers[0];
    const topLose = day.top_losers[0];

    return (
        <div className={`${styles.cell} ${moodCls}`} onClick={onClick}>
            <div className={styles.cellHead}>
                <span className={styles.cellDate}>{dayLabel}</span>
                <span className={styles.cellMood}>{day.market.mood}</span>
            </div>
            {day.market.score != null && (
                <div className={styles.cellScore}>
                    Mood: <strong>{day.market.score > 0 ? '+' : ''}{day.market.score}</strong>
                </div>
            )}
            <div className={styles.cellTrials}>
                <span>{day.trials.total} trials</span>
                {wr != null && <span className={wrCls}>WR {wr}%</span>}
            </div>
            {(topGain || topLose) && (
                <div className={styles.cellMovers}>
                    {topGain && <div className={styles.gain}>▲ {shortTicker(topGain.ticker)} {fmtPct(topGain.change_pct)}</div>}
                    {topLose && topLose.change_pct < 0 && <div className={styles.lose}>▼ {shortTicker(topLose.ticker)} {fmtPct(topLose.change_pct)}</div>}
                </div>
            )}
            <div className={styles.cellFooter}>{day.coins_tracked} coins tracked</div>
        </div>
    );
}

function DayDrillModal({ date, onClose }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [sortBy, setSortBy] = useState('change_pct'); // change_pct | win_rate | range_pct

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/calendar/day/${date}`)
            .then(r => r.json())
            .then(j => { if (!cancelled) { if (j.error) setError(j.error); else setData(j); } })
            .catch(e => !cancelled && setError(e.message));
        return () => { cancelled = true; };
    }, [date]);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const sorted = data?.heatmap ? [...data.heatmap].sort((a, b) => {
        if (sortBy === 'win_rate') return (b.trials.win_rate_pct ?? -1) - (a.trials.win_rate_pct ?? -1);
        if (sortBy === 'range_pct') return b.range_pct - a.range_pct;
        return b.change_pct - a.change_pct;
    }) : [];

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div className={styles.modal}>
                <div className={styles.modalHeader}>
                    <h3>📊 {new Date(date + 'T12:00:00Z').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })} — Coin Heatmap</h3>
                    <button onClick={onClose} className={styles.closeBtn}>✕ Close (Esc)</button>
                </div>

                {error && <div className={styles.error}>Error: {error}</div>}
                {!data && !error && <div className={styles.loading}>Loading…</div>}

                {data && (
                    <>
                        <div className={styles.sortRow}>
                            <span>Sort by:</span>
                            <button className={sortBy === 'change_pct' ? styles.sortActive : ''} onClick={() => setSortBy('change_pct')}>Day Δ%</button>
                            <button className={sortBy === 'win_rate' ? styles.sortActive : ''} onClick={() => setSortBy('win_rate')}>Trial Win Rate</button>
                            <button className={sortBy === 'range_pct' ? styles.sortActive : ''} onClick={() => setSortBy('range_pct')}>Range %</button>
                            <span className={styles.coinCount}>{data.coin_count} coins</span>
                        </div>

                        <div className={styles.heatTableWrap}>
                            <table className={styles.heatTable}>
                                <thead>
                                    <tr>
                                        <th>Ticker</th>
                                        <th>Open → Close</th>
                                        <th>Day Δ%</th>
                                        <th>Range %</th>
                                        <th>Trials</th>
                                        <th>L/S</th>
                                        <th>Win Rate</th>
                                        <th>Verdict Mix</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sorted.map(row => <HeatRow key={row.ticker} row={row} />)}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </>
    );
}

function HeatRow({ row }) {
    const chgCls = row.change_pct > 1 ? styles.gainStrong : row.change_pct > 0 ? styles.gain : row.change_pct < -1 ? styles.loseStrong : styles.lose;
    // Null-guard: trials may be absent on very fresh rows before the endpoint builds it
    const trials = row.trials || {};
    const wr = trials.win_rate_pct;
    const wrCls = wr == null ? styles.muted : wr >= 60 ? styles.wrHigh : wr >= 45 ? styles.wrMed : styles.wrLow;
    return (
        <tr>
            <td><strong>{row.ticker}</strong></td>
            <td className={styles.muted}>{Number(row.open || 0).toFixed(4)} → {Number(row.close || 0).toFixed(4)}</td>
            <td className={chgCls}>{fmtPct(row.change_pct)}</td>
            <td className={styles.muted}>{(row.range_pct ?? 0).toFixed(2)}%</td>
            <td>{trials.total ?? 0}</td>
            <td className={styles.muted}>{trials.longs ?? 0}L / {trials.shorts ?? 0}S</td>
            <td className={wrCls}>{wr == null ? '—' : `${wr}%`}</td>
            <td className={styles.verdictMix}>
                {(trials.confirmed > 0) && <span className={styles.vConfirmed}>✓{trials.confirmed}</span>}
                {(trials.failed > 0) && <span className={styles.vFailed}>✗{trials.failed}</span>}
                {(trials.neutral > 0) && <span className={styles.vNeutral}>·{trials.neutral}</span>}
            </td>
        </tr>
    );
}

const MOOD_CLASS = {
    EUPHORIC: styles.moodEuphoric, BULLISH: styles.moodBullish,
    NEUTRAL: styles.moodNeutral, RANGING: styles.moodNeutral,
    BEARISH: styles.moodBearish, PANIC: styles.moodPanic,
    UNKNOWN: styles.moodUnknown,
};

function shortTicker(t) {
    if (!t) return '';
    return t.replace('BINANCE:', '').replace('OKX:', '').replace('USDT.P', '').replace('USDT', '');
}
function fmtPct(v) {
    if (v == null || isNaN(v)) return '—';
    return `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}
