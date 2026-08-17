import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Ghost, Shield, ShieldCheck, ShieldOff, Plus, X, Search, AlertTriangle } from 'lucide-react';
import styles from './GhostCoinWidget.module.css';
import { FreshnessChip } from '../FreshnessChip';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';

// ── Ghost Queue Section ───────────────────────────────────────────────────────
function GhostQueue({ containerRef }) {
    const lastDataPush = useTimeStore(s => s.lastDataPush);
    const [queue, setQueue]             = useState([]);
    const [autoApprove, setAutoApprove] = useState(false);
    const [loading, setLoading]         = useState(true);
    const [lastFetchedAt, setLastFetchedAt] = useState(null);
    // Per-coin loading: Set of tickers currently being pruned
    const [pruningSet, setPruningSet]   = useState(() => new Set());
    const [approvingAll, setApprovingAll] = useState(false);

    // Watchdog Confidence Clock settings — see CLAUDE.md "Watchdog Confidence
    // Clock". Draft values are edited locally, saved on blur/Enter, so typing
    // a new number doesn't fire a request per keystroke.
    const [settleHours, setSettleHours]           = useState(12);
    const [ghostHours, setGhostHours]              = useState(36);
    const [gapToleranceMin, setGapToleranceMin]   = useState(15);
    const [settingsOpen, setSettingsOpen]          = useState(false);
    const [savingSettings, setSavingSettings]      = useState(false);

    const fetchQueue = useCallback(async () => {
        try {
            const res = await fetch('/api/ghosts/queue');
            if (res.ok) {
                const data = await res.json();
                setQueue(data.queue || []);
                setAutoApprove(data.auto_approve || false);
                setLastFetchedAt(Date.now());
            }
        } catch (e) { console.error('Ghost queue fetch failed', e); }
        finally { setLoading(false); }
    }, []);

    const fetchWatchdogSettings = useCallback(async () => {
        try {
            const res = await fetch('/api/ghosts/watchdog-settings');
            if (res.ok) {
                const data = await res.json();
                setSettleHours(data.settleHours);
                setGhostHours(data.ghostHours);
                setGapToleranceMin(data.gapToleranceMin);
            }
        } catch (e) { console.error('Watchdog settings fetch failed', e); }
    }, []);

    const saveWatchdogSetting = useCallback(async (key, value) => {
        setSavingSettings(true);
        try {
            await fetch('/api/ghosts/watchdog-settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value }),
            });
        } catch (e) { console.error('Watchdog settings save failed', e); }
        finally { setSavingSettings(false); }
    }, []);

    useEffect(() => {
        fetchQueue();
        fetchWatchdogSettings();
        const interval = setInterval(fetchQueue, 30_000);
        return () => clearInterval(interval);
    }, [fetchQueue, fetchWatchdogSettings]);

    useDataInvalidation(containerRef, fetchQueue, lastDataPush);

    const toggleAutoApprove = async () => {
        const next = !autoApprove;
        setAutoApprove(next); // optimistic toggle
        if (next) {
            // Enabling Auto-Prune: clear all prunable coins from the local list
            // immediately — server bulk-approves them in the same request, so
            // there is no flicker or wait. Whitelisted coins stay visible.
            setQueue(prev => prev.filter(c => c.is_whitelisted));
        }
        try {
            await fetch('/api/ghosts/toggle-auto', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            fetchQueue(); // reconcile — server may have kept whitelisted entries
        } catch {
            setAutoApprove(!next); // rollback toggle on error
            fetchQueue();          // restore list
        }
    };

    const approveAll = useCallback(async () => {
        if (approvingAll) return;
        setApprovingAll(true);
        // Optimistic: clear non-whitelisted coins immediately; server keeps protected ones.
        setQueue(prev => prev.filter(c => c.is_whitelisted));
        try {
            await fetch('/api/ghosts/approve-all', { method: 'POST' });
        } catch {}
        finally {
            // Always reconcile — server is the source of truth for what survived
            await fetchQueue();
            setApprovingAll(false);
        }
    }, [approvingAll, fetchQueue]);

    const approveCoin = useCallback(async (ticker, isWhitelisted) => {
        if (pruningSet.has(ticker) || isWhitelisted) return;
        // Optimistic: remove from list immediately
        setPruningSet(prev => new Set([...prev, ticker]));
        setQueue(prev => prev.filter(c => c.ticker !== ticker));
        try {
            const res = await fetch('/api/ghosts/approve', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker }),
            });
            if (res.status === 409) {
                // Server says coin is whitelisted — re-fetch to restore + mark it
                await fetchQueue();
            }
        } catch {
            // Network error: rollback
            await fetchQueue();
        } finally {
            setPruningSet(prev => { const n = new Set(prev); n.delete(ticker); return n; });
        }
    }, [pruningSet, fetchQueue]);

    if (loading) return null;

    return (
        <div className={styles.section}>
            {/* Section header */}
            <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>
                    <Ghost size={14} className="text-accent-orange" />
                    <span>Ghost Queue</span>
                    <span className={styles.countBadge} style={{ background: 'rgba(255,152,0,0.15)', color: '#f6ad55', borderColor: 'rgba(255,152,0,0.3)' }}>
                        {queue.length}
                    </span>
                    <FreshnessChip ts={lastFetchedAt} title="Ghost queue last fetched" />
                </div>
                <div className={styles.sectionActions}>
                    <button
                        onClick={() => setSettingsOpen(o => !o)}
                        title="Watchdog confidence clock settings"
                        style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 22, height: 22, borderRadius: 4,
                            border: '1px solid var(--border)',
                            background: settingsOpen ? 'rgba(99,179,237,0.15)' : 'rgba(255,255,255,0.03)',
                            color: settingsOpen ? '#63b3ed' : 'var(--text-muted)',
                            cursor: 'pointer', fontSize: 12,
                        }}
                    >⚙</button>
                    <span className={styles.toggleLabel}>Auto-Prune</span>
                    <label className={styles.switch}>
                        <input type="checkbox" checked={autoApprove} onChange={toggleAutoApprove} />
                        <span className={styles.slider} />
                    </label>
                    {queue.length > 0 && !autoApprove && (() => {
                        const prunable   = queue.filter(c => !c.is_whitelisted).length;
                        const protected_ = queue.length - prunable;
                        return (
                            <button
                                className={styles.approveAllBtn}
                                onClick={approveAll}
                                disabled={approvingAll || prunable === 0}
                                style={{ opacity: (approvingAll || prunable === 0) ? 0.5 : 1 }}
                                title={protected_ > 0 ? `${protected_} whitelisted coin${protected_ > 1 ? 's' : ''} will be skipped` : undefined}
                            >
                                {approvingAll
                                    ? 'Pruning…'
                                    : protected_ > 0
                                        ? `Prune ${prunable} (${protected_} protected)`
                                        : 'Approve All'}
                            </button>
                        );
                    })()}
                </div>
            </div>

            {settingsOpen && (
                <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end',
                    padding: '8px 10px', margin: '0 0 8px', borderRadius: 5,
                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                    fontSize: 11,
                }}>
                    {[
                        { key: 'settleHours', label: 'Settle hours', value: settleHours, setValue: setSettleHours, min: 0, max: 72, step: 1,
                          hint: 'A coin younger than this is never judged for pruning at all.' },
                        { key: 'ghostHours', label: 'Ghost hours', value: ghostHours, setValue: setGhostHours, min: 1, max: 336, step: 1,
                          hint: 'Manual mode only — how long a flagged coin waits for momentum before auto-reset.' },
                        { key: 'gapToleranceMin', label: 'Gap tolerance (min)', value: gapToleranceMin, setValue: setGapToleranceMin, min: 1, max: 120, step: 1,
                          hint: 'A scan gap bigger than this resets every coin’s confidence clock (system was offline).' },
                    ].map(f => (
                        <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }} title={f.hint}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{f.label}</span>
                            <input
                                type="number"
                                min={f.min} max={f.max} step={f.step}
                                value={f.value}
                                onChange={e => f.setValue(e.target.value === '' ? '' : Number(e.target.value))}
                                onBlur={() => {
                                    const v = Number(f.value);
                                    if (isFinite(v)) saveWatchdogSetting(f.key, v);
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                style={{
                                    width: 70, padding: '3px 6px', borderRadius: 4,
                                    border: '1px solid var(--border)', background: 'var(--bg-app)',
                                    color: 'var(--text-main)', fontSize: 12,
                                }}
                            />
                        </div>
                    ))}
                    <span style={{ color: 'var(--text-muted)', fontSize: 10, opacity: savingSettings ? 1 : 0, transition: 'opacity 0.2s' }}>
                        saving…
                    </span>
                </div>
            )}

            {/* Queue list */}
            {queue.length === 0 ? (
                <div className={styles.emptyState}>No ghost coins in queue</div>
            ) : (
                <div className={styles.list}>
                    {queue.map(coin => {
                        const ageMin = Math.floor((Date.now() - new Date(coin.queued_at).getTime()) / 60000);
                        const score = coin.confidence_score;
                        const bd = coin.score_breakdown;
                        const confLabel = bd?.confidence || null;
                        const confColor = confLabel === 'HIGH' ? '#68d391' : confLabel === 'MEDIUM' ? '#f6ad55' : confLabel === 'LOW' ? '#fc8181' : '#718096';
                        const isPruning    = pruningSet.has(coin.ticker);
                        const isProtected  = coin.is_whitelisted;
                        // Pending (queued, not yet pruned, not protected) → gentle amber pulse
                        const isPending    = !isPruning && !isProtected;
                        return (
                            <div
                                key={coin.ticker}
                                className={`${styles.coinRow}${isPending ? ' ghost-pending-pulse' : ''}`}
                                style={{
                                    opacity: isPruning ? 0.4 : 1,
                                    transition: 'opacity 0.15s',
                                    // Whitelisted coins get a subtle green tint border
                                    ...(isProtected && { borderLeft: '2px solid rgba(104,211,145,0.5)', paddingLeft: 6 }),
                                }}
                            >
                                <div className={styles.coinInfo}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <div className={styles.ticker}>{coin.ticker}</div>
                                        {isProtected && (
                                            <span
                                                title="Whitelisted — immune to ghost pruning. Remove from whitelist to prune."
                                                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 700, color: '#68D391', background: 'rgba(104,211,145,0.12)', border: '1px solid rgba(104,211,145,0.3)', borderRadius: 3, padding: '1px 5px' }}
                                            >
                                                <Shield size={8} /> PROTECTED
                                            </span>
                                        )}
                                    </div>
                                    <div className={styles.reason}>{coin.reason} · {ageMin}m ago</div>
                                    {score != null && (
                                        <div style={{ marginTop: 5 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2, color: 'var(--text-muted)' }}>
                                                <span>Confidence</span>
                                                <span style={{ color: confColor, fontWeight: 700 }}>{score.toFixed(1)} — {confLabel}</span>
                                            </div>
                                            <div style={{ height: 5, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden', border: '1px solid var(--border)' }}>
                                                <div style={{ height: '100%', width: `${Math.min(100, score)}%`, background: confColor, borderRadius: 2, transition: 'width 0.4s' }} />
                                            </div>
                                            {bd && (
                                                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                                                    <span>WR: {bd.base_win_rate}%</span>
                                                    <span>Regime: {bd.regime_mood} ×{bd.regime_multiplier}</span>
                                                    <span>Dir: <strong>{bd.direction_used || '?'}</strong></span>
                                                    {bd.sample_count != null && <span>n={bd.sample_count}</span>}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                                {isProtected ? (
                                    <span
                                        title="Whitelisted — remove from whitelist first to enable pruning"
                                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, color: '#68D391', opacity: 0.6 }}
                                    >
                                        <ShieldOff size={14} />
                                    </span>
                                ) : (
                                    <button
                                        className={styles.approveBtn}
                                        onClick={() => approveCoin(coin.ticker, false)}
                                        disabled={isPruning}
                                        style={{ opacity: isPruning ? 0.5 : 1, minWidth: 52 }}
                                    >
                                        {isPruning ? '…' : 'Prune'}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── Whitelist Section ─────────────────────────────────────────────────────────
function WhitelistSection() {
    const [whitelist, setWhitelist]     = useState([]);
    const [knownCoins, setKnownCoins]   = useState([]);
    const [query, setQuery]             = useState('');
    const [showSearch, setShowSearch]   = useState(false);
    const [adding, setAdding]           = useState(false);
    const [removing, setRemoving]       = useState(null);
    const searchRef                     = useRef(null);
    const dropdownRef                   = useRef(null);

    const fetchWhitelist = useCallback(async () => {
        try {
            const res = await fetch('/api/whitelist');
            if (res.ok) { const d = await res.json(); setWhitelist(d.whitelist || []); }
        } catch {}
    }, []);

    const fetchKnown = useCallback(async () => {
        try {
            const res = await fetch('/api/coins/known');
            if (res.ok) { const d = await res.json(); setKnownCoins(d.coins || []); }
        } catch {}
    }, []);

    useEffect(() => { fetchWhitelist(); fetchKnown(); }, [fetchWhitelist, fetchKnown]);

    // Close dropdown on outside click
    useEffect(() => {
        if (!showSearch) return;
        const handler = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setShowSearch(false);
                setQuery('');
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showSearch]);

    // Autocomplete: filter known coins, exclude already whitelisted
    const whitelistSet = useMemo(() => new Set(whitelist.map(w => w.ticker)), [whitelist]);
    const suggestions  = useMemo(() => {
        const q = query.trim().toUpperCase();
        if (!q) return knownCoins.filter(c => !whitelistSet.has(c.ticker)).slice(0, 8);
        return knownCoins
            .filter(c => c.ticker.includes(q) && !whitelistSet.has(c.ticker))
            .slice(0, 8);
    }, [query, knownCoins, whitelistSet]);

    const addCoin = async (ticker, exchange) => {
        if (!ticker?.trim() || adding) return;
        setAdding(true);
        try {
            const res = await fetch('/api/whitelist', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker: ticker.trim(), exchange: exchange || 'BINANCE' }),
            });
            if (res.ok) {
                await fetchWhitelist();
                setQuery('');
                setShowSearch(false);
            }
        } catch {}
        finally { setAdding(false); }
    };

    const removeCoin = async (ticker) => {
        setRemoving(ticker);
        try {
            await fetch(`/api/whitelist/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
            await fetchWhitelist();
        } catch {}
        finally { setRemoving(null); }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && query.trim()) addCoin(query.trim(), 'BINANCE');
        if (e.key === 'Escape') { setShowSearch(false); setQuery(''); }
    };

    return (
        <div className={styles.section}>
            {/* Section header */}
            <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>
                    <ShieldCheck size={14} style={{ color: '#68D391' }} />
                    <span>Ghost Whitelist</span>
                    <span className={styles.countBadge} style={{ background: 'rgba(104,211,145,0.1)', color: '#68D391', borderColor: 'rgba(104,211,145,0.3)' }}>
                        {whitelist.length}
                    </span>
                </div>
                <button
                    className={styles.addBtn}
                    onClick={() => { setShowSearch(s => !s); setTimeout(() => searchRef.current?.focus(), 50); }}
                    title="Add coin to whitelist"
                >
                    <Plus size={12} /> Add Coin
                </button>
            </div>

            {/* Subtitle */}
            <div className={styles.whitelistHint}>
                Whitelisted coins bypass ghost pruning entirely —{' '}
                <span style={{ color: '#68D391', fontWeight: 600 }}>immune to Auto-Prune mode</span>.
                Coin + exchange stored for Stream B compatibility.
            </div>

            {/* Search + dropdown */}
            {showSearch && (
                <div className={styles.searchWrapper} ref={dropdownRef}>
                    <div className={styles.searchInputRow}>
                        <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        <input
                            ref={searchRef}
                            className={styles.searchInput}
                            placeholder="Type ticker… e.g. SOLUSDT, XRP, BNB"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />
                        {query.trim() && (
                            <button
                                className={styles.addConfirmBtn}
                                onClick={() => addCoin(query.trim())}
                                disabled={adding}
                            >
                                {adding ? '…' : 'Pin'}
                            </button>
                        )}
                    </div>
                    {suggestions.length > 0 && (
                        <div className={styles.suggestionDropdown}>
                            {suggestions.map(c => (
                                <button
                                    key={c.ticker}
                                    className={styles.suggestionItem}
                                    onClick={() => addCoin(c.ticker, c.exchange)}
                                >
                                    <span className={styles.suggTicker}>{c.ticker}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <span className={styles.suggExchange}>{c.exchange || 'BINANCE'}</span>
                                        <span className={`${styles.suggStatus} ${c.status === 'ACTIVE' ? styles.suggActive : styles.suggDead}`}>
                                            {c.status}
                                        </span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Whitelist chips */}
            {whitelist.length === 0 ? (
                <div className={styles.emptyState} style={{ padding: '12px 0 4px' }}>
                    No coins whitelisted — click <strong>Add Coin</strong> to pin one
                </div>
            ) : (
                <div className={styles.chipGrid}>
                    {whitelist.map(w => (
                        <div key={w.ticker} className={styles.whitelistChip} title={`${w.exchange}:${w.ticker} — immune to ghost pruning and Auto-Prune`}>
                            <Shield size={10} style={{ color: '#68D391', flexShrink: 0 }} />
                            <span className={styles.chipExchange}>{w.exchange || 'BINANCE'}</span>
                            <span className={styles.chipTicker}>{w.ticker}</span>
                            <button
                                className={styles.chipRemove}
                                onClick={() => removeCoin(w.ticker)}
                                disabled={removing === w.ticker}
                                title={`Remove ${w.ticker} from whitelist`}
                            >
                                <X size={10} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Main Widget ───────────────────────────────────────────────────────────────
export function GhostCoinWidget() {
    const containerRef = useRef(null);

    return (
        <div ref={containerRef} className={styles.widget}>
            <div className={styles.widgetHeader}>
                <Ghost size={16} strokeWidth={2.5} style={{ color: '#f6ad55' }} />
                <h4 className={styles.widgetTitle}>Ghost Management</h4>
            </div>
            <GhostQueue containerRef={containerRef} />
            <div className={styles.divider} />
            <WhitelistSection />
        </div>
    );
}

export default GhostCoinWidget;
