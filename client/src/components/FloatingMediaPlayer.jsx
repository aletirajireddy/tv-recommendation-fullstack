import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, Radio } from 'lucide-react';
import styles from './FloatingMediaPlayer.module.css';
import { format } from 'date-fns';

export function FloatingMediaPlayer() {
    const timeline = useTimeStore(s => s.timeline);
    const currentIndex = useTimeStore(s => s.currentIndex);
    const isPlaying = useTimeStore(s => s.isPlaying);
    const stepForward = useTimeStore(s => s.stepForward);
    const stepBack = useTimeStore(s => s.stepBack);
    const skipToStart = useTimeStore(s => s.skipToStart);
    const skipToEnd = useTimeStore(s => s.skipToEnd);
    const loadScan = useTimeStore(s => s.loadScan);
    const isLoading = useTimeStore(s => s.isLoading);

    // Local scrubber state for smooth dragging
    const [scrubVal, setScrubVal] = useState(currentIndex);

    useEffect(() => {
        setScrubVal(currentIndex);
    }, [currentIndex]);

    // --- PLAYBACK ENGINE (CLOSED-LOOP) ---
    useEffect(() => {
        let timeout;
        // Only trigger the next step if we are actively playing AND the current frame has finished loading
        if (isPlaying && !isLoading) {
            timeout = setTimeout(() => {
                const currentIdx = useTimeStore.getState().currentIndex;
                const timeLineLen = useTimeStore.getState().timeline.length;
                if (currentIdx < timeLineLen - 1) {
                    useTimeStore.getState().stepForward();
                } else {
                    // Reached the end, pause playback
                    useTimeStore.setState({ isPlaying: false });
                    // Fetch final analytics since we stopped naturally
                    useTimeStore.getState().fetchAnalytics();
                    useTimeStore.getState().fetchResearch();
                }
            }, 3000); // Wait 3 seconds AFTER the frame is fully loaded and rendered
        }
        return () => clearTimeout(timeout);
    }, [isPlaying, isLoading, currentIndex]);

    // --- KEYBOARD CONTROLS ---
    useEffect(() => {
        const handleKeyDown = (e) => {
            // Ignore if typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    const playingSpace = useTimeStore.getState().isPlaying;
                    useTimeStore.setState({ isPlaying: !playingSpace });
                    if (playingSpace) {
                        useTimeStore.getState().fetchAnalytics();
                        useTimeStore.getState().fetchResearch();
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    useTimeStore.getState().stepForward();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    useTimeStore.getState().stepBack();
                    break;
                case 'Home':
                    e.preventDefault();
                    useTimeStore.getState().skipToStart();
                    break;
                case 'End':
                    e.preventDefault();
                    useTimeStore.getState().skipToEnd();
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

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
        const currentlyPlaying = useTimeStore.getState().isPlaying;
        useTimeStore.setState({ isPlaying: !currentlyPlaying });
        if (currentlyPlaying) {
            // If it was playing and we just paused it, fetch final data
            useTimeStore.getState().fetchAnalytics();
            useTimeStore.getState().fetchResearch();
        }
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
