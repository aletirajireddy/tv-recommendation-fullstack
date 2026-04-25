import React, { useState, useEffect } from 'react';
import styles from './GhostCoinWidget.module.css';

export function GhostCoinWidget() {
    const [queue, setQueue] = useState([]);
    const [autoApprove, setAutoApprove] = useState(false);
    const [loading, setLoading] = useState(true);

    const fetchQueue = async () => {
        try {
            const res = await fetch('/api/ghosts/queue');
            if (res.ok) {
                const data = await res.json();
                setQueue(data.queue || []);
                setAutoApprove(data.auto_approve || false);
            }
        } catch (e) {
            console.error("Failed to fetch ghost queue", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchQueue();
        const interval = setInterval(fetchQueue, 5000); // Poll every 5s for UI live updates
        return () => clearInterval(interval);
    }, []);

    const toggleAutoApprove = async () => {
        const newValue = !autoApprove;
        setAutoApprove(newValue);
        try {
            await fetch('/api/ghosts/toggle-auto', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: newValue })
            });
            fetchQueue();
        } catch (e) {
            console.error(e);
            setAutoApprove(!newValue);
        }
    };

    const approveAll = async () => {
        try {
            await fetch('/api/ghosts/approve-all', { method: 'POST' });
            fetchQueue();
        } catch (e) {
            console.error(e);
        }
    };

    const approveCoin = async (ticker) => {
        try {
            await fetch('/api/ghosts/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker })
            });
            fetchQueue();
        } catch (e) {
            console.error(e);
        }
    };

    if (loading) return null;

    if (queue.length === 0 && !autoApprove) {
        return (
            <div className={`${styles.widget} ${styles.widgetEmpty}`}>
                <div className={styles.header}>
                    <h4>Ghost Approvals (0)</h4>
                    <div className={styles.toggleRow}>
                        <span className={styles.toggleLabel}>Auto-Prune</span>
                        <label className={styles.switch}>
                            <input type="checkbox" checked={autoApprove} onChange={toggleAutoApprove} />
                            <span className={styles.slider}></span>
                        </label>
                    </div>
                </div>
                <div className={styles.emptyState}>No Ghost Coins in Queue</div>
            </div>
        );
    }

    return (
        <div className={styles.widget}>
            <div className={styles.header}>
                <h4>
                    <span className={styles.pulseIcon}>🟠</span> Ghost Approvals ({queue.length})
                </h4>
                <div className={styles.headerActions}>
                    <div className={styles.toggleRow}>
                        <span className={styles.toggleLabel}>Auto-Prune</span>
                        <label className={styles.switch}>
                            <input type="checkbox" checked={autoApprove} onChange={toggleAutoApprove} />
                            <span className={styles.slider}></span>
                        </label>
                    </div>
                    {queue.length > 0 && !autoApprove && (
                        <button className={styles.approveAllBtn} onClick={approveAll}>
                            Approve All
                        </button>
                    )}
                </div>
            </div>

            <div className={styles.list}>
                {queue.map(coin => {
                    const timeInQueue = Math.floor((Date.now() - new Date(coin.queued_at).getTime()) / 60000);
                    const score = coin.confidence_score;
                    const bd = coin.score_breakdown;
                    const confLabel = bd?.confidence || null;
                    const confColor = confLabel === 'HIGH' ? '#68d391' : confLabel === 'MEDIUM' ? '#f6ad55' : confLabel === 'LOW' ? '#fc8181' : '#718096';
                    const barWidth = score != null ? `${Math.min(100, score)}%` : '0%';

                    return (
                        <div key={coin.ticker} className={styles.coinRow}>
                            <div className={styles.coinInfo}>
                                <div className={styles.ticker}>{coin.ticker}</div>
                                <div className={styles.reason}>{coin.reason} ({timeInQueue}m ago)</div>

                                {/* Confidence score bar */}
                                {score != null && (
                                    <div style={{ marginTop: 5 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2, color: '#a0aec0' }}>
                                            <span>Confidence</span>
                                            <span style={{ color: confColor, fontWeight: 600 }}>{score.toFixed(1)} — {confLabel}</span>
                                        </div>
                                        <div style={{ height: 4, background: 'rgba(255,255,255,0.07)', borderRadius: 2, overflow: 'hidden' }}>
                                            <div style={{ height: '100%', width: barWidth, background: confColor, borderRadius: 2, transition: 'width 0.4s' }} />
                                        </div>
                                        {bd && (
                                            <div style={{ fontSize: 9, color: '#718096', marginTop: 3, display: 'flex', gap: 8 }}>
                                                <span>WR: {bd.base_win_rate}%</span>
                                                <span>Regime: {bd.regime_mood} ×{bd.regime_multiplier}</span>
                                                <span>Dir: {bd.direction_used || '?'}</span>
                                                {bd.sample_count != null && <span>n={bd.sample_count}</span>}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                            <button className={styles.approveBtn} onClick={() => approveCoin(coin.ticker)}>
                                Prune
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
