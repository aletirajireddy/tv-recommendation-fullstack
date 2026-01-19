import React, { useMemo } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import GenieSmart from '../services/GenieSmart';
import styles from './ScanResults.module.css';

export function ScanResults() {
    const { activeScan } = useTimeStore();

    const grouped = useMemo(() => {
        if (!activeScan || !activeScan.results) return { pass: [], missed: [] };

        return activeScan.results.reduce((acc, item) => {
            // GENIE SMART: Derive strategies on the fly
            const strategies = GenieSmart.deriveStrategies(item);

            // Enrich item with derived strategies for display
            const enrichedItem = { ...item, matchedStrategies: strategies.map(s => s.label || s.name) };

            if (strategies.length > 0) {
                acc.pass.push(enrichedItem);
            } else {
                acc.missed.push(enrichedItem);
            }
            return acc;
        }, { pass: [], missed: [] });
    }, [activeScan]);

    if (!activeScan) return <div className="card">Loading...</div>;

    return (
        <div className={styles.container}>
            {/* 1. GENIE OPPORTUNITIES */}
            <section className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className={styles.header} style={{ borderBottomColor: 'var(--success)' }}>
                    <h2 className={styles.title}>GENIE OPPORTUNITIES</h2>
                    <span className={styles.countBadge} style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success-text)' }}>
                        {grouped.pass.length}
                    </span>
                </div>

                <div className={styles.tableScroll}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>TICKER</th>
                                <th>STRATEGY</th>
                                <th style={{ textAlign: 'right' }}>SCORE</th>
                            </tr>
                        </thead>
                        <tbody>
                            {grouped.pass.map((item, idx) => (
                                <tr key={`${item.ticker}-${idx}`}>
                                    <td>
                                        <div className={styles.tickerCell}>
                                            <span className={styles.ticker} style={{ fontWeight: 800 }}>{item.ticker}</span>
                                            {item.bias && (
                                                <span className={styles.miniBadge} style={{
                                                    color: item.bias === 'BULLISH' ? 'var(--success)' : 'var(--error)'
                                                }}>
                                                    {item.bias === 'BULLISH' ? '▲' : '▼'}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        <div className={styles.tags}>
                                            {item.matchedStrategies.map(s => (
                                                <span key={s} className={styles.strategyTag}>{s}</span>
                                            ))}
                                        </div>
                                    </td>
                                    <td style={{ textAlign: 'right', fontWeight: 700, color: (item.score > 0 ? 'var(--success)' : 'var(--text-primary)') }}>
                                        {item.score || 0}
                                    </td>
                                </tr>
                            ))}
                            {grouped.pass.length === 0 && (
                                <tr><td colSpan={3} className={styles.empty}>No generic opportunities.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* 2. WATCHLIST (No specific strategy yet) */}
            <section className="card" style={{ height: '40%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className={styles.header} style={{ borderBottomColor: 'var(--warning)' }}>
                    <h2 className={styles.title}>WATCHLIST</h2>
                    <span className={styles.countBadge} style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}>
                        {grouped.missed.length}
                    </span>
                </div>

                <div className={styles.tableScroll}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>TICKER</th>
                                <th>CONTEXT</th>
                            </tr>
                        </thead>
                        <tbody>
                            {grouped.missed.map((item, idx) => (
                                <tr key={`${item.ticker}-${idx}`}>
                                    <td style={{ fontWeight: 600 }}>{item.ticker}</td>
                                    <td className={styles.missedReason}>
                                        {item.missedReason || (item.label ? item.label : 'Monitoring...')}
                                    </td>
                                </tr>
                            ))}
                            {grouped.missed.length === 0 && (
                                <tr><td colSpan={2} className={styles.empty}>No watchlist items.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
