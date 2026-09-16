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
    const [momentumHours, setMomentumHours]        = useState(2);
    // Max coins allowed in the real TV watchlist. Majors (BTC/ETH) and
    // whitelist pins are never evicted; beyond that, the LOWEST current-volume
    // coins are dropped first when over the cap — highest volume survives.
    const [watchlistMaxCoins, setWatchlistMaxCoins] = useState(35);
    // How a Fresh Session reset treats a coin still visible on the live DOM
    // screener: 'bypass' force-removes it anyway (re-earns via a fresh 8/20min
    // cycle); 'smart' still protects it via VETO_PRUNE, same as normal prune
    // cycles. See coin_scanner.js v20.13.
    const [freshSessionVetoMode, setFreshSessionVetoMode] = useState('bypass');
    // Strict Screened Coin — when on, coin_scanner.js (Stream B) verifies the
    // watchlist's "screened" filter pill is actually applied in the DOM before
    // trusting a telemetry cycle; if the filter dropped (e.g. accidentally
    // cleared), it reloads the page instead of silently sending an unfiltered,
    // wrong universe of symbols. Off by default — opt in once the DOM selector
    // is confirmed correct for your screener setup.
    const [strictScreenedCoin, setStrictScreenedCoin] = useState(true);
    // Backend-driven tab activation for Stream B — when its telemetry (market_context_logs)
    // goes stale past this many minutes, the next response carries this Automa
    // workflow ID and coin_scanner.js dispatches it to bring the tab to front.
    // Both editable here — no script/backend redeploy needed to change either.
    const [tabActivateWorkflowIdB, setTabActivateWorkflowIdB] = useState('3lt4ZkHylt3L0uQlo05iH');
    const [tabActivateThresholdMinB, setTabActivateThresholdMinB] = useState(6);
    // 2026-09-10: Stream A/D now both have their own backend-driven
    // tab-activate dispatch (A: v16.3+, D: v1.6) — same pattern as B's.
    // 2026-09-16: streamAInitialSetupWorkflowId is now genuinely live, not
    // just reference/config-only — the backend includes it as
    // stream_a_setup_workflow_id in every /scan-report response and
    // symbol_market_scanner.js v16.7+ dispatches that value instead of its
    // hardcoded default. (Before v16.7, editing this field here saved to
    // system_settings but had no effect — confirmed dead wiring, fixed.)
    const [streamAInitialSetupWorkflowId, setStreamAInitialSetupWorkflowId] = useState('3lcKzNfE_GyXzpUMKxwVi');
    const [tabActivateWorkflowIdA, setTabActivateWorkflowIdA] = useState('9NoMligzmg3VE9SJMC942');
    const [tabActivateThresholdMinA, setTabActivateThresholdMinA] = useState(6);
    const [tabActivateWorkflowIdD, setTabActivateWorkflowIdD] = useState('h3ixjpLixrztE_ZzhLWtk');
    const [tabActivateThresholdMinD, setTabActivateThresholdMinD] = useState(6);
    // 2026-09-11: watchlist sync fallback — a heavier recovery action for
    // when a specific ticker's normal sync retry has clearly stopped working
    // (confirmed live: BCH/ETHFI stuck 15h+, 75 forced retries, never
    // landing). Past this many escalations for any one ticker, the backend
    // dispatches this Automa workflow instead of repeating the same failing
    // retry forever.
    const [watchlistSyncFallbackWorkflowId, setWatchlistSyncFallbackWorkflowId] = useState('4mxKJE8VxWpqztNVK5Wn_');
    const [watchlistSyncFallbackEscalationThreshold, setWatchlistSyncFallbackEscalationThreshold] = useState(5);
    const [watchlistSyncFallbackCooldownMin, setWatchlistSyncFallbackCooldownMin] = useState(15);
    const [settingsOpen, setSettingsOpen]          = useState(false);
    const [savingSettings, setSavingSettings]      = useState(false);

    // Fresh Session — manual, destructive reset. Two-step confirm: first click
    // arms it (shows "Confirm?" for a few seconds), second click within that
    // window actually fires it. Auto-disarms if you don't confirm in time, so
    // an accidental second click days later can't trigger it.
    //
    // A request only PROVES intent — it does not prove Automa actually cleared
    // the live watchlist. So we don't declare success on the POST response; we
    // poll /fresh-session-status until the backend has seen a real watchlist
    // snapshot confirming (or failing to confirm) the reset actually landed.
    const [freshSessionArmed, setFreshSessionArmed] = useState(false);
    const [freshSessionBusy, setFreshSessionBusy]   = useState(false);
    const [freshSessionEvents, setFreshSessionEvents] = useState([]);
    const [freshSessionLogOpen, setFreshSessionLogOpen] = useState(false);
    const freshSessionArmTimer = useRef(null);
    const freshSessionPollTimer = useRef(null);

    const fetchFreshSessionStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/watchlist/fresh-session-status?limit=10');
            if (res.ok) {
                const data = await res.json();
                setFreshSessionEvents(data.events || []);
                return data.events || [];
            }
        } catch (e) { console.error('Fresh session status fetch failed', e); }
        return [];
    }, []);

    // Poll every 8s while the latest event is still in flight (PENDING or
    // AWAITING_CONFIRMATION); stop once it resolves either way.
    const pollFreshSessionUntilResolved = useCallback(() => {
        if (freshSessionPollTimer.current) clearInterval(freshSessionPollTimer.current);
        freshSessionPollTimer.current = setInterval(async () => {
            const events = await fetchFreshSessionStatus();
            const latest = events[0];
            if (!latest || latest.status === 'CONFIRMED' || latest.status === 'TIMED_OUT') {
                clearInterval(freshSessionPollTimer.current);
                freshSessionPollTimer.current = null;
            }
        }, 8000);
    }, [fetchFreshSessionStatus]);

    const triggerFreshSession = useCallback(async () => {
        if (!freshSessionArmed) {
            setFreshSessionArmed(true);
            if (freshSessionArmTimer.current) clearTimeout(freshSessionArmTimer.current);
            freshSessionArmTimer.current = setTimeout(() => setFreshSessionArmed(false), 6000);
            return;
        }
        if (freshSessionArmTimer.current) clearTimeout(freshSessionArmTimer.current);
        setFreshSessionArmed(false);
        setFreshSessionBusy(true);
        try {
            await fetch('/api/watchlist/fresh-session', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: true }),
            });
        } catch (e) { console.error('Fresh session trigger failed', e); }
        finally {
            setFreshSessionBusy(false);
            await fetchFreshSessionStatus();
            pollFreshSessionUntilResolved();
            setFreshSessionLogOpen(true);
        }
    }, [freshSessionArmed, fetchFreshSessionStatus, pollFreshSessionUntilResolved]);

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
                setMomentumHours(data.momentumHours);
                if (data.freshSessionVetoMode) setFreshSessionVetoMode(data.freshSessionVetoMode);
                if (typeof data.strictScreenedCoin === 'boolean') setStrictScreenedCoin(data.strictScreenedCoin);
                if (data.watchlistMaxCoins) setWatchlistMaxCoins(data.watchlistMaxCoins);
                if (data.tabActivateWorkflowIdB) setTabActivateWorkflowIdB(data.tabActivateWorkflowIdB);
                if (data.tabActivateThresholdMinB) setTabActivateThresholdMinB(data.tabActivateThresholdMinB);
                if (data.streamAInitialSetupWorkflowId) setStreamAInitialSetupWorkflowId(data.streamAInitialSetupWorkflowId);
                if (data.tabActivateWorkflowIdA) setTabActivateWorkflowIdA(data.tabActivateWorkflowIdA);
                if (data.tabActivateThresholdMinA) setTabActivateThresholdMinA(data.tabActivateThresholdMinA);
                if (data.tabActivateWorkflowIdD) setTabActivateWorkflowIdD(data.tabActivateWorkflowIdD);
                if (data.tabActivateThresholdMinD) setTabActivateThresholdMinD(data.tabActivateThresholdMinD);
                if (data.watchlistSyncFallbackWorkflowId) setWatchlistSyncFallbackWorkflowId(data.watchlistSyncFallbackWorkflowId);
                if (data.watchlistSyncFallbackEscalationThreshold) setWatchlistSyncFallbackEscalationThreshold(data.watchlistSyncFallbackEscalationThreshold);
                if (data.watchlistSyncFallbackCooldownMin) setWatchlistSyncFallbackCooldownMin(data.watchlistSyncFallbackCooldownMin);
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

    // On mount: load recent fresh-session history so the log persists across
    // reloads. If the LATEST event is still unresolved (e.g. you reloaded the
    // page mid-wait), resume polling automatically rather than leaving it stuck.
    useEffect(() => {
        (async () => {
            const events = await fetchFreshSessionStatus();
            const latest = events[0];
            if (latest && latest.status !== 'CONFIRMED' && latest.status !== 'TIMED_OUT') {
                pollFreshSessionUntilResolved();
            }
        })();
        return () => {
            if (freshSessionPollTimer.current) clearInterval(freshSessionPollTimer.current);
            if (freshSessionArmTimer.current) clearTimeout(freshSessionArmTimer.current);
        };
    }, [fetchFreshSessionStatus, pollFreshSessionUntilResolved]);

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
                    {queue.length > 0 && (() => {
                        // 2026-09-16: this button used to be hidden entirely in
                        // auto-prune mode, back when auto mode never produced
                        // queue entries at all (instant prune, no window). Now
                        // that both modes share the same ghost-hours watch
                        // window, this is how you prune a coin early instead
                        // of waiting out the rest of its countdown — still
                        // useful in auto mode, not just manual.
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
                                        : autoApprove ? 'Prune Now' : 'Approve All'}
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
                        { key: 'momentumHours', label: 'Momentum hours', value: momentumHours, setValue: setMomentumHours, min: 0.25, max: 24, step: 0.25,
                          hint: 'How long a freshly graduated coin has to prove real momentum (score or breakout). No momentum by then — discarded now, not after another wait. Real momentum — verified, skips settle hours going forward.' },
                        { key: 'settleHours', label: 'Settle hours', value: settleHours, setValue: setSettleHours, min: 0, max: 72, step: 1,
                          hint: 'A coin younger than this is never judged for pruning at all. Coins that already passed momentum-watch skip this.' },
                        { key: 'ghostHours', label: 'Ghost hours', value: ghostHours, setValue: setGhostHours, min: 1, max: 336, step: 1,
                          hint: '2026-09-16: now applies in both modes — how long a flagged coin gets to show momentum before the window closes. Auto-Prune ON: removed from the watchlist when it expires. Auto-Prune OFF: reset to a fresh clock instead, stays on the watchlist.' },
                        { key: 'watchlistMaxCoins', label: 'Max watchlist coins', value: watchlistMaxCoins, setValue: setWatchlistMaxCoins, min: 2, max: 200, step: 1,
                          hint: 'Cap on the real TV watchlist. Majors (BTC/ETH) and whitelist pins are never evicted. Beyond that, the lowest current-volume coins are dropped first when over the cap.' },
                        { key: 'gapToleranceMin', label: 'Gap tolerance (min)', value: gapToleranceMin, setValue: setGapToleranceMin, min: 1, max: 120, step: 1,
                          hint: 'A scan gap bigger than this resets every coin’s confidence clock (system was offline).' },
                        { key: 'tabActivateThresholdMinB', label: 'Tab activate after (min) - B', value: tabActivateThresholdMinB, setValue: setTabActivateThresholdMinB, min: 2, max: 60, step: 1,
                          hint: 'Stream B — how stale market_context_logs has to get before the backend tells the tab to activate itself via Automa.' },
                        { key: 'tabActivateThresholdMinA', label: 'Tab activate after (min) - A', value: tabActivateThresholdMinA, setValue: setTabActivateThresholdMinA, min: 2, max: 60, step: 1,
                          hint: 'Stream A — how stale the scans table has to get before the backend tells the tab to activate itself via Automa.' },
                        { key: 'tabActivateThresholdMinD', label: 'Tab activate after (min) - D', value: tabActivateThresholdMinD, setValue: setTabActivateThresholdMinD, min: 2, max: 60, step: 1,
                          hint: 'Stream D — how stale coin_metric_history has to get before the backend tells the tab to activate itself via Automa.' },
                        { key: 'watchlistSyncFallbackEscalationThreshold', label: 'Sync fallback after (escalations)', value: watchlistSyncFallbackEscalationThreshold, setValue: setWatchlistSyncFallbackEscalationThreshold, min: 1, max: 50, step: 1,
                          hint: 'How many failed forced-retry escalations a single stuck ticker needs before the backend gives up on the normal retry and dispatches the fallback workflow instead.' },
                        { key: 'watchlistSyncFallbackCooldownMin', label: 'Sync fallback cooldown (min)', value: watchlistSyncFallbackCooldownMin, setValue: setWatchlistSyncFallbackCooldownMin, min: 2, max: 120, step: 1,
                          hint: 'Minimum time between two fallback-workflow dispatches, so it does not fire every single cycle while a ticker stays stuck.' },
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

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="Controls how a Fresh Session reset treats a coin still visible on the live DOM screener. Force: removed anyway, re-earns its spot via a fresh 8/20min cycle. Smart: still protected from removal, same as normal prune cycles.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Fresh session veto</span>
                        <select
                            value={freshSessionVetoMode}
                            onChange={e => {
                                const v = e.target.value;
                                setFreshSessionVetoMode(v);
                                saveWatchdogSetting('freshSessionVetoMode', v);
                            }}
                            style={{
                                width: 130, padding: '3px 6px', borderRadius: 4,
                                border: '1px solid var(--border)', background: 'var(--bg-app)',
                                color: 'var(--text-main)', fontSize: 12,
                            }}
                        >
                            <option value="bypass">Force reset (default)</option>
                            <option value="smart">Smart filter (keep on-screener)</option>
                        </select>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="When on, Stream B (coin_scanner.js) checks that the watchlist's 'screened' filter pill is actually applied before trusting a telemetry cycle. If the filter's missing — meaning the watchlist may be showing an unfiltered, wrong universe of symbols — it reloads the page (bounded retries) instead of silently sending unscreened data.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Strict screened coin</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', height: 24 }}>
                            <input
                                type="checkbox"
                                checked={strictScreenedCoin}
                                onChange={e => {
                                    const v = e.target.checked;
                                    setStrictScreenedCoin(v);
                                    saveWatchdogSetting('strictScreenedCoin', v);
                                }}
                            />
                            <span style={{ color: 'var(--text-main)', fontSize: 12 }}>{strictScreenedCoin ? 'On' : 'Off'}</span>
                        </label>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="Automa workflow ID dispatched when Stream B's tab is judged stale/hidden (past the 'Tab activate after' threshold). Find this in Automa's dashboard — workflow settings / URL. Changing it here takes effect on the next backend response, no script edit needed.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Tab-activate workflow ID (B)</span>
                        <input
                            type="text"
                            value={tabActivateWorkflowIdB}
                            onChange={e => setTabActivateWorkflowIdB(e.target.value)}
                            onBlur={() => {
                                const v = tabActivateWorkflowIdB.trim();
                                if (v) saveWatchdogSetting('tabActivateWorkflowIdB', v);
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{
                                width: 160, padding: '3px 6px', borderRadius: 4,
                                border: '1px solid var(--border)', background: 'var(--bg-app)',
                                color: 'var(--text-main)', fontSize: 12, fontFamily: 'monospace',
                            }}
                        />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="Automa workflow ID dispatched when Stream A's screener setup check fails (pills/columns/rows) — bounded retries, then a page reload after 3 failed attempts. Hardcoded in the script's CONFIG, not read from this setting yet — editable here for reference/future use.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Stream A initial-setup workflow ID</span>
                        <input
                            type="text"
                            value={streamAInitialSetupWorkflowId}
                            onChange={e => setStreamAInitialSetupWorkflowId(e.target.value)}
                            onBlur={() => {
                                const v = streamAInitialSetupWorkflowId.trim();
                                if (v) saveWatchdogSetting('streamAInitialSetupWorkflowId', v);
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{
                                width: 160, padding: '3px 6px', borderRadius: 4,
                                border: '1px solid var(--border)', background: 'var(--bg-app)',
                                color: 'var(--text-main)', fontSize: 12, fontFamily: 'monospace',
                            }}
                        />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="Automa workflow ID dispatched when Stream A's tab is judged stale/hidden (past the 'Tab activate after (min) - A' threshold). Changing it here takes effect on the next backend response, no script edit needed.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Tab-activate workflow ID (A)</span>
                        <input
                            type="text"
                            value={tabActivateWorkflowIdA}
                            onChange={e => setTabActivateWorkflowIdA(e.target.value)}
                            onBlur={() => {
                                const v = tabActivateWorkflowIdA.trim();
                                if (v) saveWatchdogSetting('tabActivateWorkflowIdA', v);
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{
                                width: 160, padding: '3px 6px', borderRadius: 4,
                                border: '1px solid var(--border)', background: 'var(--bg-app)',
                                color: 'var(--text-main)', fontSize: 12, fontFamily: 'monospace',
                            }}
                        />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="Automa workflow ID dispatched when Stream D's tab is judged stale/hidden (past the 'Tab activate after (min) - D' threshold). Changing it here takes effect on the next backend response, no script edit needed.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Tab-activate workflow ID (D)</span>
                        <input
                            type="text"
                            value={tabActivateWorkflowIdD}
                            onChange={e => setTabActivateWorkflowIdD(e.target.value)}
                            onBlur={() => {
                                const v = tabActivateWorkflowIdD.trim();
                                if (v) saveWatchdogSetting('tabActivateWorkflowIdD', v);
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{
                                width: 160, padding: '3px 6px', borderRadius: 4,
                                border: '1px solid var(--border)', background: 'var(--bg-app)',
                                color: 'var(--text-main)', fontSize: 12, fontFamily: 'monospace',
                            }}
                        />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                        title="Automa workflow ID dispatched when a single ticker's watchlist sync has failed repeatedly (past 'Sync fallback after (escalations)') and the normal retry has clearly stopped working. Opens a fresh tab and redoes the copy+paste from scratch. Changing it here takes effect on the next backend response, no script edit needed.">
                        <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Watchlist sync fallback workflow ID</span>
                        <input
                            type="text"
                            value={watchlistSyncFallbackWorkflowId}
                            onChange={e => setWatchlistSyncFallbackWorkflowId(e.target.value)}
                            onBlur={() => {
                                const v = watchlistSyncFallbackWorkflowId.trim();
                                if (v) saveWatchdogSetting('watchlistSyncFallbackWorkflowId', v);
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{
                                width: 160, padding: '3px 6px', borderRadius: 4,
                                border: '1px solid var(--border)', background: 'var(--bg-app)',
                                color: 'var(--text-main)', fontSize: 12, fontFamily: 'monospace',
                            }}
                        />
                    </div>

                    <span style={{ color: 'var(--text-muted)', fontSize: 10, opacity: savingSettings ? 1 : 0, transition: 'opacity 0.2s' }}>
                        saving…
                    </span>

                    {/* Fresh Session — destructive manual reset, two-step confirm */}
                    {(() => {
                        const latest = freshSessionEvents[0] || null;
                        const inFlight = latest && (latest.status === 'PENDING' || latest.status === 'AWAITING_CONFIRMATION');
                        let statusLine = null;
                        if (latest) {
                            if (latest.status === 'PENDING') {
                                statusLine = { text: '⏳ Waiting for browser check-in…', color: '#f6ad55' };
                            } else if (latest.status === 'AWAITING_CONFIRMATION') {
                                const elapsedS = latest.consumedAt ? Math.round((Date.now() - new Date(latest.consumedAt).getTime()) / 1000) : 0;
                                statusLine = { text: `⏳ Action going on — waiting to hear back from the browser (${elapsedS}s)…`, color: '#f6ad55' };
                            } else if (latest.status === 'CONFIRMED') {
                                statusLine = { text: `✅ Confirmed — round trip ${latest.totalRoundTripSec ?? '?'}s`, color: '#68d391' };
                            } else if (latest.status === 'TIMED_OUT') {
                                statusLine = { text: `⚠️ Not confirmed after 15m — ${latest.lastExtraCount ?? '?'} coin(s) still on the watchlist. Automa may not have applied it.`, color: '#fc8181' };
                            }
                        }
                        return (
                            <div style={{
                                marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 3,
                                alignItems: 'flex-end', borderLeft: '1px solid var(--border)', paddingLeft: 12, maxWidth: 260,
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <button
                                        onClick={() => setFreshSessionLogOpen(o => !o)}
                                        title="Show fresh-session log"
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                            width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border)',
                                            background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)',
                                            cursor: 'pointer', fontSize: 9,
                                        }}
                                    >☰</button>
                                    <button
                                        onClick={triggerFreshSession}
                                        disabled={freshSessionBusy || inFlight}
                                        title="Wipes graduation/ghost/sync history and resets the TV watchlist to just majors + whitelist. Every coin has to re-earn its way back in from scratch."
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 5,
                                            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                                            cursor: (freshSessionBusy || inFlight) ? 'default' : 'pointer',
                                            border: `1px solid ${freshSessionArmed ? '#fc8181' : 'var(--border)'}`,
                                            background: freshSessionArmed ? 'rgba(252,129,129,0.18)' : 'rgba(255,255,255,0.03)',
                                            color: freshSessionArmed ? '#fc8181' : 'var(--text-muted)',
                                            opacity: (freshSessionBusy || inFlight) ? 0.5 : 1,
                                        }}
                                    >
                                        <AlertTriangle size={11} />
                                        {freshSessionBusy ? 'Sending…' : freshSessionArmed ? 'Click again to confirm' : inFlight ? 'In progress…' : 'Fresh Session'}
                                    </button>
                                </div>
                                {statusLine && (
                                    <span style={{ fontSize: 9, color: statusLine.color, textAlign: 'right' }}>
                                        {statusLine.text}
                                    </span>
                                )}
                                {freshSessionLogOpen && (
                                    <div style={{
                                        marginTop: 4, padding: '6px 8px', borderRadius: 4, width: '100%',
                                        background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                                    }}>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>
                                            Fresh Session Log
                                        </div>
                                        {freshSessionEvents.length === 0 ? (
                                            <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>No resets yet</div>
                                        ) : (
                                            <div style={{
                                                display: 'flex', flexDirection: 'column', gap: 3,
                                                maxHeight: 96, overflowY: 'auto', paddingRight: 2,
                                            }}>
                                                {/* Newest first — backend returns ORDER BY id DESC, kept as-is here */}
                                                {freshSessionEvents.map(ev => {
                                                    const dotColor = ev.status === 'CONFIRMED' ? '#68d391'
                                                        : ev.status === 'TIMED_OUT' ? '#fc8181' : '#f6ad55';
                                                    const label = ev.status === 'CONFIRMED' ? `confirmed (${ev.totalRoundTripSec ?? '?'}s)`
                                                        : ev.status === 'TIMED_OUT' ? 'timed out'
                                                        : ev.status === 'AWAITING_CONFIRMATION' ? 'awaiting confirmation'
                                                        : 'pending';
                                                    return (
                                                        <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, gap: 6 }}>
                                                            <span style={{ color: 'var(--text-muted)' }}>
                                                                {new Date(ev.requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                            </span>
                                                            <span style={{ color: dotColor, textAlign: 'right' }}>● {label}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })()}
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
                                    {!isProtected && (() => {
                                        // 2026-09-16: both modes now share the same ghost_hours
                                        // window — show what's actually about to happen and when,
                                        // since the outcome at expiry differs by mode.
                                        const remainingMin = Math.max(0, Math.round(ghostHours * 60) - ageMin);
                                        const h = Math.floor(remainingMin / 60);
                                        const m = remainingMin % 60;
                                        const remainingLabel = remainingMin <= 0 ? 'due now' : `${h}h ${m}m`;
                                        const outcomeLabel = autoApprove ? 'auto-clears in' : 'resets in';
                                        return (
                                            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                                                {outcomeLabel} <strong style={{ color: remainingMin <= 0 ? '#f6ad55' : 'var(--text-muted)' }}>{remainingLabel}</strong>
                                            </div>
                                        );
                                    })()}
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
