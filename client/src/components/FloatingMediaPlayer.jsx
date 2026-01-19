import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, Radio } from 'lucide-react';
import styles from './FloatingMediaPlayer.module.css';
import { format } from 'date-fns';

export function FloatingMediaPlayer() {
    const {
        timeline,
        currentIndex,
        isPlaying,
        stepForward,
        stepBack,
        skipToStart,
        skipToEnd,
        loadScan,
    } = useTimeStore();

    // Local scrubber state for smooth dragging
    const [scrubVal, setScrubVal] = useState(currentIndex);

    useEffect(() => {
        setScrubVal(currentIndex);
    }, [currentIndex]);

    // --- DRAG LOGIC ---
    // Default position: Bottom Right (fixed fallback)
    const [position, setPosition] = useState({ x: window.innerWidth - 300, y: window.innerHeight - 100 });
    const [isDragging, setIsDragging] = useState(false);
    const dragOffset = React.useRef({ x: 0, y: 0 });

    useEffect(() => {
        const savedPos = localStorage.getItem('mediaPlayerPos');
        if (savedPos) {
            try {
                setPosition(JSON.parse(savedPos));
            } catch (e) {
                console.error("Failed to parse media player pos", e);
            }
        }
    }, []);

    const handleMouseDown = (e) => {
        // Only allow dragging from container background or non-interactive areas
        if (['BUTTON', 'INPUT', 'svg', 'path'].includes(e.target.tagName)) return;

        setIsDragging(true);
        const rect = e.currentTarget.getBoundingClientRect();
        dragOffset.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    };

    const handleTouchStart = (e) => {
        if (['BUTTON', 'INPUT', 'svg', 'path'].includes(e.target.tagName)) return;
        // Prevent default to stop scrolling while dragging
        // e.preventDefault(); // Optional: might block scrolling if user misses button

        setIsDragging(true);
        const rect = e.currentTarget.getBoundingClientRect();
        const touch = e.touches[0];
        dragOffset.current = {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top
        };
    };

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            const newX = e.clientX - dragOffset.current.x;
            const newY = e.clientY - dragOffset.current.y;
            setPosition({ x: newX, y: newY });
        };

        const handleTouchMove = (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            const newX = touch.clientX - dragOffset.current.x;
            const newY = touch.clientY - dragOffset.current.y;
            setPosition({ x: newX, y: newY });
        };

        const handleMouseUp = () => {
            if (isDragging) {
                setIsDragging(false);
                localStorage.setItem('mediaPlayerPos', JSON.stringify(position));
            }
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            window.addEventListener('touchmove', handleTouchMove);
            window.addEventListener('touchend', handleMouseUp); // Re-use mouseup logic
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('touchmove', handleTouchMove);
            window.removeEventListener('touchend', handleMouseUp);
        };
    }, [isDragging, position]);


    // Always show if timeline exists
    if (!timeline || timeline.length === 0) return null;

    const currentScan = timeline[currentIndex];
    const isLive = currentIndex === timeline.length - 1;

    let scanTime = new Date();
    try {
        if (currentScan && currentScan.timestamp) {
            const parsed = new Date(currentScan.timestamp);
            if (!isNaN(parsed.getTime())) {
                scanTime = parsed;
            }
        }
    } catch (e) {
        // Fallback to now
    }

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
        <div
            className={styles.container}
            style={{
                left: position.x,
                top: position.y,
                bottom: 'auto',
                right: 'auto',
                cursor: isDragging ? 'grabbing' : 'grab'
            }}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
        >
            {/* Top Row: Timestamp & Status */}
            <div className={styles.metaRow}>
                <div className={`${styles.statusBadge} ${isLive ? styles.live : styles.replay}`}>
                    {isLive ? <Radio size={10} className={styles.pulseIcon} /> : null}
                    {isLive ? 'LIVE' : 'REPLAY'}
                </div>
                <span className={styles.timeDisplay}>
                    {format(scanTime, 'MM/dd HH:mm:ss')}
                </span>
            </div>

            {/* Bottom Row: Controls & Scrubber */}
            <div className={styles.controlsRow}>
                <div className={styles.buttons}>
                    {/* Jump to Start */}
                    <button onClick={skipToStart} className={styles.ctlBtn} title="Jump to Start (Oldest)">
                        <ChevronsLeft size={18} />
                    </button>

                    <button onClick={stepBack} className={styles.ctlBtn} title="Previous Scan (Left Arrow)">
                        <SkipBack size={18} />
                    </button>

                    <button onClick={togglePlay} className={`${styles.ctlBtn} ${styles.playBtn}`} title="Play/Pause (Space)">
                        {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                    </button>

                    <button onClick={stepForward} className={styles.ctlBtn} title="Next Scan (Right Arrow)">
                        <SkipForward size={18} />
                    </button>

                    {/* Jump to End */}
                    <button onClick={skipToEnd} className={styles.ctlBtn} title="Jump to End (Newest)">
                        <ChevronsRight size={18} />
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
