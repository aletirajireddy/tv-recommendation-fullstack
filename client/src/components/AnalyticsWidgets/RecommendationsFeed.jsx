import React, { useMemo, useEffect, useState } from 'react';
import styles from './RecommendationsFeed.module.css';
import { useTimeStore } from '../../store/useTimeStore';
import GenieSmart from '../../services/GenieSmart';
import { Lightbulb, TrendingUp, Anchor, Activity, AlertTriangle, Clock } from 'lucide-react';

const timeAgo = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
};

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
                <span className={styles.confidence}>{(card.confidence || 'UNKNOWN').toUpperCase()} CONFIDENCE</span>
            </div>
            <h4 className={styles.title}>{card.title}</h4>
            <p className={styles.description}>{card.description}</p>

            {card.tickers && card.tickers.length > 0 && (
                <div className={styles.tickerList} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {card.tickers.map((t, idx) => (
                        <div key={idx} className={styles.tickerChip} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: '6px 8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontWeight: 600 }}>{t.ticker}</span>
                                {t.bias && <span className={(t.bias === 'LONG' || t.bias === 'BULL') ? styles.tagLong : styles.tagShort}>{t.bias}</span>}
                            </div>
                            {t.scanTime && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-tertiary)', fontSize: '10px' }}>
                                    <Clock size={10} />
                                    <span>{timeAgo(t.scanTime)}</span>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// Sub-component for TLog Item
const LogItem = ({ note }) => {
    let color = 'var(--text-secondary)';

    // Level-based Styling
    if (note.level === 'ALERT' || note.message.includes('🚨')) color = '#ef4444';
    else if (note.level === 'UPDATE' || note.message.includes('🌊')) color = '#3b82f6';
    else if (note.message.includes('✅')) color = '#10b981';

    return (
        <div className={styles.logItem} style={{ borderLeft: `3px solid ${color}` }}>
            <div className={styles.logHeader}>
                <span className={styles.logTrigger} style={{ color }}>{note.level}</span>
                <span className={styles.logTime}>{new Date(note.timestamp).toLocaleTimeString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            {/* Render Message with Basic Markdown stripping if needed, or just display as is since it has icons */}
            <div className={styles.logMessage} style={{ whiteSpace: 'pre-wrap' }}>
                {note.message.replace(/\*\*/g, '')}
            </div>
        </div>
    );
};

// Removed HistoryItem and processHistory as per user request

export default function RecommendationsFeed() {
    const { activeScan, strategyLogs, fetchStrategyLogs, useSmartLevelsContext } = useTimeStore();
    const [activeTab, setActiveTab] = React.useState('strategies');

    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (activeScan) {
            setIsPulsing(false);
            const trigger = setTimeout(() => setIsPulsing(true), 10);
            const timer = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(trigger); clearTimeout(timer); };
        }
    }, [activeScan?.id]);

    // GENIE SMART: Derive Recommendations on the Client Side
    const recommendations = useMemo(() => {
        if (!activeScan || !activeScan.results) return [];

        const strategyMap = {}; // { 'STRATEGY_NAME': { title, tickers: [], ... } }

        activeScan.results.forEach(tickerData => {
            const strategies = GenieSmart.deriveStrategies(tickerData, useSmartLevelsContext);

            strategies.forEach(strat => {
                if (!strategyMap[strat.name]) {
                    strategyMap[strat.name] = {
                        id: strat.name,
                        title: strat.label || strat.name,
                        description: `Detected ${strat.confidence} confidence pattern.`,
                        confidence: strat.confidence,
                        type: 'opportunity',
                        tickers: []
                    };
                }
                strategyMap[strat.name].tickers.push({
                    ticker: tickerData.ticker,
                    bias: tickerData.bias || (tickerData.netTrend > 0 ? 'BULL' : 'BEAR'),
                    scanTime: activeScan.timestamp
                });
            });
        });

        // Convert Map to Array
        return Object.values(strategyMap);
    }, [activeScan, useSmartLevelsContext]);

    // Fast-tick force re-render for live "Time Ago" display updates
    const [, setTick] = useState(0);
    useEffect(() => {
        if (activeTab === 'strategies') {
            const interval = setInterval(() => setTick(t => t + 1), 30000); // 30s update
            return () => clearInterval(interval);
        }
    }, [activeTab]);

    // Fetch Data on Tab Change
    useEffect(() => {
        if (activeTab === 'logs') fetchStrategyLogs();
    }, [activeTab]);

    return (
        <div className={`${styles.container} ${isPulsing ? 'animate-widget-glow' : ''}`}>
            {/* ... header ... */}
            <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <h3>AI STRATEGY ENGINE</h3>
                </div>
                <div className={styles.tabs}>
                    <button
                        className={`${styles.tab} ${activeTab === 'strategies' ? styles.active : ''}`}
                        onClick={() => setActiveTab('strategies')}
                    >
                        Active ({recommendations.length})
                    </button>
                    <button
                        className={`${styles.tab} ${activeTab === 'logs' ? styles.active : ''}`}
                        onClick={() => setActiveTab('logs')}
                    >
                        Log
                    </button>
                </div>
            </div>

            <div className={`${styles.feed} ${activeTab !== 'strategies' ? styles.feedVertical : ''}`}>
                {activeTab === 'strategies' && (
                    recommendations.length === 0 ? (
                        <div className={styles.emptyState}>
                            <Lightbulb size={24} style={{ opacity: 0.5, marginBottom: 10 }} />
                            <p>No high-confidence patterns active.</p>
                        </div>
                    ) : (
                        recommendations.map(card => <StrategyCard key={card.id} card={card} />)
                    )
                )}

                {activeTab === 'logs' && (
                    !strategyLogs || strategyLogs.length === 0 ? (
                        <div className={styles.emptyState}>
                            <Activity size={24} style={{ opacity: 0.5, marginBottom: 10 }} />
                            <p>No recent TLogs found.</p>
                        </div>
                    ) : (
                        strategyLogs.map(note => <LogItem key={note.id || note.timestamp} note={note} />)
                    )
                )}
            </div>
        </div>
    );
}
