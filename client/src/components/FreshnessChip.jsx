// Tiny chip that shows how long ago a timestamp was, auto-refreshing every 10 s.
// Used in widget headers to surface data staleness at a glance.
// Color: green <30s · yellow <2min · red ≥2min

import React, { useState, useEffect } from 'react';

function fmtAge(ms) {
    const s = Math.round(ms / 1000);
    if (s <  5) return 'now';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function chipColor(ms) {
    if (ms <  30_000) return 'var(--accent-green)';
    if (ms < 120_000) return '#FACC15';
    return 'var(--accent-red)';
}

export function FreshnessChip({ ts, title }) {
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick(n => n + 1), 10_000);
        return () => clearInterval(t);
    }, []);

    if (!ts) return null;
    const ms    = Date.now() - ts;
    const color = chipColor(ms);
    return (
        <span
            title={title || `Last synced with server ${fmtAge(ms)} ago`}
            style={{
                display:       'inline-flex',
                alignItems:    'center',
                gap:           3,
                fontSize:      10,
                fontWeight:    600,
                color,
                opacity:       0.85,
                whiteSpace:    'nowrap',
                letterSpacing: '0.03em',
                cursor:        'default',
            }}
        >
            <span style={{ fontSize: 11, lineHeight: 1 }}>↻</span>
            {fmtAge(ms)}
        </span>
    );
}
