import React, { useMemo } from 'react';
import styles from './RecommendationsFeed.module.css';
import { useTimeStore } from '../../store/useTimeStore';
import { Lightbulb, TrendingUp, Anchor, Activity, AlertTriangle } from 'lucide-react';

const StrategyCard = ({ card }) => {
    let Icon = Lightbulb;
    let typeClass = styles.typeNeutral;

    if (card.type === 'opportunity') { Icon = Anchor; typeClass = styles.typeOpp; } // Institutional
    else if (card.type === 'trend') { Icon = TrendingUp; typeClass = styles.typeTrend; }
    else if (card.type === 'risk') { Icon = Activity; typeClass = styles.typeRisk; }
    else if (card.type === 'info') { Icon = AlertTriangle; typeClass = styles.typeInfo; }

    return (
        <div className={`${styles.card} ${typeClass}`}>
            <div className={styles.cardHeader}>
                <Icon size={18} className={styles.icon} />
                <span className={styles.confidence}>{card.confidence.toUpperCase()} CONFIDENCE</span>
            </div>
            <h4 className={styles.title}>{card.title}</h4>
            <p className={styles.description}>{card.description}</p>

            {card.tickers && card.tickers.length > 0 && (
                <div className={styles.tickerList}>
                    {card.tickers.map((t, idx) => (
                        <div key={idx} className={styles.tickerChip}>
                            {t.ticker}
                            {t.bias && <span className={t.bias === 'LONG' ? styles.tagLong : styles.tagShort}>{t.bias}</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default function RecommendationsFeed() {
    const { analyticsData } = useTimeStore();
    const recommendations = analyticsData?.recommendations || [];

    if (recommendations.length === 0) {
        return (
            <div className={styles.emptyState}>
                <Lightbulb size={24} style={{ opacity: 0.5, marginBottom: 10 }} />
                <p>Ensure Time Window is wide enough to detect patterns.</p>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h3>AI STRATEGY ENGINE</h3>
                <span className={styles.badge}>{recommendations.length} Active Contexts</span>
            </div>
            <div className={styles.feed}>
                {recommendations.map(card => (
                    <StrategyCard key={card.id} card={card} />
                ))}
            </div>
        </div>
    );
}
