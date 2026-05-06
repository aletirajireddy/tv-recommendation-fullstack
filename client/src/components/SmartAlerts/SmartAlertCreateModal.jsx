// Modal dialog for creating an EMA200-distance smart alert.
// Pre-filled when launched from a DistanceTracker cell click.
//
// User picks: triggers (multi-select), thresholds in ATR units (sliders),
// expiry window, recurring vs one-shot. Defaults are sensible so the user
// can usually just hit "Create" without touching anything.

import React, { useState, useEffect } from 'react';
import { X, Bell, Info } from 'lucide-react';
import styles from './SmartAlertCreateModal.module.css';

const TF_LABELS = { m1: '1m', m5: '5m', m15: '15m', h1: '1h', h4: '4h' };

// Per-TF APPROACH defaults — mirrors server/services/smartAlerts/service.js.
// Short TFs use a smaller multiplier because they fall back to 15m ATR
// (which is ~3-4× larger than real 1m/5m ATR). This keeps "half a candle away"
// semantics consistent across the whole watchlist.
const APPROACH_ATR_DEFAULTS = { m1: 0.18, m5: 0.25, m15: 0.45, h1: 0.45, h4: 0.55 };
const TRIGGER_INFO = {
    approach: { label: 'Approaching',  desc: 'Price within configured ATR distance' },
    touch:    { label: 'Touched',      desc: 'Price essentially at the EMA' },
    cross:    { label: 'Crossed',      desc: 'Price flipped sides (above ↔ below)' },
};
const EXPIRY_OPTIONS = [
    { label: '4h',     value: 4 },
    { label: '12h',    value: 12 },
    { label: '24h',    value: 24 },
    { label: '3d',     value: 72 },
    { label: 'Never',  value: 0 },
];

export function SmartAlertCreateModal({ open, prefill, onClose, onCreated }) {
    const [triggers,    setTriggers]    = useState(['approach']);
    const [approachAtr, setApproachAtr] = useState(APPROACH_ATR_DEFAULTS[prefill?.timeframe] ?? 0.45);
    const [touchAtr,    setTouchAtr]    = useState(0.1);

    // Re-sync defaults whenever the user clicks a different TF cell
    useEffect(() => {
        setApproachAtr(APPROACH_ATR_DEFAULTS[prefill?.timeframe] ?? 0.45);
    }, [prefill?.timeframe, prefill?.ticker]);
    const [recurring,   setRecurring]   = useState(false);
    const [cooldownMin, setCooldownMin] = useState(15);
    const [expiryHours, setExpiryHours] = useState(24);
    const [note,        setNote]        = useState('');
    const [submitting,  setSubmitting]  = useState(false);
    const [err,         setErr]         = useState(null);

    if (!open || !prefill) return null;

    const { ticker, cleanTicker, timeframe, price, ema, atr, distancePct } = prefill;
    const distAtr = (atr && ema && price != null)
        ? (Math.abs((price - ema) / ema) * 100) / atr
        : null;

    const toggleTrigger = (t) => {
        setTriggers(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
    };

    const submit = async () => {
        if (!triggers.length) { setErr('Pick at least one trigger'); return; }
        setSubmitting(true); setErr(null);
        try {
            const r = await fetch('/api/smart-alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alert_type: 'EMA200',
                    ticker, clean_ticker: cleanTicker, timeframe,
                    triggers,
                    approach_atr: approachAtr, touch_atr: touchAtr,
                    recurring, cooldown_min: cooldownMin,
                    expiry_hours: expiryHours, note: note.trim() || undefined,
                    last_price: price, last_ema: ema, last_atr: atr,
                }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'Create failed');
            onCreated?.(j.alert);
            onClose();
        } catch (e) {
            setErr(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className={styles.backdrop} onClick={onClose}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <header className={styles.header}>
                    <div className={styles.title}>
                        <Bell size={16} className="text-accent-blue" />
                        <span>Smart Alert · <strong>{cleanTicker}</strong> · {TF_LABELS[timeframe] || timeframe} EMA200</span>
                    </div>
                    <button className={styles.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
                </header>

                {/* Snapshot row */}
                <div className={styles.snapshot}>
                    <div className={styles.snapItem}><span>Price</span><strong>{fmt(price)}</strong></div>
                    <div className={styles.snapItem}><span>EMA200</span><strong>{fmt(ema)}</strong></div>
                    <div className={styles.snapItem}>
                        <span>Distance</span>
                        <strong style={{ color: (distancePct ?? 0) >= 0 ? '#68d391' : '#fc8181' }}>
                            {distancePct != null ? `${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}%` : '—'}
                        </strong>
                    </div>
                    <div className={styles.snapItem}><span>ATR</span><strong>{atr != null ? `${atr.toFixed(2)}%` : '—'}</strong></div>
                    {distAtr != null && (
                        <div className={styles.snapItem} title="How many ATRs away from EMA right now">
                            <span>× ATR</span><strong>{distAtr.toFixed(2)}×</strong>
                        </div>
                    )}
                </div>

                {/* Triggers */}
                <section className={styles.section}>
                    <label className={styles.sectionLabel}>Trigger on (multi-select)</label>
                    <div className={styles.triggerGrid}>
                        {Object.entries(TRIGGER_INFO).map(([key, info]) => (
                            <label key={key} className={`${styles.triggerCard} ${triggers.includes(key) ? styles.triggerCardActive : ''}`}>
                                <input type="checkbox" checked={triggers.includes(key)} onChange={() => toggleTrigger(key)} />
                                <div>
                                    <div className={styles.triggerCardTitle}>{info.label}</div>
                                    <div className={styles.triggerCardDesc}>{info.desc}</div>
                                </div>
                            </label>
                        ))}
                    </div>
                </section>

                {/* Threshold sliders — only show relevant ones */}
                {triggers.includes('approach') && (
                    <section className={styles.section}>
                        <div className={styles.sliderHeader}>
                            <label>Approach when distance ≤ <strong>{approachAtr.toFixed(2)}× ATR</strong></label>
                            <span className={styles.hint}>
                                <Info size={11} /> Default for {TF_LABELS[timeframe] || timeframe}: {(APPROACH_ATR_DEFAULTS[timeframe] ?? 0.45).toFixed(2)}× · bigger = earlier alert
                            </span>
                        </div>
                        <input type="range" min="0.1" max="2" step="0.05"
                            value={approachAtr} onChange={(e) => setApproachAtr(parseFloat(e.target.value))}
                            className={styles.slider} />
                    </section>
                )}
                {triggers.includes('touch') && (
                    <section className={styles.section}>
                        <div className={styles.sliderHeader}>
                            <label>Touch when distance ≤ <strong>{touchAtr.toFixed(2)}× ATR</strong></label>
                            <span className={styles.hint}><Info size={11} /> Tighter = stricter "essentially at level"</span>
                        </div>
                        <input type="range" min="0.02" max="0.5" step="0.01"
                            value={touchAtr} onChange={(e) => setTouchAtr(parseFloat(e.target.value))}
                            className={styles.slider} />
                    </section>
                )}

                {/* Mode + expiry */}
                <section className={`${styles.section} ${styles.row}`}>
                    <div>
                        <label className={styles.sectionLabel}>Mode</label>
                        <div className={styles.pillGroup}>
                            <button type="button"
                                className={`${styles.pill} ${!recurring ? styles.pillActive : ''}`}
                                onClick={() => setRecurring(false)}>One-shot</button>
                            <button type="button"
                                className={`${styles.pill} ${recurring ? styles.pillActive : ''}`}
                                onClick={() => setRecurring(true)}>Recurring</button>
                        </div>
                    </div>
                    {recurring && (
                        <div>
                            <label className={styles.sectionLabel}>Cooldown</label>
                            <input type="number" min="1" max="240" value={cooldownMin}
                                onChange={(e) => setCooldownMin(parseInt(e.target.value) || 15)}
                                className={styles.numInput} />
                            <span className={styles.hint}>min</span>
                        </div>
                    )}
                    <div>
                        <label className={styles.sectionLabel}>Expires</label>
                        <div className={styles.pillGroup}>
                            {EXPIRY_OPTIONS.map(o => (
                                <button key={o.value} type="button"
                                    className={`${styles.pill} ${expiryHours === o.value ? styles.pillActive : ''}`}
                                    onClick={() => setExpiryHours(o.value)}>{o.label}</button>
                            ))}
                        </div>
                    </div>
                </section>

                {/* Note */}
                <section className={styles.section}>
                    <label className={styles.sectionLabel}>Note (optional)</label>
                    <input type="text" maxLength={280} value={note}
                        placeholder="e.g. waiting for retest before short"
                        onChange={(e) => setNote(e.target.value)}
                        className={styles.textInput} />
                </section>

                {err && <div className={styles.errorBanner}>{err}</div>}

                <footer className={styles.footer}>
                    <button className={styles.cancelBtn} onClick={onClose} disabled={submitting}>Cancel</button>
                    <button className={styles.createBtn} onClick={submit} disabled={submitting}>
                        {submitting ? 'Creating…' : 'Create Alert'}
                    </button>
                </footer>
            </div>
        </div>
    );
}

function fmt(p) {
    if (p == null || isNaN(p)) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1)    return p.toFixed(4);
    if (p >= 0.01) return p.toFixed(5);
    return p.toFixed(8);
}

export default SmartAlertCreateModal;
