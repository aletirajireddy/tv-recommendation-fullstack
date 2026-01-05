import React, { useEffect } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, Clock, Wifi } from 'lucide-react';
import styles from './GlobalHeader.module.css';
import { format, formatDistanceToNow } from 'date-fns';
import { HeaderStatsDeck } from './HeaderStatsDeck';

export function GlobalHeader() {
    const {
        timeline,
        currentIndex,
        isPlaying,
        activeScan,
        lastSyncTime,
        fetchTimeline,
        initializeSocket, // New Action
        stepForward,
        stepBack,
        loadScan,
        viewMode,
        setViewMode
    } = useTimeStore();

    // Initialize Data & Socket
    useEffect(() => {
        fetchTimeline();
        initializeSocket();
        // No interval needed for fetching anymore, socket handles it!
    }, []);

    // Handle Playback Interval
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

    if (timeline.length === 0) return <div className="card" style={{ padding: '1rem' }}>Loading Timeline...</div>;

    const isLive = currentIndex === timeline.length - 1;
    const currentScanMeta = timeline[currentIndex] || {};
    const scanTime = currentScanMeta.timestamp ? new Date(currentScanMeta.timestamp) : new Date();

    const startTime = timeline.length > 0 ? new Date(timeline[0].timestamp) : null;
    const endTime = timeline.length > 0 ? new Date(timeline[timeline.length - 1].timestamp) : null;

    return (
        <header className={styles.header}>
            <div className={styles.deckSection}>
                <HeaderStatsDeck />
            </div>
        </header>
    );
}
