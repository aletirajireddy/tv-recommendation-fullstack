import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import styles from './PulseFeed.module.css';
import { format } from 'date-fns';
import { Activity } from 'lucide-react';

export function PulseFeed() {
    const { activeScan } = useTimeStore();

    // Safe access to alerts
    const alerts = activeScan?.institutional_pulse?.alerts || [];

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Activity size={16} />
                <span>PULSE STREAM ({alerts.length})</span>
            </div>

            <div className={styles.feed}>
                {alerts.map((alert) => {
                    const isBull = alert.signal?.di === 1; // 1 = Bull, -2 = Bear usually
                    // Fallback logic if signal not present
                    const type = alert.signal ? (alert.signal.di === 1 ? 'bull' : 'bear') : 'neutral';

                    return (
                        <div key={alert.id} className={`${styles.card} ${styles[type]}`}>
                            <div className={styles.cardHeader}>
                                <span className={styles.ticker}>{alert.asset?.ticker || 'UNKNOWN'}</span>
                                <span className={styles.time}>
                                    {(() => {
                                        const d = new Date(alert.timestamp);
                                        return !isNaN(d.getTime()) ? format(d, 'HH:mm:ss') : '--:--';
                                    })()}
                                </span>
                            </div>
                            <div className={styles.cardBody}>
                                <div className={styles.typeTag}>{alert.signal?.category || 'SIGNAL'}</div>
                                <div className={styles.price}>{alert.signal?.price || '-'}</div>
                            </div>
                        </div>
                    );
                })}

                {alerts.length === 0 && (
                    <div className={styles.empty}>No pulse activity in this scan.</div>
                )}
            </div>
        </div>
    );
}
