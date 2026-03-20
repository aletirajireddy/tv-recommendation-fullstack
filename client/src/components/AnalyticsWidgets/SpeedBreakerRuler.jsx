import React from 'react';

export const SpeedBreakerRuler = ({ currentPrice, levels }) => {
  // Config
  const zoomFactor = 10; // 1% price diff = 10px or 10% width
  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

  // Filter valid levels
  const validLevels = (levels || []).filter(l => l.price > 0);

  const renderMarkers = () => {
    return validLevels.map((l, idx) => {
      const distPct = ((l.price - currentPrice) / currentPrice) * 100;
      
      // Map -5%..+5% to 0%..100% width
      const leftPos = clamp(50 + (distPct * zoomFactor), 0, 100);
      
      // Determine color based on explicit level name
      let bgStyle = { backgroundColor: 'var(--gray-300)' };
      if (l.name.includes("Mega Spot")) bgStyle = { backgroundColor: '#F87171', boxShadow: '0 0 4px #F87171' }; // Reddish
      else if (l.name.includes("200_EMA")) bgStyle = { backgroundColor: '#D946EF' }; // Fuchsia
      else if (l.name.includes("Base")) bgStyle = { backgroundColor: '#3B82F6' }; // Blue
      else if (l.name.includes("Neck")) bgStyle = { backgroundColor: '#F97316' }; // Orange
      else if (l.name.includes("Fib")) bgStyle = { backgroundColor: '#FACC15' }; // Yellow
      else if (l.name.startsWith("W_")) bgStyle = { backgroundColor: '#8B5CF6' }; // Purple (Weekly)
      else if (l.name.startsWith("M_")) bgStyle = { backgroundColor: '#10B981' }; // Emerald (Monthly)

      return (
        <div 
          key={idx}
          className={`absolute top-0 bottom-0 w-[5px] cursor-pointer group/marker rounded-full transition-all hover:w-[8px] hover:z-20`}
          style={{ left: `${leftPos}%`, transform: 'translateX(-50%)', ...bgStyle }}
        >
          {/* Tooltip on hover */}
          <div className="absolute opacity-0 group-hover/marker:opacity-100 transition-opacity bg-black text-xs text-white p-2 rounded -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap z-50 pointer-events-none shadow-lg border border-gray-700">
            {l.name} ({distPct > 0 ? '+' : ''}{distPct.toFixed(2)}%)
          </div>
        </div>
      );
    });
  };

  return (
    <div className="relative w-full h-8 rounded-md overflow-visible flex items-center shadow-inner" style={{ backgroundColor: 'var(--bg-app)', border: '1px solid var(--border-subtle)' }}>
      {/* Background Gradient to signify Support (Left) and Resistance (Right) */}
      <div className="absolute inset-0 bg-gradient-to-r from-red-500/10 via-transparent to-green-500/10 pointer-events-none rounded-md" />

      {/* Center Line (Current Price) */}
      <div className="absolute left-1/2 top-0 bottom-0 w-[3px] z-10 -translate-x-1/2" style={{ backgroundColor: 'var(--text-primary)', boxShadow: '0 0 6px var(--border-default)' }} />

      {/* Render Markers */}
      {renderMarkers()}
      
      {/* Ticks/Guides */}
      <div className="absolute left-0 bottom-[-18px] text-[10px] p-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>-5%</div>
      <div className="absolute left-1/4 bottom-[-18px] text-[10px] p-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>-2.5%</div>
      <div className="absolute right-1/4 bottom-[-18px] text-[10px] p-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>+2.5%</div>
      <div className="absolute right-0 bottom-[-18px] text-[10px] p-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>+5%</div>
    </div>
  );
};

export default SpeedBreakerRuler;
