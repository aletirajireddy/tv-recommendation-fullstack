import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, Radio } from 'lucide-react';
import styles from './FloatingMediaPlayer.module.css';
import { format } from 'date-fns';

export function FloatingMediaPlayer() {
    const {
        timeline,
        currentIndex,
        isPlaying,
        stepForward,
        stepBack,
        loadScan,
        viewMode
    } = useTimeStore();

    // Local scrubber state for smooth dragging
    const [scrubVal, setScrubVal] = useState(currentIndex);

    useEffect(() => {
        setScrubVal(currentIndex);
    }, [currentIndex]);

    // Always show if timeline exists
    if (!timeline || timeline.length === 0) return null;

    const currentScan = timeline[currentIndex];
    const isLive = currentIndex === timeline.length - 1;
    const scanTime = currentScan ? new Date(currentScan.timestamp) : new Date();

    const handleScrubChange = (e) => {
        setScrubVal(parseInt(e.target.value));
    };

    const handleScrubCommit = (e) => {
        const idx = parseInt(e.target.value);
        useTimeStore.setState({ currentIndex: idx });
        if (timeline[idx]) {
            loadScan(timeline[idx].id);
        }
    };

    const togglePlay = () => {
        useTimeStore.setState({ isPlaying: !isPlaying });
    };

    return (
        <div className={styles.container}>
            {/* Top Row: Timestamp & Status */}
            <div className={styles.metaRow}>
                <div className={`${styles.statusBadge} ${isLive ? styles.live : styles.replay}`}>
                    {isLive ? <Radio size={10} className={styles.pulseIcon} /> : null}
                    {isLive ? 'LIVE' : 'REPLAY'}
                </div>
                <span className={styles.timeDisplay}>
                    {format(scanTime, 'HH:mm:ss')}
                </span>
            </div>

            {/* Bottom Row: Controls & Scrubber */}
            <div className={styles.controlsRow}>
                <div className={styles.buttons}>
                    <button onClick={stepBack} className={styles.ctlBtn} title="Previous Scan (Left Arrow)">
                        <SkipBack size={18} />
                    </button>

                    <button onClick={togglePlay} className={`${styles.ctlBtn} ${styles.playBtn}`} title="Play/Pause (Space)">
                        {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                    </button>

                    <button onClick={stepForward} className={styles.ctlBtn} title="Next Scan (Right Arrow)">
                        <SkipForward size={18} />
                    </button>
                </div>

                <div className={styles.scrubberContainer}>
                    <input
                        type="range"
                        min="0"
                        max={timeline.length - 1}
                        value={scrubVal}
                        onChange={handleScrubChange}
                        onMouseUp={handleScrubCommit}
                        onTouchEnd={handleScrubCommit}
                        className={styles.scrubber}
                    />
                </div>
            </div>
        </div>
    );
}
