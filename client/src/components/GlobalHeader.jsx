import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, Clock, Wifi, LayoutDashboard, LineChart, Target } from 'lucide-react';
import styles from './GlobalHeader.module.css';
import { format, formatDistanceToNow } from 'date-fns';
import { HeaderStatsDeck } from './HeaderStatsDeck';

export function GlobalHeader() {
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

    return (
        <header className={`${styles.header} ${isPulsing ? 'animate-header-flow' : ''}`}>
            <div className={styles.deckSection}>
                <HeaderStatsDeck />
            </div>

            <div className={styles.metaSection}>
                {/* VIEW MODE TOGGLE */}
                <div className={styles.modeSwitch}>
                    <button
                        className={useSmartLevelsContext ? styles.activeMode : styles.inactiveMode}
                        onClick={() => setSmartLevelsContext(!useSmartLevelsContext)}
                        title={useSmartLevelsContext ? "Smart Levels AI: ON" : "Smart Levels AI: OFF"}
                        style={{ marginRight: '8px' }}
                    >
                        {useSmartLevelsContext ? <span style={{ color: '#60a5fa' }}>🧠 AI: ON</span> : <span style={{ opacity: 0.5 }}>🧠 AI: OFF</span>}
                    </button>

                    <button
                        className={telegramEnabled ? styles.activeMode : styles.inactiveMode}
                        onClick={toggleTelegram}
                        title={telegramEnabled ? "Telegram: ON" : "Telegram: OFF"}
                        style={{ marginRight: '8px' }} // Spacing
                    >
                        {telegramEnabled ? <span style={{ color: '#4ade80' }}>🔔 ON</span> : <span style={{ opacity: 0.5 }}>🔕 OFF</span>}
                    </button>


                </div>
            </div>
        </header>
    );
}
