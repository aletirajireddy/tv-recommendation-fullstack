import React, { useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import SpeedbreakerPanel from '../Shared/SpeedbreakerPanel';

/**
 * RSIDistributionWidget
 * Top-level widget displaying RSI categorization buckets and interactive
 * Speedbreaker Popovers to inspect EMA warnings and exact RSI matrices.
 */
const RSIDistributionWidget = () => {
    const rsiDistribution = useTimeStore(s => s.rsiDistribution);
    const [activeCoinTicker, setActiveCoinTicker] = useState(null);
    const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });

    if (!rsiDistribution) {
        return (
            <div style={{ padding: '24px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e0e0e0', margin: '16px 0', fontSize: '13px', color: '#666', textAlign: 'center' }}>
                Loading RSI Distribution Matrix...
            </div>
        );
    }

    const { OVERSOLD_30 = [], REJECTION_50 = [], OVERBOUGHT_70 = [], NEUTRAL = [] } = rsiDistribution;

    const handleCoinClick = (e, coin) => {
        // Toggle off if clicking the same coin
        if (activeCoinTicker === coin.ticker) {
            setActiveCoinTicker(null);
            return;
        }

        const rect = e.currentTarget.getBoundingClientRect();
        setPopoverPosition({
            top: rect.bottom + 8,
            left: rect.left - 40 // slight offset
        });
        setActiveCoinTicker(coin.ticker);
    };

    const handleBackdropClick = () => {
        setActiveCoinTicker(null);
    };

    // Helper to find the active coin object from the distribution lists
    const getActiveCoinObject = () => {
        if (!activeCoinTicker) return null;
        const all = [...OVERSOLD_30, ...REJECTION_50, ...OVERBOUGHT_70, ...NEUTRAL];
        return all.find(c => c.ticker === activeCoinTicker);
    };

    const activeCoinObj = getActiveCoinObject();

    const columnStyle = {
        flex: 1,
        backgroundColor: '#fafafa',
        border: '1px solid #e8e8e8',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: '220px'
    };

    const headerStyle = (color) => ({
        fontSize: '11px',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: color,
        borderBottom: `2px solid ${color}40`,
        paddingBottom: '6px',
        marginBottom: '4px',
        display: 'flex',
        justifyContent: 'space-between'
    });

    return (
        <div style={{ marginBottom: '16px', position: 'relative' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: '#333', marginBottom: '12px', letterSpacing: '0.5px' }}>
                RSI SPEEDBREAKER DISTRIBUTION
            </h3>
            
            <div style={{ display: 'flex', gap: '16px', overflowX: 'auto', paddingBottom: '8px' }}>
                
                {/* Oversold Bucket */}
                <div style={columnStyle}>
                    <div style={headerStyle('#26a69a')}>
                        <span>OVERSOLD (&lt; 30)</span>
                        <span style={{ background: '#26a69a20', padding: '2px 6px', borderRadius: '4px' }}>{OVERSOLD_30.length}</span>
                    </div>
                    {OVERSOLD_30.map(coin => <CoinCard key={coin.ticker} coin={coin} onClick={(e) => handleCoinClick(e, coin)} />)}
                    {OVERSOLD_30.length === 0 && <span style={{ color: '#aaa', fontSize: '11px', textAlign: 'center', marginTop: '12px' }}>--</span>}
                </div>

                {/* RSI 50 Rejection Bucket */}
                <div style={{ ...columnStyle, borderLeft: '3px solid #ffb74d' }}>
                    <div style={headerStyle('#f57c00')}>
                        <span>RSI 50 REJECTION (48-52)</span>
                        <span style={{ background: '#fff3e0', padding: '2px 6px', borderRadius: '4px' }}>{REJECTION_50.length}</span>
                    </div>
                    {REJECTION_50.map(coin => <CoinCard key={coin.ticker} coin={coin} onClick={(e) => handleCoinClick(e, coin)} />)}
                    {REJECTION_50.length === 0 && <span style={{ color: '#aaa', fontSize: '11px', textAlign: 'center', marginTop: '12px' }}>--</span>}
                </div>

                {/* Overbought Bucket */}
                <div style={columnStyle}>
                    <div style={headerStyle('#ef5350')}>
                        <span>OVERBOUGHT (&gt; 70)</span>
                        <span style={{ background: '#ffebee', padding: '2px 6px', borderRadius: '4px' }}>{OVERBOUGHT_70.length}</span>
                    </div>
                    {OVERBOUGHT_70.map(coin => <CoinCard key={coin.ticker} coin={coin} onClick={(e) => handleCoinClick(e, coin)} />)}
                    {OVERBOUGHT_70.length === 0 && <span style={{ color: '#aaa', fontSize: '11px', textAlign: 'center', marginTop: '12px' }}>--</span>}
                </div>
            </div>

            {/* Interactive Popover */}
            {activeCoinTicker && activeCoinObj && (
                <>
                    {/* Transparent Click-Away Backdrop */}
                    <div 
                        style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} 
                        onClick={handleBackdropClick}
                    />
                    
                    {/* The Panel */}
                    <div style={{ 
                        position: 'fixed', 
                        top: popoverPosition.top,
                        left: popoverPosition.left, 
                        zIndex: 1000,
                        pointerEvents: 'auto'
                    }}>
                        <SpeedbreakerPanel coin={activeCoinObj} />
                    </div>
                </>
            )}
        </div>
    );
};

// Sub-component for individual coins in the lists
const CoinCard = ({ coin, onClick }) => {
    // Determine gradient based on Trend or Direction
    const isUp = coin.momentum?.direction >= 0 || (coin.roc_pct || 0) > 0;
    const gradient = isUp ? 'linear-gradient(90deg, #e8f5e9 0%, #ffffff 100%)' : 'linear-gradient(90deg, #ffebee 0%, #ffffff 100%)';
    const borderLeft = isUp ? '4px solid #81c784' : '4px solid #e57373';

    // Count EMA Speedbreakers (warnings)
    const emaWarnings = (coin.speedbreakers || []).filter(b => b.type === 'EMA50' || b.type === 'EMA200').length;

    return (
        <div 
            onClick={onClick}
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 10px',
                background: gradient,
                borderLeft: borderLeft,
                borderRadius: '4px',
                border: '1px solid #f0f0f0',
                boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                cursor: 'pointer',
                transition: 'transform 0.1s ease',
            }}
            onMouseOver={(e) => e.currentTarget.style.transform = 'translateY(-1px)'}
            onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(0)'}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontWeight: '600', fontSize: '13px', color: '#222' }}>
                    {coin.ticker.replace('BINANCE:', '').replace('USDT.P', '')}
                </span>
                {emaWarnings > 0 && (
                    <span title={`${emaWarnings} EMA Speedbreakers ahead`} style={{ fontSize: '10px', background: '#ffe0b2', color: '#e65100', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold' }}>
                        ⚠️ {emaWarnings}
                    </span>
                )}
            </div>
            
            <span style={{ fontSize: '11px', color: '#777', fontWeight: '500' }}>
                {parseFloat(coin.price).toPrecision(4)}
            </span>
        </div>
    );
};

export default RSIDistributionWidget;
