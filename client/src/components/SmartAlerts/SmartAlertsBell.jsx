// SmartAlertsBell — header bell icon with unread-badge + dropdown panel.
// Subscribes to socket smart-alert-qualified events for live badge updates.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Bell, CheckCheck, Trash2, ArrowRight } from 'lucide-react';
import socketService from '../../services/SocketService';
import styles from './SmartAlertsBell.module.css';

const TF_LABELS = { m1: '1m', m5: '5m', m15: '15m', h1: '1h', h4: '4h' };

function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400)return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

export function SmartAlertsBell() {
    const [open, setOpen] = useState(false);
    const [unread, setUnread] = useState(0);
    const [recent, setRecent] = useState([]);
    const [pulsing, setPulsing] = useState(false);
    const wrapRef = useRef(null);

    // Initial + periodic poll for unread count (cheap endpoint)
    const fetchUnread = useCallback(async () => {
        try {
            const r = await fetch('/api/smart-alerts/unread-count');
            const j = await r.json();
            setUnread(j.unread || 0);
        } catch { /* offline ok */ }
    }, []);

    const fetchRecent = useCallback(async () => {
        try {
            const r = await fetch('/api/smart-alerts?state=qualified&limit=10');
            const j = await r.json();
            setRecent((j.alerts || []).slice(0, 10));
        } catch { /* offline ok */ }
    }, []);

    useEffect(() => {
        fetchUnread();
        const iv = setInterval(fetchUnread, 60_000); // safety net poll
        return () => clearInterval(iv);
    }, [fetchUnread]);

    // Live badge — bump on every smart-alert-qualified socket event
    useEffect(() => {
        const socket = socketService.connect();
        const onQualified = () => {
            fetchUnread();
            if (open) fetchRecent();
            setPulsing(true);
            setTimeout(() => setPulsing(false), 1500);
        };
        socket.on('smart-alert-qualified', onQualified);
        return () => socket.off('smart-alert-qualified', onQualified);
    }, [fetchUnread, fetchRecent, open]);

    // Lazy-load the dropdown contents
    useEffect(() => { if (open) fetchRecent(); }, [open, fetchRecent]);

    // Close on outside click / ESC
    useEffect(() => {
        if (!open) return;
        const onClick = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
        const onKey   = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const markAllRead = async () => {
        await fetch('/api/smart-alerts/mark-all-read', { method: 'POST' });
        fetchUnread(); fetchRecent();
    };

    const goToWidget = () => {
        setOpen(false);
        const el = document.getElementById('section-alerts');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <div className={styles.wrap} ref={wrapRef}>
            <button
                className={`${styles.bellBtn} ${pulsing ? styles.bellPulse : ''}`}
                onClick={() => setOpen(o => !o)}
                title={unread ? `${unread} unread smart alert${unread > 1 ? 's' : ''}` : 'Smart Alerts'}
            >
                <Bell size={18} />
                {unread > 0 && (
                    <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>
                )}
            </button>

            {open && (
                <div className={styles.dropdown}>
                    <header className={styles.dropHeader}>
                        <strong>Smart Alerts</strong>
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                            {unread > 0 && (
                                <button className={styles.smallBtn} onClick={markAllRead} title="Mark all read">
                                    <CheckCheck size={11} /> read
                                </button>
                            )}
                            <button className={styles.smallBtn} onClick={goToWidget} title="View all">
                                <ArrowRight size={11} /> all
                            </button>
                        </span>
                    </header>

                    <div className={styles.dropBody}>
                        {recent.length === 0 && (
                            <div className={styles.empty}>
                                <Bell size={20} style={{ opacity: 0.3, marginBottom: 6 }} />
                                <div>No qualified alerts</div>
                                <div className={styles.hint}>Click any TF cell in the Distance Tracker to create one</div>
                            </div>
                        )}
                        {recent.map(a => (
                            <div key={a.id} className={`${styles.dropRow} ${a.is_unread ? styles.dropRowUnread : ''}`}>
                                <div className={styles.dropTicker}>
                                    <strong>{a.clean_ticker}</strong>
                                    <span>{TF_LABELS[a.timeframe] || a.timeframe}</span>
                                </div>
                                <div className={styles.dropMeta}>
                                    <span className={styles.dropTriggers}>{(a.triggers || []).join(' · ')}</span>
                                    <span className={styles.dropTime}>{timeAgo(a.last_qualified_at || a.created_at)} ago</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default SmartAlertsBell;
