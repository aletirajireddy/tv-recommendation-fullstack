import React from 'react';
import SpeedbreakerBar from './SpeedbreakerBar';

/**
 * SpeedbreakerPanel
 * Renders the two Speedbreaker bars (RSI & EMAs/Levels) for a given coin payload.
 * Expected coin structure:
 * {
 *   ticker: 'BTCUSDT.P',
 *   price: 65000,
 *   rsi_matrix: { m5, m30, h1, h4 },
 *   speedbreakers: [ { name, type, price, distance_pct, stars } ]
 * }
 */
const SpeedbreakerPanel = ({ coin }) => {
    if (!coin || !coin.rsi_matrix) return <div style={{ padding: '8px', fontSize: '12px', color: '#888' }}>No Speedbreaker Data Available</div>;

    // 1. Convert RSI Matrix to Markers
    const rsiColors = {
        m5: '#9c27b0', // Purple
        m30: '#2196f3', // Blue
        h1: '#ff9800',  // Orange
        h4: '#e91e63'   // Pink
    };

    const rsiMarkers = Object.entries(coin.rsi_matrix).map(([tf, val]) => ({
        value: parseFloat(val),
        color: rsiColors[tf],
        label: `RSI (${tf})`
    }));

    // 2. Filter & Format Level Speedbreakers (EMAs, Mega Spots, Fibs)
    // We only map items that are within +/- 5% distance for the default view
    const levelColors = {
        EMA50: '#f44336',  // Red warning
        EMA200: '#e91e63', // Pink
        FIB: '#00bcd4',    // Cyan
        MEGA_SPOT: '#9c27b0', // Deep Purple
        LOGIC: '#607d8b'   // Blue Grey
    };

    const speedbreakerMarkers = (coin.speedbreakers || []).map(b => ({
        value: b.distance_pct,
        color: levelColors[b.type] || '#333',
        label: `${b.name} ($${b.price.toFixed(4)})`
    }));

    return (
        <div style={{ 
            backgroundColor: '#ffffff', 
            border: '1px solid #e0e0e0', 
            borderRadius: '6px', 
            padding: '12px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            minWidth: '280px'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', paddingBottom: '8px', borderBottom: '1px solid #f0f0f0' }}>
                <span style={{ fontWeight: 'bold', fontSize: '14px', color: '#333' }}>{coin.ticker.replace('BINANCE:', '').replace('USDT.P', '')}</span>
                <span style={{ fontSize: '12px', color: '#666', background: '#f5f5f5', padding: '2px 6px', borderRadius: '4px' }}>${parseFloat(coin.price).toPrecision(4)}</span>
            </div>

            {/* RSI Speedbreaker (Absolute Scale 0-100) */}
            <div style={{ marginBottom: '16px' }}>
                <SpeedbreakerBar 
                    title="RSI ENGINE (MULTI-TF)" 
                    isRSI={true} 
                    min={0} 
                    max={100} 
                    markers={rsiMarkers} 
                />
                
                {/* Legend for RSI */}
                <div style={{ display: 'flex', gap: '8px', fontSize: '10px', marginTop: '4px' }}>
                    {Object.keys(rsiColors).map(tf => (
                        <div key={tf} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <div style={{ width: '8px', height: '8px', backgroundColor: rsiColors[tf], borderRadius: '2px' }} />
                            <span>{tf}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Level & EMA Speedbreaker (Relative % Distance +/- 5%) */}
            <div>
                <SpeedbreakerBar 
                    title="SMART LEVEL & EMA SPEEDBREAKERS" 
                    isRSI={false} 
                    min={-5} 
                    max={5} 
                    markers={speedbreakerMarkers} 
                />
                <div style={{ fontSize: '10px', color: '#888', fontStyle: 'italic', marginTop: '8px' }}>
                    Displays EMAs and Mega Spots within ±5% proximity.
                </div>
            </div>
        </div>
    );
};

export default SpeedbreakerPanel;
