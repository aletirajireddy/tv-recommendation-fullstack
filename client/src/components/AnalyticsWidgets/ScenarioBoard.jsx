import React, { useState, useEffect } from 'react';
import { useTimeStore } from '../../store/useTimeStore';

const ScenarioBoard = () => {
    // Decoupled from lookbackHours - We want strict "Tactical" logic (Last 1h)
    const { activeScan, marketMood } = useTimeStore();
    const [scenarios, setScenarios] = useState({ planA: [], planB: [], marketCheck: null });
    const [loading, setLoading] = useState(true);

    const TACTICAL_WINDOW_HOURS = 1;

    const fetchScenarios = async () => {
        try {
            const res = await fetch(`http://localhost:3000/api/analytics/scenarios?hours=${TACTICAL_WINDOW_HOURS}`);
            const data = await res.json();
            if (data && !data.error) {
                setScenarios(data);
            }
        } catch (err) {
            console.error('Failed to fetch scenarios:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchScenarios();
        // Re-fetch only when a new scan arrives (fresh data)
    }, [activeScan]);

    const ScenarioColumn = ({ title, type, items, color }) => (
        <div className="scenario-column" style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            border: `1px solid ${color}`,
            borderRadius: '4px',
            backgroundColor: 'rgba(255, 255, 255, 0.5)',
            margin: '0 4px',
            height: '100%'
        }}>
            <div className="column-header" style={{
                backgroundColor: color,
                color: '#fff',
                padding: '8px 12px',
                fontWeight: '600',
                fontSize: '0.9rem',
                textTransform: 'uppercase',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <span>{title}</span>
                <span style={{ fontSize: '0.8rem', opacity: 0.9 }}>{items.length} Candidates</span>
            </div>

            <div className="column-content" style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px'
            }}>
                {items.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '20px', color: '#888', fontStyle: 'italic' }}>
                        No candidates meet {type} criteria.
                    </div>
                ) : (
                    items.map((item, idx) => (
                        <div key={idx} className="scenario-card" style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '10px',
                            marginBottom: '6px',
                            backgroundColor: '#fff',
                            borderLeft: `4px solid ${color}`,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                            cursor: 'pointer',
                            fontSize: '0.9rem'
                        }}>
                            <div className="card-left">
                                <div style={{ fontWeight: '700', fontSize: '1rem', color: '#1a1a1a' }}>{item.ticker}</div>
                                <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '2px' }}>
                                    {item.trigger}
                                </div>
                            </div>
                            <div className="card-right" style={{ textAlign: 'right' }}>
                                <div style={{ fontWeight: '600', color: color }}>${item.price.toFixed(4)}</div>
                                <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '2px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                                    <span>{item.scope}</span>
                                    {item.vol && (
                                        <span title="Volume Spike Ignition" style={{ fontSize: '0.9rem', color: '#ffbd00' }}>⚡</span>
                                    )}
                                    {item.heat > 0 && (
                                        <span title={`${item.heat} Inst. Alerts`} style={{ fontSize: '0.9rem' }}>🔥</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    return (
        <div className="scenario-board" style={{
            height: '400px',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#f8f9fa',
            border: '1px solid #e9ecef',
            borderRadius: '8px',
            overflow: 'hidden'
        }}>
            <div className="board-header" style={{
                padding: '12px 16px',
                borderBottom: '1px solid #e9ecef',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                backgroundColor: '#fff'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '1.2rem' }}>⚔️</span>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: '700', color: '#2c3e50' }}>SCENARIO PLANNING</h3>
                </div>
                {marketMood && (
                    <div className="market-context" style={{
                        fontSize: '0.85rem',
                        padding: '4px 12px',
                        borderRadius: '20px',
                        backgroundColor: marketMood.label.includes('BULLISH') || marketMood.label.includes('EUPHORIC') ? '#d4edda' :
                            marketMood.label.includes('BEARISH') || marketMood.label.includes('PANIC') ? '#f8d7da' : '#e2e3e5',
                        color: marketMood.label.includes('BULLISH') || marketMood.label.includes('EUPHORIC') ? '#155724' :
                            marketMood.label.includes('BEARISH') || marketMood.label.includes('PANIC') ? '#721c24' : '#383d41',
                        fontWeight: '600'
                    }}>
                        Current Context: {marketMood.label} ({marketMood.moodScore})
                    </div>
                )}
            </div>

            <div className="board-content" style={{
                flex: 1,
                display: 'flex',
                padding: '12px',
                gap: '8px',
                overflow: 'hidden'
            }}>
                <ScenarioColumn
                    title="PLAN A: BULLISH BREAKOUT"
                    type="Breakout"
                    items={scenarios.planA}
                    color="#00c853"
                />

                <div className="divider" style={{ width: '1px', backgroundColor: '#ddd', margin: '0 4px' }}></div>

                <ScenarioColumn
                    title="PLAN B: BEARISH BREAKDOWN"
                    type="Breakdown"
                    items={scenarios.planB}
                    color="#ff5252"
                />
            </div>
        </div>
    );
};

export default ScenarioBoard;
