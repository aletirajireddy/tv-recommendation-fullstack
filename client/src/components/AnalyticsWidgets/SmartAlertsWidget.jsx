// SmartAlertsWidget — full management surface for smart alerts.
// Tabs: Active | Qualified | Expired | All. Per-tab bulk actions
// (mark all read, delete all). Per-alert: enable/disable toggle,
// expand to view full state-transition history, soft-delete.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { FreshnessChip } from '../FreshnessChip';
import { Bell, RefreshCw, Trash2, CheckCheck, Power, ChevronDown, ChevronRight, Clock, Activity, AlertTriangle } from 'lucide-react';
import socketService from '../../services/SocketService';
import styles from './SmartAlertsWidget.module.css';

const TF_LABELS = { m1: '1m', m5: '5m', m15: '15m', h1: '1h', h4: '4h' };
const TABS = [
    { key: 'active',    label: 'Active',    color: '#63b3ed' },
    { key: 'qualified', label: 'Qualified', color: '#68d391' },
    { key: 'expired',   label: 'Expired',   color: '#a0aec0' },
    { key: 'disabled',  label: 'Disabled',  color: '#718096' },
    { key: 'all',       label: 'All',       color: '#cbd5e0' },
];
const TRIGGER_LABEL = { approach: '◐ Approach', touch: '◉ Touch', cross: '⇄ Cross' };

function fmtPrice(p) {
    if (p == null || isNaN(p)) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1)    return p.toFixed(4);
    if (p >= 0.01) return p.toFixed(5);
    return p.toFixed(8);
}
function timeAgo(iso) {
    if (!iso) return '—';
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

export function SmartAlertsWidget() {
    const [tab,          setTab]         = useState('active');
    const [data,         setData]        = useState({ alerts: [], counts: {}, unread: 0 });
    const [loading,      setLoading]     = useState(true);
    const [error,        setError]       = useState(null);
    const [expandedId,   setExpandedId]  = useState(null);
    const [lastFetchedAt, setLastFetchedAt] = useState(null);

    const reload = useCallback(async () => {
        try {
            const r = await fetch(`/api/smart-alerts?state=${tab}&limit=200`);
            const j = await r.json();
            if (j.error) throw new Error(j.error);
            setData(j); setError(null); setLastFetchedAt(Date.now());
        } catch (e) { setError(e.message); }
        finally    { setLoading(false); }
    }, [tab]);

    useEffect(() => { reload(); }, [reload]);

    // Live updates — debounced silent reload on smart-alert events
    useEffect(() => {
        const socket = socketService.connect();
        let timeout;
        const handler = () => { clearTimeout(timeout); timeout = setTimeout(reload, 800); };
        socket.on('smart-alert-qualified', handler);
        socket.on('smart-alert-expired',   handler);
        return () => {
            clearTimeout(timeout);
            socket.off('smart-alert-qualified', handler);
            socket.off('smart-alert-expired',   handler);
        };
    }, [reload]);

    const toggleEnabled = async (alert) => {
        await fetch(`/api/smart-alerts/${alert.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !alert.enabled }),
        });
        reload();
    };
    const deleteOne = async (alert) => {
        if (!confirm(`Delete alert for ${alert.clean_ticker} ${TF_LABELS[alert.timeframe] || alert.timeframe}?`)) return;
        await fetch(`/api/smart-alerts/${alert.id}`, { method: 'DELETE' });
        reload();
    };
    const markAllRead = async () => {
        await fetch('/api/smart-alerts/mark-all-read', { method: 'POST' });
        reload();
    };
    const bulkDelete = async () => {
        if (!confirm(`Delete ALL ${tab === 'all' ? '' : tab + ' '}alerts? This cannot be undone.`)) return;
        await fetch('/api/smart-alerts/bulk-delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: tab }),
        });
        reload();
    };

    const grouped = useMemo(() => {
        // Group by trigger type (most-recent qualified event_type) for the Qualified tab
        if (tab !== 'qualified') return { _: data.alerts || [] };
        const out = { approach: [], touch: [], cross: [], other: [] };
        for (const a of data.alerts || []) {
            // Best-effort: find the latest event_type from triggers (we don't have events here yet)
            // so just bucket by the FIRST trigger; events tab will show more detail
            const t = (a.triggers && a.triggers[0]) || 'other';
            (out[t] || out.other).push(a);
        }
        return out;
    }, [tab, data.alerts]);

    return (
        <div className={styles.widget}>
            <header className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><Bell size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>SMART ALERTS</span>
                        <span className={styles.titleSub}>EMA200 · ATR-normalised triggers</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <FreshnessChip ts={lastFetchedAt} title="Alerts last fetched from server" />
                        <button className={styles.refreshBtn} onClick={reload} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>

                <div className={styles.tabsRow}>
                    {TABS.map(t => {
                        const c = data.counts?.[t.key];
                        const total = t.key === 'all'
                            ? (data.counts ? Object.values(data.counts).reduce((s, v) => s + v, 0) : 0)
                            : (c ?? 0);
                        const isActive = tab === t.key;
                        return (
                            <button key={t.key}
                                className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                                style={isActive ? { borderColor: t.color, color: t.color } : {}}
                                onClick={() => { setTab(t.key); setExpandedId(null); }}>
                                {t.label}
                                <span className={styles.tabCount}>{total}</span>
                                {t.key === 'qualified' && data.unread > 0 && (
                                    <span className={styles.unreadDot} title={`${data.unread} unread`} />
                                )}
                            </button>
                        );
                    })}

                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        {tab === 'qualified' && data.unread > 0 && (
                            <button className={styles.bulkBtn} onClick={markAllRead} title="Mark all read">
                                <CheckCheck size={12} /> Mark read
                            </button>
                        )}
                        {(data.alerts?.length || 0) > 0 && (
                            <button className={`${styles.bulkBtn} ${styles.bulkBtnDanger}`} onClick={bulkDelete} title={`Delete all ${tab} alerts`}>
                                <Trash2 size={12} /> Delete all
                            </button>
                        )}
                    </span>
                </div>
            </header>

            <div className={styles.body}>
                {error && <div className={styles.errorBanner}><AlertTriangle size={14} /> {error}</div>}
                {loading && !data.alerts?.length && (
                    <div className={styles.empty}><div className={styles.spinner} /> Loading…</div>
                )}
                {!loading && !data.alerts?.length && (
                    <div className={styles.empty}>
                        <Bell size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
                        <div>No {tab === 'all' ? '' : tab + ' '}alerts yet</div>
                        <div className={styles.hint}>
                            Click any TF cell in the Distance Tracker to create one
                        </div>
                    </div>
                )}

                {Object.entries(grouped).map(([groupKey, alerts]) => {
                    if (!alerts.length) return null;
                    return (
                        <div key={groupKey}>
                            {tab === 'qualified' && groupKey !== '_' && (
                                <div className={styles.groupHeader}>
                                    {TRIGGER_LABEL[groupKey] || groupKey.toUpperCase()}
                                    <span className={styles.groupCount}>{alerts.length}</span>
                                </div>
                            )}
                            {alerts.map(a => (
                                <AlertRow
                                    key={a.id}
                                    alert={a}
                                    expanded={expandedId === a.id}
                                    onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
                                    onToggleEnabled={() => toggleEnabled(a)}
                                    onDelete={() => deleteOne(a)}
                                />
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Per-alert row ──────────────────────────────────────────────────────────
function AlertRow({ alert, expanded, onToggle, onToggleEnabled, onDelete }) {
    const [events, setEvents] = useState(null);

    useEffect(() => {
        if (!expanded || events) return;
        let cancelled = false;
        fetch(`/api/smart-alerts/${alert.id}/events`)
            .then(r => r.json())
            .then(j => { if (!cancelled) setEvents(j.events || []); })
            .catch(() => { if (!cancelled) setEvents([]); });
        return () => { cancelled = true; };
    }, [expanded, alert.id, events]);

    const stateColor = {
        active:    '#63b3ed',
        qualified: '#68d391',
        expired:   '#a0aec0',
        disabled:  '#718096',
    }[alert.state] || '#718096';

    return (
        <div className={`${styles.row} ${alert.is_unread ? styles.rowUnread : ''}`}>
            <div className={styles.rowMain} onClick={onToggle}>
                <button className={styles.expandBtn} aria-label="Expand">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <div className={styles.tickerCol}>
                    <strong>{alert.clean_ticker}</strong>
                    <span className={styles.tfLabel}>{TF_LABELS[alert.timeframe] || alert.timeframe} EMA200</span>
                </div>
                <div className={styles.triggersCol}>
                    {(alert.triggers || []).map(t => (
                        <span key={t} className={styles.triggerChip}>{TRIGGER_LABEL[t] || t}</span>
                    ))}
                    {alert.params?.recurring && <span className={styles.recurringChip}>↻ recurring</span>}
                </div>
                <div className={styles.statsCol}>
                    {alert.last_price != null && (
                        <span title="Latest price seen">{fmtPrice(alert.last_price)}</span>
                    )}
                    {alert.last_ema != null && alert.last_price != null && (
                        <span className={styles.distChip}
                            style={{ color: alert.last_price >= alert.last_ema ? '#68d391' : '#fc8181' }}>
                            Δ {(((alert.last_price - alert.last_ema) / alert.last_ema) * 100).toFixed(2)}%
                        </span>
                    )}
                </div>
                <div className={styles.timesCol}>
                    <span><Clock size={9} /> {timeAgo(alert.created_at)}</span>
                    {alert.last_qualified_at && (
                        <span className={styles.firedTime}>
                            <Activity size={9} /> fired {timeAgo(alert.last_qualified_at)}
                            {alert.qualified_count > 1 ? ` ×${alert.qualified_count}` : ''}
                        </span>
                    )}
                </div>
                <div className={styles.stateCol} style={{ color: stateColor }}>
                    {alert.state}
                </div>
                <div className={styles.actionsCol} onClick={(e) => e.stopPropagation()}>
                    <button className={styles.iconBtn}
                        title={alert.enabled ? 'Disable' : 'Enable'}
                        onClick={onToggleEnabled}>
                        <Power size={12} color={alert.enabled ? '#68d391' : '#718096'} />
                    </button>
                    <button className={styles.iconBtn} title="Delete" onClick={onDelete}>
                        <Trash2 size={12} />
                    </button>
                </div>
            </div>

            {expanded && (
                <div className={styles.history}>
                    <div className={styles.historyHeader}>State transition history</div>
                    {!events && <div className={styles.historyEmpty}>Loading events…</div>}
                    {events && events.length === 0 && <div className={styles.historyEmpty}>No events yet</div>}
                    {events && events.length > 0 && (
                        <ul className={styles.historyList}>
                            {events.map(ev => (
                                <li key={ev.id}>
                                    <span className={`${styles.evType} ${styles[`evType_${ev.event_type}`] || ''}`}>
                                        {ev.event_type}
                                    </span>
                                    <span className={styles.evTime}>{timeAgo(ev.ts)}</span>
                                    <span className={styles.evMsg}>{ev.message}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {alert.params?.note && (
                        <div className={styles.note}>📝 {alert.params.note}</div>
                    )}
                </div>
            )}
        </div>
    );
}

export default SmartAlertsWidget;
