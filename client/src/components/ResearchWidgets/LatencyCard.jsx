import React from 'react';
import { Activity } from 'lucide-react';

export function LatencyCard({ ms }) {
    const isGood = ms < 5000; // < 5s is good
    const color = isGood ? 'var(--success)' : 'var(--warning)';

    return (
        <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '8px',
            padding: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: '100px',
            position: 'relative',
            overflow: 'hidden'
        }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 1 }}>
                <h3 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    SYSTEM LATENCY
                    <span style={{
                        display: 'inline-block',
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: color,
                        animation: 'blink 1.5s infinite'
                    }} />
                </h3>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: color, fontFamily: 'monospace' }}>
                    {ms} <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>ms</span>
                </div>
            </div>
            <Activity
                size={32}
                color={color}
                style={{
                    opacity: 0.2,
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%) scale(2)'
                }}
            />
            <Activity
                size={24}
                color={color}
                style={{
                    opacity: 0.8,
                    zIndex: 1
                }}
            />
            <style>{`
                @keyframes blink {
                    0% { opacity: 1; }
                    50% { opacity: 0.3; }
                    100% { opacity: 1; }
                }
            `}</style>
        </div>
    );
}
