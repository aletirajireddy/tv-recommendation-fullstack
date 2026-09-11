import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, Clock, Wifi, LayoutDashboard, LineChart, Target, Menu, Palette, History, Eye, EyeOff } from 'lucide-react';
import styles from './GlobalHeader.module.css';
import { format, formatDistanceToNow } from 'date-fns';
import { HeaderStatsDeck } from './HeaderStatsDeck';
import { SmartAlertsBell } from './SmartAlerts/SmartAlertsBell';

export function GlobalHeader({ onOpenThemeBuilder }) {
    const timeline = useTimeStore(s => s.timeline);
    const currentIndex = useTimeStore(s => s.currentIndex);
    const isPlaying = useTimeStore(s => s.isPlaying);
    const activeScan = useTimeStore(s => s.activeScan);
    const lastSyncTime = useTimeStore(s => s.lastSyncTime);
    const fetchTimeline = useTimeStore(s => s.fetchTimeline);
    const initializeSocket = useTimeStore(s => s.initializeSocket);
    const stepForward = useTimeStore(s => s.stepForward);
    const stepBack = useTimeStore(s => s.stepBack);
    const loadScan = useTimeStore(s => s.loadScan);
    const viewMode = useTimeStore(s => s.viewMode);
    const setViewMode = useTimeStore(s => s.setViewMode);
    const telegramEnabled = useTimeStore(s => s.telegramEnabled);
    const toggleTelegram = useTimeStore(s => s.toggleTelegram);
    const fetchTelegramStatus = useTimeStore(s => s.fetchTelegramStatus);
    const useSmartLevelsContext = useTimeStore(s => s.useSmartLevelsContext);
    const setSmartLevelsContext = useTimeStore(s => s.setSmartLevelsContext);
    const fetchStreamsHealth = useTimeStore(s => s.fetchStreamsHealth);
    const mobileMenuOpen = useTimeStore(s => s.mobileMenuOpen);
    const setMobileMenuOpen = useTimeStore(s => s.setMobileMenuOpen);
    const coinMaskEnabled = useTimeStore(s => s.coinMaskEnabled);
    const setCoinMaskEnabled = useTimeStore(s => s.setCoinMaskEnabled);

    // ── Serialised boot sequence ────────────────────────────────────────────────
    // PROBLEM: firing fetchTimeline + 4 widget fetches + socket all at T=0
    // hammers the backend with 10+ parallel SQLite queries before Node's event
    // loop can breathe — this is what causes the "header chart freezing" delay.
    //
    // SOLUTION: priority order with micro-delays so the DB processes one heavy
    // query at a time:
    //   Phase 1 (T=0):   socket handshake + lightweight health check
    //   Phase 2 (T=50ms): heavy timeline fetch (sets appReady → unblocks eager widgets)
    //   Phase 3 (T=400ms): telegram status (least critical, can wait)
    //
    // Each phase is separated by enough time for the previous async call to
    // reach the backend and start its DB query before the next one arrives.
    useEffect(() => {
        // Phase 1 — connect socket + fast health endpoint (no DB query, cached 30s)
        initializeSocket();
        fetchStreamsHealth();

        // Phase 2 — heavy timeline fetch; 50ms yield lets browser paint first frame
        const t1 = setTimeout(() => fetchTimeline(), 50);

        // Phase 3 — telegram toggle state; non-blocking, low priority
        const t2 = setTimeout(() => fetchTelegramStatus(), 400);

        // Health poll — 30s is fine; status ages are shown in minutes so
        // 10s precision adds no value and generates 6 extra HTTP calls/min through
        // Tailscale / remote tunnels unnecessarily.
        const healthPoll = setInterval(() => fetchStreamsHealth(), 30_000);

        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            clearInterval(healthPoll);
        };
    }, []);

    // Animation Pulse Trigger for Header
    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (activeScan) {
            setIsPulsing(false);
            const trigger = setTimeout(() => setIsPulsing(true), 10);
            const timer = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(trigger); clearTimeout(timer); };
        }
    }, [activeScan?.id]);

    // ... existing playback effect ...
    useEffect(() => {
        let interval;
        if (isPlaying) {
            interval = setInterval(() => {
                stepForward();
            }, 1000);
        }
        return () => clearInterval(interval);
    }, [isPlaying]);

    const handleScrub = (e) => {
        const idx = parseInt(e.target.value);
        const scan = timeline[idx];
        if (scan) {
            useTimeStore.setState({ currentIndex: idx });
            loadScan(scan.id);
        }
    };

    // Empty State Handling
    if (timeline.length === 0) {
        return (
            <div className="card" style={{ padding: '1rem', textAlign: 'center', opacity: 0.8 }}>
                <Clock className={styles.icon} size={16} style={{ marginRight: 8, display: 'inline', verticalAlign: 'middle' }} />
                <span>System Ready - Waiting for Scanner Data...</span>
            </div>
        );
    }

    // ... existing rendering logic ...

    const isLive = timeline.length > 0 && currentIndex === timeline.length - 1;

    return (
        <header className={`${styles.header} ${isPulsing ? 'animate-header-flow' : ''}`}>
            <div className={styles.deckSection}>
                <button 
                    className={styles.hamburgerBtn}
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    aria-label="Toggle Menu"
                >
                    <Menu size={20} />
                </button>
                <HeaderStatsDeck />
            </div>

            <div className={styles.metaSection}>
                {/* STATUS INDICATOR */}
                <div className={isLive ? styles.activeStatus : styles.inactiveStatus} title={isLive ? "STREAM ACTIVE" : "REPLAY MODE"}>
                    {isLive ? (
                        <Wifi size={18} className={styles.pulseIcon} color="var(--accent-green)" />
                    ) : (
                        <History size={18} color="var(--accent-orange)" />
                    )}
                </div>
                
                {/* SMART ALERTS BELL — badge-counted dropdown */}
                <SmartAlertsBell />

                {/* THEME BUILDER TOGGLE */}
                <button
                    onClick={onOpenThemeBuilder}
                    className="p-1.5 rounded hover:bg-bg-panel text-text-muted transition-colors border border-transparent hover:border-border ml-2 flex items-center justify-center"
                    title="Theme Builder"
                    style={{ background: 'transparent', cursor: 'pointer', padding: '6px' }}
                >
                    <Palette size={18} strokeWidth={2} />
                </button>

                {/* ACTIVE COIN MASK — filters per-coin widgets to the current scan's tickers */}
                <button
                    onClick={() => setCoinMaskEnabled(!coinMaskEnabled)}
                    className="p-1.5 rounded hover:bg-bg-panel transition-colors border border-transparent hover:border-border flex items-center justify-center"
                    title={coinMaskEnabled ? 'Showing only active-scan coins — click to show all' : 'Showing all coins — click to mask to active-scan only'}
                    style={{ background: 'transparent', cursor: 'pointer', padding: '6px' }}
                >
                    {coinMaskEnabled
                        ? <EyeOff size={18} strokeWidth={2} color="var(--accent-blue)" />
                        : <Eye size={18} strokeWidth={2} className="text-text-muted" />}
                </button>
            </div>
        </header>
    );
}
