import React, { useMemo } from 'react';
import styles from './RecommendationsFeed.module.css';
import { useTimeStore } from '../../store/useTimeStore';
import GenieSmart from '../../services/GenieSmart';
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
                <span className={styles.confidence}>{(card.confidence || 'UNKNOWN').toUpperCase()} CONFIDENCE</span>
            </div>
            <h4 className={styles.title}>{card.title}</h4>
            <p className={styles.description}>{card.description}</p>

            {card.tickers && card.tickers.length > 0 && (
                <div className={styles.tickerList}>
                    {card.tickers.map((t, idx) => (
                        <div key={idx} className={styles.tickerChip}>
                            {t.ticker}
                            {t.bias && <span className={(t.bias === 'LONG' || t.bias === 'BULL') ? styles.tagLong : styles.tagShort}>{t.bias}</span>}
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

const HistoryItem = ({ item }) => {
    const isBull = item.direction === 'BULL';
    const color = isBull ? '#10b981' : '#ef4444'; // Success/Error
    const arrow = isBull ? '▲' : '▼';

    return (
        <div className={styles.logItem} style={{ borderLeft: `3px solid ${color}` }}>
            <div className={styles.logHeader}>
                <span style={{ color: 'var(--text-primary)', fontWeight: '700' }}>
                    {item.ticker} <span style={{ color, fontSize: '0.9em' }}>{arrow} {item.direction}</span>
                </span>
                <span className={styles.logTime}>
                    {new Date(item.timestamp).toLocaleTimeString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
            </div>
            <div className={styles.logMessage} style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{item.label}</span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: '10px' }}>Mood: {item.mood_score > 0 ? '+' : ''}{item.mood_score}%</span>
            </div>
        </div>
    );
};

// Helper to filter and group history
const processHistory = (historyItems, activeCards = []) => {
    // 1. Get Set of Active Signatures to Filter Out
    // We treat "Active" as currently live strategies. History should only show what is NOT active.
    const activeSignatures = new Set();
    activeCards.forEach(card => {
        if (card.tickers) {
            card.tickers.forEach(t => {
                const key = `${t.ticker}_${card.title}`;
                activeSignatures.add(key);
            });
        }
    });

    // 2. Filter History
    const filteredHistory = historyItems.filter(item => {
        const key = `${item.ticker}_${item.label}`;
        return !activeSignatures.has(key);
    });

    const groups = {};

    filteredHistory.forEach(item => {
        const timeKey = new Date(item.timestamp).setSeconds(0, 0);
        const key = `${timeKey}_${item.label}`;

        if (!groups[key]) {
            groups[key] = {
                id: key,
                title: item.label,
                description: `${new Date(item.timestamp).toLocaleTimeString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
                timestamp: item.timestamp,
                confidence: 'MAX',
                type: item.label.includes('INSTITUTIONAL') ? 'opportunity' : 'trend',
                tickers: []
            };
        }
        groups[key].tickers.push({
            ticker: item.ticker,
            bias: item.direction
        });
    });

    return Object.values(groups).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).map(g => ({
        ...g,
        description: `${g.tickers.length} alerts detected at ${g.description}. Watch for follow-through.`
    }));
};

export default function RecommendationsFeed() {
    const { activeScan, aiHistory, fetchAiHistory, strategyLogs, fetchStrategyLogs } = useTimeStore();
    const [activeTab, setActiveTab] = React.useState('strategies');

    // GENIE SMART: Derive Recommendations on the Client Side
    const recommendations = React.useMemo(() => {
        if (!activeScan || !activeScan.results) return [];

        const strategyMap = {}; // { 'STRATEGY_NAME': { title, tickers: [], ... } }

        activeScan.results.forEach(tickerData => {
            const strategies = GenieSmart.deriveStrategies(tickerData);

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
                    bias: tickerData.bias || (tickerData.netTrend > 0 ? 'BULL' : 'BEAR')
                });
            });
        });

        // Convert Map to Array
        return Object.values(strategyMap);
    }, [activeScan]);

    // Memoize history cards with filtering
    const historyCards = React.useMemo(() => processHistory(aiHistory, recommendations), [aiHistory, recommendations]);

    // Fetch Data on Tab Change
    React.useEffect(() => {
        if (activeTab === 'history') fetchAiHistory();
        if (activeTab === 'logs') fetchStrategyLogs();
    }, [activeTab]);

    return (
        <div className={styles.container}>
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
                    <button
                        className={`${styles.tab} ${activeTab === 'history' ? styles.active : ''}`}
                        onClick={() => setActiveTab('history')}
                    >
                        History
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

                {activeTab === 'history' && (
                    // ... existing history render ...
                    historyCards.length === 0 ? (
                        <div className={styles.emptyState}>
                            <Activity size={24} style={{ opacity: 0.5, marginBottom: 10 }} />
                            <p>No history (last 48h).</p>
                        </div>
                    ) : (
                        historyCards.map(card => <StrategyCard key={card.id} card={card} />)
                    )
                )}
            </div>
        </div>
    );
}
