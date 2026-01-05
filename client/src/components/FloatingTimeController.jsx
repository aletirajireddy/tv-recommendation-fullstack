import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Clock, MousePointer2 } from 'lucide-react';
import styles from './FloatingTimeController.module.css';

export function FloatingTimeController() {
    const { lookbackHours, setLookbackHours, timeline } = useTimeStore();

    // Calculate Max Range dynamically based on history
    const maxRange = React.useMemo(() => {
        if (!timeline || timeline.length === 0) return 24;
        const first = new Date(timeline[0].timestamp);
        const last = new Date();
        const diff = (last - first) / (1000 * 60 * 60);
        return Math.ceil(diff + 2); // Buffer of 2 hours
    }, [timeline]);

    // Local state for smooth dragging
    const [localVal, setLocalVal] = React.useState(lookbackHours);

    React.useEffect(() => {
        setLocalVal(lookbackHours);
    }, [lookbackHours]);

    const handleChange = (e) => {
        setLocalVal(parseFloat(e.target.value));
    };

    const handleCommit = () => {
        setLookbackHours(localVal);
    };

    const toggleMax = () => {
        setLocalVal(maxRange);
        setLookbackHours(maxRange);
    };

    // --- DRAG LOGIC ---
    const [position, setPosition] = React.useState({ x: window.innerWidth - 60, y: window.innerHeight / 2 });
    const [isDragging, setIsDragging] = React.useState(false);
    const dragOffset = React.useRef({ x: 0, y: 0 });

    React.useEffect(() => {
        const savedPos = localStorage.getItem('timeControllerPos');
        if (savedPos) {
            setPosition(JSON.parse(savedPos));
        }
    }, []);

    const handleMouseDown = (e) => {
        // Only allow dragging from container background or label, not slider/button
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;

        setIsDragging(true);
        const rect = e.currentTarget.getBoundingClientRect();
        dragOffset.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    };

    React.useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            const newX = e.clientX - dragOffset.current.x;
            const newY = e.clientY - dragOffset.current.y;
            setPosition({ x: newX, y: newY });
        };

        const handleMouseUp = () => {
            if (isDragging) {
                setIsDragging(false);
                localStorage.setItem('timeControllerPos', JSON.stringify(position));
            }
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, position]);


    return (
        <div
            className={styles.container}
            style={{ left: position.x, top: position.y, cursor: isDragging ? 'grabbing' : 'grab' }}
            onMouseDown={handleMouseDown}
        >
            <div className={styles.labelGroup}>
                <Clock size={16} className={styles.icon} />
                <span className={styles.valueDisplay}>
                    {localVal.toFixed(1)}h
                </span>
                <span className={styles.label}>LOOKBACK</span>
            </div>

            <div className={styles.sliderTrack}>
                <input
                    type="range"
                    min="1"
                    max={maxRange}
                    step="0.5"
                    value={localVal}
                    orient="vertical" // Firefox
                    onChange={handleChange}
                    onMouseUp={handleCommit}
                    onTouchEnd={handleCommit}
                    className={styles.verticalSlider}
                />
            </div>

            <button className={styles.maxBtn} onClick={toggleMax} title="Show All History">
                MAX
            </button>
        </div>
    );
}
