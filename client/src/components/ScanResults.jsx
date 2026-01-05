import React, { useMemo } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import styles from './ScanResults.module.css';
import clsx from 'clsx';

export function ScanResults() {
    const { activeScan } = useTimeStore();

    const grouped = useMemo(() => {
        if (!activeScan || !activeScan.results) return { pass: [], missed: [] };
        return activeScan.results.reduce((acc, item) => {
            // Logic: Status 'PASS' or explicit 'PASS' string in status
            if (item.status === 'PASS' || (item.status && item.status.includes('PASS'))) {
                acc.pass.push(item);
            } else {
                acc.missed.push(item);
            }
            return acc;
        }, { pass: [], missed: [] });
    }, [activeScan]);

    if (!activeScan) return <div className="card">Loading...</div>;

    return (
        <div className={styles.container}>
            {/* 1. OPPORTUNITIES (PASS) */}
            <section className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className={styles.header} style={{ borderBottomColor: 'var(--success)' }}>
                    <h2 className={styles.title}>OPPORTUNITIES</h2>
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
                                            <span className={styles.ticker}>{item.ticker}</span>
                                            {/* Context Aware Badge */}
                                            {item.marketMood && (
                                                <span className={styles.miniBadge}>{item.marketMood.substring(0, 1)}</span>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        <div className={styles.tags}>
                                            {item.matchedStrategies && item.matchedStrategies.map(s => (
                                                <span key={s} className={styles.strategyTag}>{s}</span>
                                            ))}
                                        </div>
                                    </td>
                                    <td style={{ textAlign: 'right', fontWeight: 700 }}>
                                        {item.score || 0}
                                    </td>
                                </tr>
                            ))}
                            {grouped.pass.length === 0 && (
                                <tr><td colSpan={3} className={styles.empty}>No opportunities found.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* 2. MISSED / WATCHLIST */}
            <section className="card" style={{ height: '40%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className={styles.header} style={{ borderBottomColor: 'var(--warning)' }}>
                    <h2 className={styles.title}>WATCHLIST / MISSED</h2>
                    <span className={styles.countBadge} style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}>
                        {grouped.missed.length}
                    </span>
                </div>

                <div className={styles.tableScroll}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>TICKER</th>
                                <th>REASON</th>
                            </tr>
                        </thead>
                        <tbody>
                            {grouped.missed.map((item, idx) => (
                                <tr key={`${item.ticker}-${idx}`}>
                                    <td style={{ fontWeight: 600 }}>{item.ticker}</td>
                                    <td className={styles.missedReason}>{item.missedReason}</td>
                                </tr>
                            ))}
                            {grouped.missed.length === 0 && (
                                <tr><td colSpan={2} className={styles.empty}>No missed items.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
