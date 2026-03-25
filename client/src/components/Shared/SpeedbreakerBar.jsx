import React from 'react';

/**
 * SpeedbreakerBar
 * Renders a horizontal percentage-distance scale with markers.
 * @param {Array} markers - [{ value: Number, color: String, label: String, tooltip: String }]
 * @param {Number} min - Minimum scale value (e.g., -5)
 * @param {Number} max - Maximum scale value (e.g., 5)
 * @param {String} title - Component title
 */
const SpeedbreakerBar = ({ markers = [], min = -5, max = 5, title, isRSI = false }) => {
    
    // Normalize value to percentage position (0 to 100%)
    const getPosition = (val) => {
        let clamped = Math.min(Math.max(val, min), max);
        return ((clamped - min) / (max - min)) * 100;
    };

    return (
        <div style={{ marginBottom: '12px' }}>
            {title && <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#666', marginBottom: '8px', letterSpacing: '0.5px' }}>{title}</div>}
            
            <div style={{ position: 'relative', height: '16px', backgroundColor: '#f5f5f5', borderRadius: '4px', border: '1px solid #e0e0e0', overflow: 'hidden' }}>
                
                {/* Center Zero Line (Only if scale crosses 0) */}
                {!isRSI && min < 0 && max > 0 && (
                    <div style={{
                        position: 'absolute',
                        left: `${getPosition(0)}%`,
                        top: 0,
                        bottom: 0,
                        width: '2px',
                        backgroundColor: '#000',
                        zIndex: 1
                    }} />
                )}

                {/* RSI Zones (Oversold 30, Overbought 70, Pivot 50) */}
                {isRSI && (
                    <>
                        {/* Oversold Zone (Left Side - Green) */}
                        <div style={{ position: 'absolute', left: 0, width: `${getPosition(30)}%`, height: '100%', backgroundColor: 'rgba(38, 166, 154, 0.15)' }} />
                        {/* Overbought Zone (Right Side - Red) */}
                        <div style={{ position: 'absolute', left: `${getPosition(70)}%`, right: 0, height: '100%', backgroundColor: 'rgba(239, 83, 80, 0.15)' }} />
                        
                        {/* 50 Pivot Line */}
                        <div style={{
                            position: 'absolute',
                            left: `${getPosition(50)}%`,
                            top: 0, bottom: 0, width: '2px', backgroundColor: '#999', borderRight: '1px dotted #ccc',
                            zIndex: 1
                        }} />
                    </>
                )}

                {/* Markers */}
                {markers.map((m, idx) => {
                    const pos = getPosition(m.value);
                    return (
                        <div 
                            key={idx}
                            title={`${m.label} (${m.value}${isRSI ? '' : '%'})`}
                            style={{
                                position: 'absolute',
                                left: `${pos}%`,
                                top: '2px',
                                bottom: '2px',
                                width: '4px',
                                backgroundColor: m.color || '#333',
                                borderRadius: '2px',
                                transform: 'translateX(-50%)',
                                zIndex: 2,
                                boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                            }}
                        />
                    );
                })}
            </div>

            {/* Scale Labels */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#888', marginTop: '4px' }}>
                <span>{isRSI ? '0' : `${min}%`}</span>
                {isRSI && <span>30</span>}
                {!isRSI && <span>{((min+max)/2).toFixed(1)}%</span>}
                {isRSI && <span>70</span>}
                <span>{isRSI ? '100' : `+${max}%`}</span>
            </div>
        </div>
    );
};

export default SpeedbreakerBar;
