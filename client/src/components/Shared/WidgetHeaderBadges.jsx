import React, { useEffect, useState } from 'react';
import { Clock, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import styles from './WidgetHeaderBadges.module.css';

/**
 * Shared header chrome for every widget.
 *
 * Three independent micro-components that can be composed into any widget's
 * header. Drop them in wherever you want — they don't impose a layout.
 *
 *   <LastSyncBadge ts={lastFetchedAt} />
 *   <ResetPrefsButton onReset={() => …}  title="Reset to defaults" />
 *   <CollapseButton collapsed={isCollapsed} onToggle={() => …} />
 *
 * Naming convention (so all widgets agree on the look):
 *   - LastSyncBadge ALWAYS shows "Xs/m/h ago" with a clock icon, hover for full TS
 *   - ResetPrefsButton ALWAYS shows a rotate-ccw icon, default title "Reset to defaults"
 *   - CollapseButton uses ChevronDown when expanded, ChevronRight when collapsed
 */

// ─── LastSyncBadge ──────────────────────────────────────────────────────────
export function LastSyncBadge({ ts, label = 'updated' }) {
    // Re-render every 15s so the relative-time string stays fresh.
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!ts) return;
        const id = setInterval(() => setTick(n => n + 1), 15_000);
        return () => clearInterval(id);
    }, [ts]);

    if (!ts) return null;
    const ms = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    const sec = Math.floor(ms / 1000);
    let text;
    if (sec < 5)        text = 'just now';
    else if (sec < 60)  text = `${sec}s ago`;
    else if (sec < 3600) text = `${Math.floor(sec / 60)}m ago`;
    else if (sec < 86400) text = `${Math.floor(sec / 3600)}h ago`;
    else                text = `${Math.floor(sec / 86400)}d ago`;

    const stale = sec > 300;  // > 5 min = orange tint
    const dead  = sec > 1800; // > 30 min = red tint

    return (
        <span
            className={`${styles.syncBadge} ${stale ? styles.syncStale : ''} ${dead ? styles.syncDead : ''}`}
            title={new Date(ts).toLocaleString()}
        >
            <Clock size={9} />
            <span>{label} {text}</span>
        </span>
    );
}

// ─── ResetPrefsButton ───────────────────────────────────────────────────────
export function ResetPrefsButton({ onReset, title = 'Reset to defaults', confirm = true }) {
    const handleClick = () => {
        if (confirm && !window.confirm('Reset this widget to default settings?')) return;
        onReset();
    };
    return (
        <button
            type="button"
            className={styles.resetBtn}
            onClick={handleClick}
            title={title}
            aria-label={title}
        >
            <RotateCcw size={12} />
        </button>
    );
}

// ─── CollapseButton ─────────────────────────────────────────────────────────
export function CollapseButton({ collapsed, onToggle, title }) {
    return (
        <button
            type="button"
            className={styles.collapseBtn}
            onClick={onToggle}
            title={title || (collapsed ? 'Expand' : 'Collapse')}
            aria-label={collapsed ? 'Expand widget' : 'Collapse widget'}
            aria-expanded={!collapsed}
        >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
    );
}

export default { LastSyncBadge, ResetPrefsButton, CollapseButton };
