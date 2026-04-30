import React, { useMemo, useRef } from 'react';
import styles from './CoinAgeWidget.module.css';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';

const formatAge = (ms) => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ${hours % 24}h`;
    const months = Math.floor(days / 30);
    return `${months}mo ${days % 30}d`;
};

const getCategory = (ms) => {
    const minutes = ms / 60000;
    if (minutes < 60) return { label: 'NEWBORN', class: styles.catNewborn };
    if (minutes < 24 * 60) return { label: 'ESTABLISHED', class: styles.catEstablished };
    if (minutes < 7 * 24 * 60) return { label: 'VETERAN', class: styles.catVeteran };
    return { label: 'SYSTEM FIXTURE', class: styles.catFixture };
};

export function CoinAgeWidget() {
    const containerRef = useRef(null);
    const lastDataPush = useTimeStore(s => s.lastDataPush);

    // Push-first: primary trigger is lastDataPush (socket event); 5-min poll is
    // a safety net for missed socket events — NOT the main refresh mechanism.
    const { data: coins, loading, reloadSilent } = usePolledFetch(
        () => '/api/coins/age',
        { intervalMs: 300_000, initialData: [] } // initialData:[] avoids null on first render
    );

    // Visible widget reloads immediately on push; off-screen deferred via stagger queue.
    useDataInvalidation(containerRef, reloadSilent, lastDataPush);

    if (loading && coins.length === 0) return null;
    if (coins.length === 0) return null;

    // Grouping
    const grouped = {
        NEWBORN: [],
        ESTABLISHED: [],
        VETERAN: [],
        'SYSTEM FIXTURE': []
    };

    coins.forEach(c => {
        const ageMs = Date.now() - new Date(c.born_at).getTime();
        const cat = getCategory(ageMs);
        grouped[cat.label].push({ ...c, ageFormat: formatAge(ageMs), catClass: cat.class });
    });

    const categories = [
        { key: 'NEWBORN', title: '🚀 FRESH MOMENTUM (< 1H)' },
        { key: 'ESTABLISHED', title: '📈 ESTABLISHED TREND (1H - 24H)' },
        { key: 'VETERAN', title: '🏛️ SYSTEM VETERAN (1D - 7D)' },
        { key: 'SYSTEM FIXTURE', title: '🦕 SYSTEM FIXTURE (> 7D)' }
    ];

    return (
        <div ref={containerRef} className={styles.widgetWrapper}>
            <h3 className="widget-title">COIN LIFECYCLE TRACKER (TIME IN SYSTEM)</h3>
            <div className={styles.grid}>
                {categories.map(cat => (
                    <div key={cat.key} className={`${styles.card} ${grouped[cat.key].length === 0 ? styles.cardEmpty : ''}`}>
                        <div className={styles.cardHeader}>{cat.title} <span className={styles.countBadge}>{grouped[cat.key].length}</span></div>
                        <div className={styles.list}>
                            {grouped[cat.key].length === 0 ? (
                                <div className={styles.emptyText}>--</div>
                            ) : (
                                grouped[cat.key].map(coin => (
                                    <div key={coin.ticker} className={`${styles.row} ${coin.catClass}`}>
                                        <div className={styles.tickerGroup}>
                                            <span className={styles.ticker}>{coin.ticker}</span>
                                            {coin.status === 'GHOST' && <span className={styles.ghostIcon} title="In Ghost Queue">👻</span>}
                                        </div>
                                        <span className={styles.ageBadge}>{coin.ageFormat}</span>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
