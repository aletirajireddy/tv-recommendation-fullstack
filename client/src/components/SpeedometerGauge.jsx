import React, { useEffect, useMemo, useState } from 'react';

/**
 * SpeedometerGauge - Institutional Market Mood Visualizer
 */
export function SpeedometerGauge({ score = 0, label = 'NEUTRAL' }) {
    const [animatedScore, setAnimatedScore] = useState(-100); // Start at far left for animation

    useEffect(() => {
        // Force a tiny delay so the browser paints the initial state (-100)
        // before applying the real score, triggering the CSS transition.
        const timer = setTimeout(() => {
            setAnimatedScore(score);
        }, 50);
        return () => clearTimeout(timer);
    }, [score]);

    // 1. Math: Map score (-100 to 100) to an angle (-90 to +90 degrees)
    // 0 degrees points straight UP.
    const clampedScore = Math.max(-100, Math.min(100, animatedScore));
    const angle = (clampedScore / 100) * 90;

    // 2. SVG Configuration
    const width = 200;
    const height = 110;
    const cx = 100;
    const cy = 100;
    const r = 80;

    // 3. Dynamic Text Color based on Label
    let textColor = 'var(--text-main)';
    if (label === 'BULLISH' || label === 'EUPHORIC') textColor = 'var(--accent-green, #10B981)';
    else if (label === 'BEARISH' || label === 'PANIC') textColor = 'var(--accent-red, #EF4444)';
    else if (label === 'NEUTRAL') textColor = 'var(--warning, #FACC15)';

    // Path for semi-circle
    const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

    // Generate Ticks (memoized — these never change)
    const ticks = useMemo(() => {
        const arr = [];
        for (let i = -100; i <= 100; i += 20) {
            const tickAngle = (i / 100) * 90;
            // SVG rotate around cx, cy
            // 0 degrees is UP, so we rotate a vertical line
            const isMajor = i % 50 === 0;
            const tickLength = isMajor ? 8 : 4;
            arr.push(
                <line
                    key={`tick-${i}`}
                    x1={cx}
                    y1={cy - r + 12}
                    x2={cx}
                    y2={cy - r + 12 + tickLength}
                    stroke="rgba(255,255,255,0.4)"
                    strokeWidth={isMajor ? 2 : 1}
                    transform={`rotate(${tickAngle}, ${cx}, ${cy})`}
                />
            );
        }
        return arr;
    }, []);

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg
                width="100%"
                height="100%"
                viewBox={`0 0 ${width} ${height}`}
                style={{ overflow: 'visible', dropShadow: '0 4px 6px rgba(0,0,0,0.1)' }}
            >
                {/* DEFS: Gradient mapped to global CSS Theme Variables */}
                <defs>
                    <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="var(--accent-red, #EF4444)" />
                        <stop offset="50%" stopColor="var(--warning, #FACC15)" />
                        <stop offset="100%" stopColor="var(--accent-green, #10B981)" />
                    </linearGradient>
                </defs>

                {/* TRACK BACKGROUND (Subtle) */}
                <path
                    d={arcPath}
                    fill="none"
                    stroke="rgba(255,255,255,0.05)"
                    strokeWidth="12"
                    strokeLinecap="round"
                />

                {/* ACTUAL GRADIENT GAUGE */}
                <path
                    d={arcPath}
                    fill="none"
                    stroke="url(#gaugeGradient)"
                    strokeWidth="12"
                    strokeLinecap="round"
                />

                {/* TICKS (Scale) */}
                {ticks}

                {/* DIGITAL SCORE READOUT */}
                <text
                    x={cx}
                    y={cy - 25}
                    textAnchor="middle"
                    fill={textColor}
                    fontSize="34"
                    fontFamily="Outfit, sans-serif"
                    fontWeight="800"
                    letterSpacing="-1px"
                >
                    {score > 0 ? '+' : ''}{score}
                </text>

                {/* LABEL */}
                <text
                    x={cx}
                    y={cy - 5}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize="12"
                    fontFamily="Inter, sans-serif"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="1px"
                >
                    {label}
                </text>

                {/* NEEDLE POLYGON */}
                <polygon
                    points={`${cx - 3},${cy} ${cx + 3},${cy} ${cx},${cy - r + 24}`}
                    fill="var(--text-main)"
                    style={{
                        transformOrigin: `${cx}px ${cy}px`,
                        transform: `rotate(${angle}deg)`,
                        transition: 'transform 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)' /* Bouncy snap */
                    }}
                />

                {/* NEEDLE PIVOT CIRCLE */}
                <circle
                    cx={cx}
                    cy={cy}
                    r="6"
                    fill="var(--bg-panel, #1E293B)"
                    stroke="var(--text-main)"
                    strokeWidth="2"
                />
            </svg>
        </div>
    );
}

export default SpeedometerGauge;
