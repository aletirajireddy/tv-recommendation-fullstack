import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, Clock, Wifi, LayoutDashboard, LineChart, Target, Menu, Palette, History } from 'lucide-react';
import styles from './GlobalHeader.module.css';
import { format, formatDistanceToNow } from 'date-fns';
import { HeaderStatsDeck } from './HeaderStatsDeck';

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

    // Initialize Data & Socket & Settings
    useEffect(() => {
        fetchTimeline();
        fetchTelegramStatus(); // Fetch Toggle State
        initializeSocket();

        // Start Tri-Stream Polling
        fetchStreamsHealth();
        const healthPoll = setInterval(() => {
            fetchStreamsHealth();
        }, 10000);
        return () => clearInterval(healthPoll);
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
                
                {/* THEME BUILDER TOGGLE */}
                <button 
                    onClick={onOpenThemeBuilder}
                    className="p-1.5 rounded hover:bg-bg-panel text-text-muted transition-colors border border-transparent hover:border-border ml-2 flex items-center justify-center"
                    title="Theme Builder"
                    style={{ background: 'transparent', cursor: 'pointer', padding: '6px' }}
                >
                    <Palette size={18} strokeWidth={2} />
                </button>
            </div>
        </header>
    );
}
