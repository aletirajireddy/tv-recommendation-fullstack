import React, { useEffect } from 'react';
import { Activity, HelpCircle } from 'lucide-react';
import { useTimeStore } from '../store/useTimeStore';
import styles from './AnalyticsDashboard.module.css';

// Research Widgets
import { PersistenceChart } from './ResearchWidgets/PersistenceChart';
import { PulseVelocityChart } from './ResearchWidgets/PulseVelocityChart';
import { RejectionPieChart } from './ResearchWidgets/RejectionPieChart';
import { SentimentGauge } from './ResearchWidgets/SentimentGauge';
import { LatencyCard } from './ResearchWidgets/LatencyCard';

export function AnalyticsDashboard() {
    const { fetchResearch, researchData } = useTimeStore();

    // Data is pre-fetched by useTimeStore during app init and updates.
    // relying on 'researchData' subscription.

    if (!researchData) {
        console.log('[AnalyticsDashboard] WAITING for researchData...');
        return <div className={styles.loading}>Loading Research Data...</div>;
    }

    console.log('[AnalyticsDashboard] RENDER with data:', {
        velocity: researchData.velocity?.length,
        persistence: researchData.persistence?.length
    });

    return (
        <div className={styles.container}>
            {/* 1. SPEEDOMETER (Pulse Velocity) - Full Width */}
            <div className={`${styles.card} ${styles.fullWidth}`}>
                <div className={styles.cardHeader}>
                    <h3>MARKET VELOCITY (Alerts/Min)</h3>
                    <span className={styles.tag}>SPEED</span>
                </div>
                <PulseVelocityChart data={researchData.velocity} />
            </div>

            {/* 2. RADAR (Persistence) - Col 1 */}
            <div className={styles.card}>
                <div className={styles.cardHeader}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h3>PERSISTENCE RADAR</h3>
                        <div title="Tracks how many consecutive scans a ticker has appeared in. Assets lock on after 1 scan.">
                            <HelpCircle size={14} color="var(--text-tertiary)" />
                        </div>
                    </div>
                    <span className={styles.tag}>LOCKED</span>
                </div>
                <PersistenceChart data={researchData.persistence} />
            </div>

            {/* 3. REJECTIONS - Col 2 */}
            <div className={styles.card}>
                <div className={styles.cardHeader}>
                    <h3>REJECTION DIAGNOSTICS</h3>
                    <span className={styles.tag}>FILTER</span>
                </div>
                <RejectionPieChart data={researchData.rejections} />
            </div>

            {/* 4. SENSORS - Col 3 (Vertical Stack) */}
            <div className={styles.sensorGrid}>
                <div className={`${styles.card} ${styles.sensorCard}`} style={{ justifyContent: 'center', alignItems: 'center', padding: '0.5rem' }}>
                    <SentimentGauge score={researchData.moodScore} />
                </div>
                <LatencyCard ms={researchData.latency} />
            </div>
        </div>
    );
}
