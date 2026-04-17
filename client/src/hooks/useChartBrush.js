import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_WINDOW_SIZE = 60;

function loadState(storageKey) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed.isLive === 'boolean' &&
            typeof parsed.windowSize === 'number' &&
            typeof parsed.startIndex === 'number' &&
            typeof parsed.endIndex === 'number' &&
            parsed.startIndex >= 0 &&
            parsed.endIndex >= parsed.startIndex
        ) {
            return parsed;
        }
    } catch (_) {}
    return null;
}

function saveState(storageKey, state) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (_) {}
}

export function useChartBrush(storageKey, chartData) {
    const dataLength = chartData.length;

    const [brushRange, setBrushRange] = useState(() => {
        const saved = loadState(storageKey);
        if (saved) return saved;
        return { startIndex: 0, endIndex: 0, isLive: true, windowSize: DEFAULT_WINDOW_SIZE };
    });

    const brushRef = useRef(brushRange);
    brushRef.current = brushRange;

    const applyState = useCallback((state) => {
        setBrushRange(state);
        saveState(storageKey, state);
    }, [storageKey]);

    useEffect(() => {
        if (dataLength === 0) return;

        const cur = brushRef.current;
        const lastIdx = dataLength - 1;

        if (cur.isLive) {
            const winSize = cur.windowSize > 0 ? cur.windowSize : DEFAULT_WINDOW_SIZE;
            const newStart = Math.max(0, lastIdx - winSize + 1);
            const newEnd = lastIdx;

            if (cur.startIndex !== newStart || cur.endIndex !== newEnd) {
                applyState({ ...cur, startIndex: newStart, endIndex: newEnd });
            }
        } else {
            let clampedStart = Math.min(Math.max(0, cur.startIndex), lastIdx);
            let clampedEnd   = Math.min(Math.max(clampedStart, cur.endIndex), lastIdx);

            // Recharts Crash Prevention: If clamped window drops to 0 width, force it open
            if (clampedStart === clampedEnd && lastIdx > 0) {
                const winSize = cur.windowSize > 0 ? cur.windowSize : DEFAULT_WINDOW_SIZE;
                clampedStart = Math.max(0, clampedEnd - winSize + 1);
            }

            if (clampedStart !== cur.startIndex || clampedEnd !== cur.endIndex) {
                applyState({ ...cur, startIndex: clampedStart, endIndex: clampedEnd });
            }
        }
    }, [dataLength, applyState]);

    const handleBrushChange = useCallback((newRange) => {
        if (!newRange || newRange.startIndex === undefined || newRange.endIndex === undefined) return;

        const lastIdx = Math.max(0, dataLength - 1);
        const isAtEnd = newRange.endIndex >= lastIdx;
        const winSize = Math.max(1, newRange.endIndex - newRange.startIndex + 1);

        applyState({
            startIndex: newRange.startIndex,
            endIndex:   newRange.endIndex,
            isLive:     isAtEnd,
            windowSize: winSize,
        });
    }, [dataLength, applyState]);

    return { brushRange, handleBrushChange };
}
