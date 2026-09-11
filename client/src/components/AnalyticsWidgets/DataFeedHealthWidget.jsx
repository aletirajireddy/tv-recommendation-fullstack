// Data Feed Health — detects the "frozen browser tab" failure mode: a
// backgrounded/inactive TradingView tab keeps sending the SAME scraped
// values with a FRESH timestamp, so every other freshness indicator in this
// app (the A/B/C/D header dots, /api/stream-sync) stays green the whole
// time. This widget checks whether values are actually changing, not just
// whether a row was recently written.

import React from 'react';
import { Radar, AlertTriangle, WifiOff, CheckCircle2 } from 'lucide-react';
import { FreshnessChip } from '../FreshnessChip';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import styles from './DataFeedHealthWidget.module.css';

const STREAM_LABELS = {
    A: 'A · Macro Scan',
    B: 'B · Watchlist',
    C: 'C · Webhooks',
    D: 'D · Technicals',
};

const STATUS_META = {
    healthy: { pill: styles.pillHealthy, card: styles.cardHealthy, icon: CheckCircle2, label: 'LIVE' },
    stalled: { pill: styles.pillStalled, card: styles.cardStalled, icon: WifiOff, label: 'STALLED' },
    frozen:  { pill: styles.pillFrozen,  card: styles.cardFrozen,  icon: AlertTriangle, label: 'FROZEN' },
};

function fmtAge(min) {
    if (min == null) return '—';
    if (min < 1) return '<1m';
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function StreamCard({ streamKey, data }) {
    const meta = STATUS_META[data.status] || STATUS_META.healthy;
    const Icon = meta.icon;

    return (
        <div className={`${styles.card} ${meta.card}`}>
            <div className={styles.cardHead}>
                <span className={styles.streamLabel}>{STREAM_LABELS[streamKey] || streamKey}</span>
                <span className={`${styles.statusPill} ${meta.pill}`}>
                    <Icon size={10} /> {meta.label}
                </span>
            </div>

            <div className={styles.metaRow}>
                <span>Last write</span>
                <span>{fmtAge(data.lastWriteAgeMinutes)} ago</span>
            </div>
            <div className={styles.metaRow}>
                <span>Tickers tracked</span>
                <span>{data.totalTickers}</span>
            </div>

            {data.frozenTickers.length > 0 ? (
                <div className={styles.frozenList}>
                    {data.frozenTickers.map(f => (
                        <div key={f.ticker} className={styles.frozenRow} title={`Unchanged since ${f.frozenSince}`}>
                            <span className={styles.frozenTicker}>{f.ticker}</span>
                            <span className={styles.frozenMinutes}>{fmtAge(f.frozenMinutes)} stuck</span>
                        </div>
                    ))}
                </div>
            ) : data.status !== 'stalled' ? (
                <div className={styles.emptyState}>No frozen tickers</div>
            ) : (
                <div className={styles.emptyState}>No new data at all — check the source tab</div>
            )}
        </div>
    );
}

export function DataFeedHealthWidget() {
    const { data, loading, lastFetchedAt } = usePolledFetch(
        () => '/api/system/feed-health',
        { intervalMs: 60_000 }
    );

    return (
        <div className={styles.widget}>
            <div className={styles.header}>
                <Radar size={18} style={{ color: 'var(--accent-blue)' }} />
                <span className={styles.titleText}>Data Feed Health</span>
                <FreshnessChip ts={lastFetchedAt} title="Last checked" />
            </div>
            <div className={styles.subtitle}>
                Detects frozen/backgrounded scraper tabs — same values repeating with only the timestamp advancing.
            </div>

            {!data ? (
                <div className={styles.loading}>{loading ? 'Checking feeds…' : 'No data'}</div>
            ) : (
                <div className={styles.grid}>
                    {['A', 'B', 'C', 'D'].map(k => (
                        <StreamCard key={k} streamKey={k} data={data.streams[k]} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default DataFeedHealthWidget;
