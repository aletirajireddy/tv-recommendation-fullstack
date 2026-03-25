import React, { useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { ComposedChart, Area, ResponsiveContainer } from 'recharts';

export default function HeaderSparkline() {
    const timeline = useTimeStore(s => s.timeline);

    const chartData = useMemo(() => {
        if (!timeline || timeline.length === 0) return [];
        // Map timeline to get bull/bear flows
        return timeline.map(t => {
            const mood = t.mood || 0;
            return {
                timestamp: t.timestamp,
                // Positive goes up
                bull_flow: mood > 0 ? mood : 0,
                // Negative intrinsically plots downwards originating from 0 baseline
                bear_flow: mood < 0 ? mood : 0
            };
        });
    }, [timeline]);

    if(chartData.length === 0) return (
        <div style={{ flex: 1, minWidth: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: '11px', fontFamily: 'monospace' }}>
            AWAITING MACRO TIMELINE...
        </div>
    );

    return (
        <div style={{ flex: 1, minWidth: '300px', height: '100%', display: 'flex', flexDirection: 'column', padding: '0 8px', justifyContent: 'center' }}>
            
            {/* Header / Legend row perfectly aligned with other cards */}
            <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'monospace', fontWeight: 800, marginBottom: '4px' }}>
                <span>MACRO NET FLOW (24H)</span>
                <span style={{display: 'flex', gap: '8px'}}>
                    <span style={{ color: 'var(--success)' }}>BULL</span>
                    <span style={{ color: 'var(--error)' }}>BEAR</span>
                </span>
            </div>
            
            {/* Extremely dense rigid-height oscillator */}
            <div style={{ width: '100%', height: '40px' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
                        <Area 
                            type="monotone" 
                            dataKey="bull_flow" 
                            stroke="var(--success)" 
                            strokeWidth={1.5} 
                            fill="var(--success)" 
                            fillOpacity={0.15} 
                            isAnimationActive={false} 
                        />
                        <Area 
                            type="monotone" 
                            dataKey="bear_flow" 
                            stroke="var(--error)" 
                            strokeWidth={1.5} 
                            fill="var(--error)" 
                            fillOpacity={0.15} 
                            isAnimationActive={false} 
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
