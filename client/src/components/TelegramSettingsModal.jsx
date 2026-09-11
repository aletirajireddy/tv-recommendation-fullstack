import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Bell, Star, X, Search } from 'lucide-react';
import { useTimeStore } from '../store/useTimeStore';
import styles from './TelegramSettingsModal.module.css';

const COIN_CATEGORIES = [
    { key: 'breakout',      label: 'Breakout' },
    { key: 'institutional', label: 'Institutional' },
    { key: 'volume_spike',  label: 'Vol Spike' },
];

// coin_lifecycles.status values — GHOST is amber (pruning candidate), DEAD is muted.
const STATUS_CLASS = {
    ACTIVE: styles.suggActive,
    GHOST:  styles.suggGhost,
    DEAD:   styles.suggDead,
};

function Switch({ checked, onChange }) {
    return (
        <label className={styles.switch}>
            <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
            <span className={`${styles.switchTrack} ${checked ? styles.switchTrackOn : ''}`}>
                <span className={`${styles.switchThumb} ${checked ? styles.switchThumbOn : ''}`} />
            </span>
        </label>
    );
}

// Typeahead over the existing /api/coins/known list (coin_lifecycles — every
// ticker the system has ever tracked). Deliberately does NOT show/rely on
// that endpoint's `exchange` field — it falls back to a hardcoded 'BINANCE'
// server-side when the real exchange isn't known, which would mislabel any
// non-Binance ticker here. Coins of Interest doesn't need an exchange at all
// (telegram_watchlist stores bare normalized tickers), so it's simplest and
// safest to just not surface it.
function CoinAutocomplete({ existingTickers, onAdd }) {
    const [query, setQuery]     = useState('');
    const [knownCoins, setKnown] = useState([]);
    const [open, setOpen]       = useState(false);
    const wrapRef                = useRef(null);

    useEffect(() => {
        fetch('/api/coins/known')
            .then(r => r.ok ? r.json() : { coins: [] })
            .then(d => setKnown(d.coins || []))
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (!open) return;
        const onClickOutside = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [open]);

    const existingSet = useMemo(() => new Set(existingTickers), [existingTickers]);

    const suggestions = useMemo(() => {
        const q = query.trim().toUpperCase();
        const pool = knownCoins.filter(c => !existingSet.has(c.ticker));
        if (!q) return pool.slice(0, 8);
        return pool.filter(c => c.ticker.includes(q)).slice(0, 8);
    }, [query, knownCoins, existingSet]);

    const pick = useCallback((ticker) => {
        onAdd(ticker);
        setQuery('');
        setOpen(false);
    }, [onAdd]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (suggestions.length > 0) pick(suggestions[0].ticker);
            else if (query.trim()) pick(query.trim());
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    return (
        <div className={styles.searchWrapper} ref={wrapRef}>
            <div className={styles.addRow}>
                <div className={styles.searchInputRow} style={{ flex: 1 }}>
                    <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <input
                        className={styles.searchInput}
                        placeholder="Search ticker… e.g. BTC, SOLUSDT"
                        value={query}
                        onChange={e => { setQuery(e.target.value); setOpen(true); }}
                        onFocus={() => setOpen(true)}
                        onKeyDown={handleKeyDown}
                    />
                </div>
                <button
                    className={styles.addBtn}
                    onClick={() => query.trim() && pick(query.trim())}
                    disabled={!query.trim()}
                >
                    Add
                </button>
            </div>

            {open && suggestions.length > 0 && (
                <div className={styles.suggestionDropdown}>
                    {suggestions.map(c => (
                        <button key={c.ticker} className={styles.suggestionItem} onClick={() => pick(c.ticker)}>
                            <span className={styles.suggTicker}>{c.ticker}</span>
                            {c.status && (
                                <span className={`${styles.suggStatus} ${STATUS_CLASS[c.status] || ''}`}>
                                    {c.status}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function TelegramSettingsModal({ onClose }) {
    const [tab, setTab] = useState('categories');

    const categories        = useTimeStore(s => s.telegramCategories);
    const fetchCategories   = useTimeStore(s => s.fetchTelegramCategories);
    const saveCategory      = useTimeStore(s => s.saveTelegramCategory);
    const watchlist         = useTimeStore(s => s.telegramWatchlist);
    const fetchWatchlist    = useTimeStore(s => s.fetchTelegramWatchlist);
    const addWatchlistCoin  = useTimeStore(s => s.addTelegramWatchlistCoin);
    const updateWatchlistCoin = useTimeStore(s => s.updateTelegramWatchlistCoin);
    const removeWatchlistCoin = useTimeStore(s => s.removeTelegramWatchlistCoin);

    useEffect(() => {
        fetchCategories();
        fetchWatchlist();
    }, []);

    const existingTickers = useMemo(() => watchlist.map(c => c.ticker), [watchlist]);

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div className={styles.modal}>
                <div className={styles.modalHeader}>
                    <h3><Bell size={15} /> Telegram Alert Settings</h3>
                    <button onClick={onClose} className={styles.closeBtn}>✕ Close</button>
                </div>

                <div className={styles.tabRow}>
                    <button
                        className={`${styles.tabBtn} ${tab === 'categories' ? styles.tabBtnActive : ''}`}
                        onClick={() => setTab('categories')}
                    >
                        Categories
                    </button>
                    <button
                        className={`${styles.tabBtn} ${tab === 'coins' ? styles.tabBtnActive : ''}`}
                        onClick={() => setTab('coins')}
                    >
                        Coins of Interest
                    </button>
                </div>

                {tab === 'categories' && (
                    <div>
                        {Object.entries(categories).map(([key, { enabled, label }]) => (
                            <div key={key} className={styles.categoryRow}>
                                <span>{label}</span>
                                <Switch checked={enabled} onChange={(v) => saveCategory(key, v)} />
                            </div>
                        ))}
                        {Object.keys(categories).length === 0 && (
                            <div className={styles.emptyState}>Loading categories…</div>
                        )}
                    </div>
                )}

                {tab === 'coins' && (
                    <div>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4, marginBottom: 12 }}>
                            Hand-picked coins get alerts on a lower bar than the general noise thresholds —
                            in addition to any explicit Smart Alerts you've set up.
                        </p>

                        <CoinAutocomplete existingTickers={existingTickers} onAdd={addWatchlistCoin} />

                        {watchlist.length === 0 && (
                            <div className={styles.emptyState}>
                                <Star size={14} style={{ marginBottom: 4 }} /><br />
                                No coins of interest yet.
                            </div>
                        )}

                        {watchlist.map(coin => (
                            <div key={coin.ticker} className={styles.coinRow}>
                                <span className={styles.coinTicker}>{coin.ticker}</span>
                                <div className={styles.chipRow}>
                                    {COIN_CATEGORIES.map(c => (
                                        <button
                                            key={c.key}
                                            className={`${styles.chip} ${coin[c.key] ? styles.chipActive : ''}`}
                                            onClick={() => updateWatchlistCoin(coin.ticker, c.key, !coin[c.key])}
                                        >
                                            {c.label}
                                        </button>
                                    ))}
                                </div>
                                <button className={styles.removeBtn} onClick={() => removeWatchlistCoin(coin.ticker)}>
                                    <X size={14} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

export default TelegramSettingsModal;
