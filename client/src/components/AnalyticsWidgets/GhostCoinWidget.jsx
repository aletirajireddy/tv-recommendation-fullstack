import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Ghost, Shield, ShieldCheck, Plus, X, Search } from 'lucide-react';
import styles from './GhostCoinWidget.module.css';
import { FreshnessChip } from '../FreshnessChip';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';

// ── Ghost Queue Section ───────────────────────────────────────────────────────
function GhostQueue({ containerRef }) {
    const lastDataPush = useTimeStore(s => s.lastDataPush);
    const [queue, setQueue]           = useState([]);
    const [autoApprove, setAutoApprove] = useState(false);
    const [loading, setLoading]       = useState(true);
    const [lastFetchedAt, setLastFetchedAt] = useState(null);

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

    useEffect(() => {
        fetchQueue();
        const interval = setInterval(fetchQueue, 30_000);
        return () => clearInterval(interval);
    }, [fetchQueue]);

    useDataInvalidation(containerRef, fetchQueue, lastDataPush);

    const toggleAutoApprove = async () => {
        const next = !autoApprove;
        setAutoApprove(next);
        try {
            await fetch('/api/ghosts/toggle-auto', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            fetchQueue();
        } catch { setAutoApprove(!next); }
    };

    const approveAll = async () => {
        try { await fetch('/api/ghosts/approve-all', { method: 'POST' }); fetchQueue(); } catch {}
    };

    const approveCoin = async (ticker) => {
        try {
            await fetch('/api/ghosts/approve', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker }),
            });
            fetchQueue();
        } catch {}
    };

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
                    <span className={styles.toggleLabel}>Auto-Prune</span>
                    <label className={styles.switch}>
                        <input type="checkbox" checked={autoApprove} onChange={toggleAutoApprove} />
                        <span className={styles.slider} />
                    </label>
                    {queue.length > 0 && !autoApprove && (
                        <button className={styles.approveAllBtn} onClick={approveAll}>Approve All</button>
                    )}
                </div>
            </div>

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
                        return (
                            <div key={coin.ticker} className={styles.coinRow}>
                                <div className={styles.coinInfo}>
                                    <div className={styles.ticker}>{coin.ticker}</div>
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
                                <button className={styles.approveBtn} onClick={() => approveCoin(coin.ticker)}>
                                    Prune
                                </button>
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
