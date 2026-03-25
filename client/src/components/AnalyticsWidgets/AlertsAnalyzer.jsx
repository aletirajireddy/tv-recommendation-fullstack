import React from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import styles from './AlertsAnalyzer.module.css';
import { Activity, Zap, Layers, Target, TrendingUp } from 'lucide-react';

export function AlertsAnalyzer() {
    const analyticsData = useTimeStore(s => s.analyticsData);
    const lookbackHours = useTimeStore(s => s.lookbackHours);

    if (!analyticsData || !analyticsData.time_spread || analyticsData.time_spread.length === 0) {
        return (
            <div className={styles.container}>
                 <div className={styles.loading}>Initializing Pulse Radar...</div>
            </div>
        )
    }

    const clusters = analyticsData.time_spread;
    const currentBurst = clusters[0]; // The most recent clustered burst
    
    // 1. PULSE VELOCITY (Current alerts/min vs Baseline alerts/min)
    const totalAlerts = analyticsData.total_alerts || clusters.reduce((acc, c) => acc + c.count, 0);
    const baselineVelocity = totalAlerts / (lookbackHours * 60) || 0.1; 
    const currentVelocity = parseFloat(currentBurst.density) || 0;
    
    // Ratio clamped for UI
    const velocityPct = Math.min((currentVelocity / baselineVelocity) * 100, 100); 
    const isAccelerating = currentVelocity >= baselineVelocity;

    // 2. MARKET BREADTH (Concentration vs Flow)
    const breadthRatio = currentBurst.count > 0 ? (currentBurst.unique_coins / currentBurst.count) : 0;
    const breadthLabel = breadthRatio < 0.3 ? 'Concentrated Pump' : (breadthRatio > 0.7 ? 'Broad Market Flow' : 'Mixed Sector Flow');
    const breadthPct = Math.min(breadthRatio * 100, 100);

    // 3. ORIGIN DOMINANCE (Smart Levels vs EMAs over lookback window)
    const totalInst = clusters.reduce((acc, c) => acc + (c.inst_count || 0), 0);
    const totalTech = clusters.reduce((acc, c) => acc + (c.tech_count || 0), 0);
    const totalOrigin = totalInst + totalTech || 1; // Prevent div zero
    const instPct = (totalInst / totalOrigin) * 100;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <Activity size={18} />
                    <h3>360° SCALPING PULSE RADAR</h3>
                </div>
                <div className={styles.rangeControl}>
                    <span className={styles.rangeLabel}>LOOKBACK: <strong>{lookbackHours}h</strong></span>
                </div>
            </div>

            <div className={styles.grid}>
                {/* DIAL 1: PULSE VELOCITY */}
                <div className={styles.card}>
                    <h4>PULSE VELOCITY (SPEED)</h4>
                    <div className={styles.metricRow}>
                        <span className={styles.bigNumber}>{currentVelocity.toFixed(1)}</span>
                        <span className={styles.unit}>alerts/min</span>
                    </div>
                    <div className={styles.subtext}>
                        Baseline: {baselineVelocity.toFixed(1)}/min
                    </div>
                    <div className={styles.progressBarWrapper}>
                        <div 
                            className={isAccelerating ? styles.speedHot : styles.speedCold} 
                            style={{ width: `${Math.max(velocityPct, 5)}%` }} 
                        />
                    </div>
                    <div className={styles.insightText}>
                        <Zap size={14} color={isAccelerating ? "#ef4444" : "#60a5fa"} /> 
                        {isAccelerating ? 'Volatility is Accelerating' : 'Market is Cooling Down'}
                    </div>
                </div>

                {/* DIAL 2: MARKET BREADTH */}
                <div className={styles.card}>
                    <h4>MARKET BREADTH (CONCENTRATION)</h4>
                    <div className={styles.metricRow}>
                        <span className={styles.bigNumber}>{currentBurst.unique_coins}</span>
                        <span className={styles.unit}>unique coins</span>
                    </div>
                    <div className={styles.subtext}>
                        out of {currentBurst.count} alerts in latest pulse
                    </div>
                    <div className={styles.progressBarWrapper}>
                        <div 
                            className={styles.breadthBar} 
                            style={{ width: `${Math.max(breadthPct, 5)}%` }} 
                        />
                    </div>
                    <div className={styles.insightText}>
                        <Layers size={14} color="#8b5cf6" /> 
                        {breadthLabel}
                    </div>
                </div>

                {/* DIAL 3: ORIGIN DOMINANCE */}
                <div className={styles.card}>
                    <h4>ORIGIN DOMINANCE (WHO IS DRIVING?)</h4>
                    <div className={styles.barLabelWrapper}>
                        <span className={styles.instLabel}>Smart ({totalInst})</span>
                        <span className={styles.techLabel}>Tech ({totalTech})</span>
                    </div>
                    <div className={styles.progressBarWrapperTall}>
                        <div className={styles.instFill} style={{ width: `${instPct}%` }}></div>
                        <div className={styles.techFill} style={{ width: `${100 - instPct}%` }}></div>
                    </div>
                    <div className={styles.insightText}>
                        <Target size={14} color={instPct > 50 ? "#c026d3" : "#3b82f6"} /> 
                        {instPct > 50 ? 'Institutions are driving the flow.' : 'Retail momentum is driving.'}
                    </div>
                </div>
            </div>
            
            {/* LATEST BURST SUMMARY */}
            <div className={styles.footerRow}>
                <TrendingUp size={14} color="#10b981" /> 
                <span className={styles.footerText}>
                    <strong>Pulse Context:</strong> The current cluster (${currentBurst.duration}m duration) has a <strong>{currentBurst.bias}</strong> bias with <strong>{currentBurst.mom_pct}%</strong> momentum, primarily featuring: <em>{currentBurst.timeline}</em>.
                </span>
            </div>
        </div>
    );
}
