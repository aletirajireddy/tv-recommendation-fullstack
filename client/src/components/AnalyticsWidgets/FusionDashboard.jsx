import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { formatDistanceToNow, format } from 'date-fns';
import { SpeedBreakerRuler } from './SpeedBreakerRuler';
import ScenarioBoard from './ScenarioBoard';
import { SmartLevelBreaker } from './SmartLevelBreaker';

const SignalLight = ({ active, color, label }) => (
  <div className="flex flex-col items-center justify-center mx-1" title={label}>
    <div className={`w-3 h-3 rounded-full ${active ? color : 'bg-[var(--gray-300)] dark:bg-gray-700'}`} style={{ boxShadow: active ? `0 0 8px ${color.replace('bg-', '')}` : 'none' }} />
    <span className="text-[9px] text-[var(--text-tertiary)] mt-1 font-mono">{label}</span>
  </div>
);

const formatVolume = (vol) => {
  if (!vol || vol === 'Spike') return vol || '--';
  const num = Number(vol);
  if (isNaN(num)) return vol;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const formatPct = (val) => {
  if (val === null || val === undefined) return '--';
  const num = Number(val);
  const sign = num > 0 ? '+' : '';
  const color = num > 0 ? 'text-[var(--success)]' : num < 0 ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]';
  return <span className={color}>{sign}{num.toFixed(2)}%</span>;
};

export default function FusionDashboard() {
  const { fusionData, fetchFusionData } = useTimeStore();
  const [expandedRows, setExpandedRows] = useState({});

  useEffect(() => {
    fetchFusionData();
    // Auto-refresh every 30s
    const interval = setInterval(fetchFusionData, 30000);
    return () => clearInterval(interval);
  }, []);

  const toggleRow = (ticker) => {
    setExpandedRows(prev => ({
      ...prev,
      [ticker]: !prev[ticker]
    }));
  };

  return (
    <div className="flex flex-col w-full p-2 px-3 rounded-lg shadow-sm" style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
      
      <div className="flex items-center justify-between mb-2 py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-bold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            <span className="text-[#3B82F6] text-xs">⚡</span> FUSION COMMAND CENTER
          </h2>
          <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Stream Aggregate Stream A, B & C</p>
        </div>
        <button 
          onClick={fetchFusionData}
          className="p-1.5 rounded-md hover:bg-[var(--gray-200)] transition-colors cursor-pointer flex items-center justify-center"
          style={{ backgroundColor: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
          title="Refresh Fusion Data"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
      </div>

      <div className="flex flex-col xl:flex-row gap-4 mb-4">
        <div className="w-full xl:w-1/2">
            <SmartLevelBreaker />
        </div>
        <div className="w-full xl:w-1/2">
            <ScenarioBoard />
        </div>
      </div>

      <div className="w-full max-h-[500px] overflow-y-auto" style={{ border: '1px solid var(--border-subtle)', borderRadius: '6px' }}>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-xs uppercase tracking-wider sticky top-0 z-20" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-tertiary)' }}>
              <th className="p-3 font-medium" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Asset</th>
              <th className="p-3 font-medium text-right" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Mom %</th>
              <th className="p-3 font-medium text-right hidden md:table-cell" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Volume</th>
              <th className="p-3 font-medium text-right hidden md:table-cell" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Day %</th>
              <th className="p-3 font-medium text-right w-32 hidden lg:table-cell" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Next UP ⬆️</th>
              <th className="p-3 font-medium text-right w-32 hidden lg:table-cell" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Next DOWN ⬇️</th>
              <th className="p-3 font-medium pl-6 w-1/3 min-w-[400px]" style={{ borderBottom: '1px solid var(--border-subtle)' }}>Speed Breakers</th>
              <th className="p-3 w-12" style={{ borderBottom: '1px solid var(--border-subtle)' }}></th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ divideColor: 'var(--border-subtle)' }}>
            {!fusionData || fusionData.length === 0 ? (
              <tr>
                <td colSpan="8" className="p-8 text-center text-gray-500">
                  No Fusion data available yet. Waiting for webhooks...
                </td>
              </tr>
            ) : (
              fusionData.map((row) => {
                const isExpanded = !!expandedRows[row.ticker];
                const emaLevels = row.allLevels?.filter(l => l.name.includes('_200_EMA')) || [];
                const burstCount = row.burstCount || 0;
                
                return (
                <React.Fragment key={row.ticker}>
                  <tr className="transition-colors group hover:bg-[var(--bg-hover)]" style={{ borderBottomColor: isExpanded ? 'transparent' : 'var(--border-subtle)' }}>
                    <td className="p-3 cursor-pointer min-w-[200px]" onClick={() => toggleRow(row.ticker)}>
                      <div className="flex items-center gap-2">
                        <div className="font-bold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                          {row.ticker.replace('BINANCE:', '').replace('.P', '')}
                          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>({row.price})</span>
                        </div>
                        
                        {/* Stream Active Dot (Green if active in any stream) */}
                        <div className={`w-2 h-2 rounded-full ${(row.signals?.A || row.signals?.B || row.signals?.C) ? 'bg-[#059669]' : 'bg-[var(--gray-400)]'}`} style={{ boxShadow: (row.signals?.A || row.signals?.B || row.signals?.C) ? '0 0 6px #059669' : 'none' }} title="Stream Active"></div>

                        {/* Dir icon */}
                        {row.momentum?.direction > 0 && (
                          <div className="flex items-center justify-center w-[18px] h-[18px] rounded ml-1 shadow-sm" style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', color: '#10B981', border: '1px solid rgba(16, 185, 129, 0.3)' }} title="Bullish">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                          </div>
                        )}
                        {row.momentum?.direction < 0 && (
                          <div className="flex items-center justify-center w-[18px] h-[18px] rounded ml-1 shadow-sm" style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.3)' }} title="Bearish">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
                          </div>
                        )}
                        
                        {/* Burst Badge */}
                        {burstCount > 0 && (
                          <div className="px-1.5 py-0.5 rounded text-[10px] font-bold inline-flex items-center" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)' }}>
                            🔥 {burstCount}
                          </div>
                        )}
                      </div>
                      <div className="text-[10px] mt-1 whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                        {row.timestamp ? `${format(new Date(row.timestamp), 'MMM d, h:mm a')} (${formatDistanceToNow(new Date(row.timestamp), { addSuffix: true })})` : 'Unknown'}
                      </div>
                    </td>
                    
                    <td className="p-3 text-right font-mono text-sm max-w-[80px]">
                      {formatPct(row.momentum?.roc_pct)}
                    </td>
                    
                    <td className="p-3 text-right font-mono text-sm hidden md:table-cell" style={{ color: 'var(--text-secondary)' }}>
                      {formatVolume(row.volume_proxy)}
                    </td>
                    
                    <td className="p-3 text-right font-mono text-sm max-w-[80px] hidden md:table-cell">
                      {formatPct(row.dayChangePct)}
                    </td>
                    
                    <td className="p-3 text-right truncate hidden lg:table-cell">
                      {row.nextUp ? (
                        <div className="flex flex-col items-end">
                          <span className="font-mono text-sm text-[var(--success)]">+{row.nextUp.dist_pct?.toFixed(2)}%</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{row.nextUp.name}</span>
                        </div>
                      ) : <span style={{ color: 'var(--text-tertiary)' }}>--</span>}
                    </td>
                    
                    <td className="p-3 text-right truncate hidden lg:table-cell">
                      {row.nextDown ? (
                        <div className="flex flex-col items-end">
                          <span className="font-mono text-sm text-[var(--error)]">{row.nextDown.dist_pct?.toFixed(2)}%</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{row.nextDown.name}</span>
                        </div>
                      ) : <span style={{ color: 'var(--text-tertiary)' }}>--</span>}
                    </td>
                    
                    <td className="p-3 pl-6 align-middle">
                      <SpeedBreakerRuler currentPrice={row.price} levels={row.allLevels} />
                    </td>

                    <td className="p-3 text-center align-middle">
                      <button 
                        onClick={() => toggleRow(row.ticker)}
                        className="text-xl px-2 py-1 rounded hover:bg-[var(--gray-100)] dark:hover:bg-gray-800 transition-colors"
                        style={{ color: 'var(--text-tertiary)' }}
                        title="View Details"
                      >
                        ⋮
                      </button>
                    </td>
                  </tr>

                  {/* EXPANDED DRAWER */}
                  {isExpanded && (
                    <tr style={{ backgroundColor: 'var(--bg-app)', borderBottom: '1px solid var(--border-subtle)' }}>
                      <td colSpan="11" className="p-6">
                        <div className="flex flex-col xl:flex-row gap-8 w-full">
                          
                          {/* Left Side: 200 EMA Visualizer (Hidden by default in main table) */}
                          <div className="flex-1 border rounded-lg p-4" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-card)' }}>
                            <h4 className="text-xs font-bold uppercase mb-4" style={{ color: 'var(--text-secondary)' }}>200 EMA Proximity Visualizer</h4>
                            {emaLevels.length > 0 ? (
                               <SpeedBreakerRuler currentPrice={row.price} levels={emaLevels} />
                            ) : (
                               <div className="text-sm text-center py-4 text-gray-400">No 200 EMAs recorded in proximity bounds.</div>
                            )}
                          </div>

                          {/* Right Side: Burst History Timeline */}
                          <div className="flex-1 border rounded-lg p-4" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-card)' }}>
                            <div className="flex items-center justify-between mb-4">
                              <h4 className="text-xs font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>24H Burst History ({burstCount})</h4>
                              <span className="text-[10px] text-gray-400">Chronological Alert Sequence</span>
                            </div>
                            
                            <div className="flex flex-col gap-2">
                              {row.bursts && row.bursts.length > 0 ? (
                                // Show at most 3 burst history items to keep UI clean
                                row.bursts.slice(0, 3).map((burst, idx) => (
                                  <div key={idx} className="flex items-center justify-between px-3 py-2 rounded border" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-app)' }}>
                                    <div className="flex flex-col">
                                      <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                                        {formatDistanceToNow(new Date(burst.timestamp), { addSuffix: true })}
                                      </span>
                                      <span className="text-[10px] text-gray-500">{format(new Date(burst.timestamp), 'MMM d, h:mm a')}</span>
                                    </div>
                                    <div className="flex items-center gap-4">
                                      <span className="text-xs font-mono font-medium">{formatPct(burst.roc_pct)} Mom</span>
                                      {burst.direction > 0 ? (
                                        <span className="px-2 py-[2px] rounded text-[10px] font-bold" style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success)' }}>BUY</span>
                                      ) : burst.direction < 0 ? (
                                        <span className="px-2 py-[2px] rounded text-[10px] font-bold" style={{ backgroundColor: 'var(--error-bg)', color: 'var(--error)' }}>SELL</span>
                                      ) : (
                                        <span className="px-2 py-[2px] rounded text-[10px] bg-gray-200 text-gray-500">--</span>
                                      )}
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <div className="text-sm text-center py-4 text-gray-400">No previous alerts in last 24h.</div>
                              )}
                              
                              {row.bursts && row.bursts.length > 3 && (
                                 <div className="text-center text-[10px] mt-1 text-gray-400">+{row.bursts.length - 3} older alerts hidden</div>
                              )}
                            </div>
                          </div>

                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
