import React, { useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { ComposedChart, Area, ResponsiveContainer } from 'recharts';

export default function HeaderSparkline() {
    const timeline = useTimeStore(s => s.timeline);

    const chartData = useMemo(() => {
        if (!timeline || timeline.length === 0) return [];
        // Carry-forward null mood — t.mood || 0 collapses null to 0 which
        // produces false spike artifacts when consecutive scans have no sentiment.
        let lastMood = 0;
        return timeline.map(t => {
            const rawMood = t.mood == null ? lastMood : t.mood;
            lastMood = rawMood;
            return {
                timestamp: t.timestamp,
                bull_flow: rawMood > 0 ? rawMood : 0,
                bear_flow: rawMood < 0 ? rawMood : 0,
            };
        });
    }, [timeline]);

    if(chartData.length === 0) return (
        <div style={{ flex: 1, minWidth: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '11px', fontFamily: 'monospace' }}>
            AWAITING MACRO TIMELINE...
        </div>
    );

    return (
        <div style={{ flex: 1, minWidth: '300px', height: '100%', display: 'flex', flexDirection: 'column', padding: '0 8px', justifyContent: 'center' }}>
            
            {/* Header / Legend row perfectly aligned with other cards */}
            <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', fontWeight: 800, marginBottom: '4px' }}>
                <span>MACRO NET FLOW (24H)</span>
                <span style={{display: 'flex', gap: '8px'}}>
                    <span style={{ color: 'var(--accent-green)' }}>BULL</span>
                    <span style={{ color: 'var(--accent-red)' }}>BEAR</span>
                </span>
            </div>
            
            {/* Extremely dense rigid-height oscillator */}
            <div style={{ width: '100%', height: '40px' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
                        <Area 
                            type="monotone" 
                            dataKey="bull_flow" 
                            stroke="var(--accent-green)" 
                            strokeWidth={1.5} 
                            fill="var(--accent-green)" 
                            fillOpacity={0.15} 
                            isAnimationActive={false} 
                        />
                        <Area 
                            type="monotone" 
                            dataKey="bear_flow" 
                            stroke="var(--accent-red)" 
                            strokeWidth={1.5} 
                            fill="var(--accent-red)" 
                            fillOpacity={0.15} 
                            isAnimationActive={false} 
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
