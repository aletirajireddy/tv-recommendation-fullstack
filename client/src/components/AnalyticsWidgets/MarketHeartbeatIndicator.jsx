import { useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import {
    ComposedChart, Area, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush, ReferenceArea
} from 'recharts';
import { format, startOfDay, addHours } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';
import { Clock, Zap, Activity } from 'lucide-react';
import styles from './MarketHeartbeatIndicator.module.css';

function findClosestIdx(data, targetMs) {
    let lo = 0, hi = data.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (data[mid].timestamp_ms < targetMs) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(data[lo - 1].timestamp_ms - targetMs) < Math.abs(data[lo].timestamp_ms - targetMs)) return lo - 1;
    return lo;
}

function CustomTooltip({ active, payload }) {
    if (active && payload && payload.length) {
        const p = payload[0].payload;
        return (
            <div className={styles.tooltip}>
                <div className={styles.tooltipHeader}>
                    <Clock size={10} />
                    {p.timeLabel}
                </div>

                <div className={styles.tooltipRow}>
                    <div className={styles.tooltipLabel}>
                        <Zap size={12} color="#F59E0B" />
                        <span>Intensity</span>
                    </div>
                    <span className={styles.tooltipValue} style={{ color: '#F59E0B' }}>{p.alertCount}</span>
                </div>

                <div className={styles.tooltipRow} style={{ borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: '4px', paddingTop: '4px' }}>
                    <div className={styles.tooltipLabel}>
                        <Activity size={12} color={p.rawMood > 0 ? '#10B981' : '#EF4444'} />
                        <span>Genie Score</span>
                    </div>
                    <span className={styles.tooltipValue} style={{ color: p.rawMood > 0 ? '#10B981' : '#EF4444' }}>
                        {p.rawMood > 0 ? '+' : ''}{p.rawMood}
                    </span>
                </div>
            </div>
        );
    }
    return null;
}

export function MarketHeartbeatIndicator() {
    const fullTimeline = useTimeStore(s => s.timeline);
    const currentIndex = useTimeStore(s => s.currentIndex);
    const analyticsData = useTimeStore(s => s.analyticsData);
    const lookbackHours = useTimeStore(s => s.lookbackHours);

    const { chartData, timezones } = useMemo(() => {
        if (!fullTimeline || fullTimeline.length === 0) return { chartData: [], timezones: [] };

        // Time Isolation: Only render history up to the current scrubber position!
        // Also limit backwards to respect the Lookback Lens
        const refTimeMs = new Date(fullTimeline[currentIndex].timestamp).getTime();
        const cutoffMs = refTimeMs - (lookbackHours * 60 * 60 * 1000);
        const timeline = fullTimeline.slice(0, currentIndex + 1).filter(t => new Date(t.timestamp).getTime() >= cutoffMs);

        const data = timeline.map(scan => {
            const rawMood = scan.mood || 0;
            return {
                timestamp_ms: new Date(scan.timestamp).getTime(),
                timeLabel:    format(new Date(scan.timestamp), 'HH:mm'),
                rawMood,
                bullArea:     Math.max(0, rawMood),
                bearArea:     Math.min(0, rawMood),
                alertCount:   0
            };
        });

        // Map exact Alert Frequencies from time_spread to the closest scan timeframe
        if (analyticsData?.time_spread) {
            analyticsData.time_spread.forEach(bucket => {
                const bTimeMs = new Date(bucket.start_time || bucket.time).getTime();
                const closestIdx = findClosestIdx(data, bTimeMs);
                const minDiff = Math.abs(data[closestIdx].timestamp_ms - bTimeMs);

                if (minDiff < 30 * 60 * 1000) {
                    data[closestIdx].alertCount += bucket.count;
                }
            });
        }

        const firstTime = data[0].timestamp_ms;
        const lastTime  = data[data.length - 1].timestamp_ms;
        const markers   = [];

        const sevenDaysAgo = lastTime - 7 * 24 * 3600000;
        let startDay = startOfDay(new Date(Math.max(firstTime, sevenDaysAgo)));
        const endDay = startOfDay(new Date(lastTime));

        while (startDay.getTime() <= endDay.getTime()) {
            const baseUTC = Date.UTC(startDay.getFullYear(), startDay.getMonth(), startDay.getDate());
            markers.push({ name: 'ASIA',   fill: 'rgba(59, 130, 246, 0.12)', start: baseUTC,                end: baseUTC +  9 * 3600000 });
            markers.push({ name: 'LONDON', fill: 'rgba(234, 179, 8, 0.12)',  start: baseUTC +  8 * 3600000, end: baseUTC + 17 * 3600000 });
            markers.push({ name: 'NY AM',  fill: 'rgba(16, 185, 129, 0.12)', start: baseUTC + 13 * 3600000, end: baseUTC + 18 * 3600000 });
            markers.push({ name: 'NY PM',  fill: 'rgba(239, 68, 68, 0.12)',  start: baseUTC + 18 * 3600000, end: baseUTC + 24 * 3600000 });
            startDay = addHours(startDay, 24);
        }

        return { chartData: data, timezones: markers };
    }, [fullTimeline, currentIndex, analyticsData, lookbackHours]);

    // ── Shared brush hook (fixes localStorage persistence + live-follow) ──
    const { brushRange, handleBrushChange } = useChartBrush('tv_heartbeatBrush', chartData);

    if (chartData.length < 2) return null;

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', touchAction: 'none' }}>
            {/* Label */}
            <div className={styles.chartLabel}>
                MARKET HEARTBEAT
            </div>

            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 24, right: 0, left: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id="hbBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%"  stopColor="#10B981" stopOpacity={0.4} />
                                <stop offset="95%" stopColor="#10B981" stopOpacity={0.0} />
                            </linearGradient>
                            <linearGradient id="hbBear" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.0} />
                                <stop offset="95%" stopColor="#EF4444" stopOpacity={0.4} />
                            </linearGradient>
                        </defs>

                        <XAxis dataKey="timestamp_ms" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
                        <YAxis yAxisId="mood"   domain={[-100, 100]}      hide />
                        <YAxis yAxisId="alerts" orientation="right" domain={[0, 'dataMax']} hide />

                        <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />

                        {timezones.map((tz, i) => (
                            <ReferenceArea key={`hb-tz-${i}`} x1={tz.start} x2={tz.end} fill={tz.fill} strokeOpacity={0} ifOverflow="hidden" />
                        ))}

                        <Area yAxisId="mood" type="step" dataKey="bullArea" stroke="#10B981" strokeWidth={1} fill="url(#hbBull)" isAnimationActive={false} />
                        <Area yAxisId="mood" type="step" dataKey="bearArea" stroke="#EF4444" strokeWidth={1} fill="url(#hbBear)" isAnimationActive={false} />
                        <Bar  yAxisId="alerts" dataKey="alertCount" fill="#F59E0B" barSize={2} radius={[1, 1, 0, 0]} isAnimationActive={false} />

                        <Brush 
                            dataKey="timestamp_ms" 
                            height={8}
                            travellerWidth={2}
                            stroke="rgba(255,255,255,0.2)" 
                            fill="rgba(0,0,0,0.2)"
                            tickFormatter={() => ''}
                            onChange={handleBrushChange}
                            startIndex={brushRange.startIndex}
                            endIndex={brushRange.endIndex}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
        </div>
    );
}

export default MarketHeartbeatIndicator;
