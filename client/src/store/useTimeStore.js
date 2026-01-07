import { create } from 'zustand';
import { io } from 'socket.io-client';

const API_BASE = 'http://localhost:3000/api';
const SOCKET_URL = 'http://localhost:3000';

export const useTimeStore = create((set, get) => ({
    // 1. STATE
    timeline: [],
    currentIndex: -1,
    isLoading: false,
    isPlaying: false,
    activeScan: null,
    socket: null,
    lastSyncTime: null,
    analyticsData: null,
    researchData: null, // New Research Data
    viewMode: 'analytics', // 'monitor' | 'analytics' | 'research'
    lookbackHours: 720, // Default 30 days to capture all data
    isMonitorModalOpen: false, // New Modal State

    // 2. ACTIONS
    initializeSocket: () => {
        if (get().socket) return;

        const socket = io(SOCKET_URL);

        socket.on('connect', () => {
            console.log('Socket Connected');
        });

        socket.on('new_scan', (newScanMeta) => {
            console.log('⚡ New Scan Received:', newScanMeta);
            const { timeline, currentIndex, loadScan, fetchAnalytics, fetchResearch } = get();

            const isLive = currentIndex === timeline.length - 1;
            const newTimeline = [...timeline, newScanMeta];

            set({
                timeline: newTimeline,
                lastSyncTime: new Date()
            });

            if (isLive) {
                set({ currentIndex: newTimeline.length - 1 });
                loadScan(newScanMeta.id);
            }

            // Refresh analytics on new data
            if (fetchAnalytics) fetchAnalytics();
            if (fetchResearch) fetchResearch();
        });

        set({ socket });
    },

    fetchAnalytics: async () => {
        try {
            const { lookbackHours, activeScan, timeline, currentIndex } = get();

            // Determine Reference Time (Replay vs Live)
            let refTimeStr = '';
            if (activeScan && activeScan.timestamp) {
                refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
            } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
            }

            const res = await fetch(`${API_BASE}/analytics/pulse?hours=${lookbackHours}${refTimeStr}`);
            const data = await res.json();
            set({ analyticsData: data });
        } catch (err) {
            console.error('Analytics Error:', err);
        }
    },

    refreshAll: async () => {
        console.log("Refreshing All Data...");
        await get().fetchTimeline();
        await get().fetchAnalytics();
        await get().fetchResearch();
        const { timeline, currentIndex } = get();
        if (timeline[currentIndex]) {
            await get().loadScan(timeline[currentIndex].id);
        }
    },

    fetchTimeline: async () => {
        try {
            const hours = get().lookbackHours || 24;
            const res = await fetch(`${API_BASE}/history?hours=${hours}`);
            const data = await res.json();

            // Fix: improperly handled error response (e.g. 500) causing data to be an error object instead of array
            const sorted = (Array.isArray(data) ? data : []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Calculate Max History Duration for Slider
            if (sorted.length > 0) {
                const first = new Date(sorted[0].timestamp);
                const last = new Date(); // now
                const diffHours = (last - first) / (1000 * 60 * 60);
                // Set default lookback to cover full history (with buffer)
                const maxHours = Math.ceil(diffHours + 1);

                // Only set default on first load (if lookback is high default)
                if (get().lookbackHours === 720) {
                    set({ lookbackHours: maxHours });
                }
            }

            set({
                timeline: sorted,
                currentIndex: get().currentIndex === -1 ? sorted.length - 1 : get().currentIndex,
                lastSyncTime: new Date()
            });

            // Force load the latest scan if nothing is active
            if (sorted.length > 0 && (!get().activeScan || get().currentIndex === -1)) {
                const targetIndex = sorted.length - 1;
                set({ currentIndex: targetIndex });
                get().loadScan(sorted[targetIndex].id);
            }

            // Initial Analytics Fetch
            get().fetchAnalytics();
            get().fetchResearch();

        } catch (err) {
            console.error('Failed to fetch timeline:', err);
        }
    },

    loadScan: async (scanId) => {
        set({ isLoading: true, activeScan: null });
        try {
            const res = await fetch(`${API_BASE}/scan/${scanId}`);
            const data = await res.json();
            set({
                activeScan: data,
                isLoading: false
            });

            // Sync Analytics & Research to new time context
            get().fetchAnalytics();
            get().fetchResearch();
        } catch (err) {
            console.error('Failed to load scan details:', err);
            set({ isLoading: false });
        }
    },

    stepForward: () => {
        const { timeline, currentIndex, loadScan } = get();
        if (currentIndex < timeline.length - 1) {
            const nextIndex = currentIndex + 1;
            set({ currentIndex: nextIndex });
            loadScan(timeline[nextIndex].id);
        } else {
            set({ isPlaying: false });
        }
    },

    stepBack: () => {
        const { timeline, currentIndex, loadScan } = get();
        if (currentIndex > 0) {
            const nextIndex = currentIndex - 1;
            set({ currentIndex: nextIndex });
            loadScan(timeline[nextIndex].id);
        }
    },

    skipToStart: () => {
        const { timeline, loadScan } = get();
        if (timeline && timeline.length > 0) {
            set({ currentIndex: 0 });
            loadScan(timeline[0].id);
        }
    },

    skipToEnd: () => {
        const { timeline, loadScan } = get();
        if (timeline && timeline.length > 0) {
            const lastIndex = timeline.length - 1;
            set({ currentIndex: lastIndex });
            loadScan(timeline[lastIndex].id);
        }
    },

    setViewMode: (mode) => set({ viewMode: mode }),
    setMonitorModalOpen: (isOpen) => set({ isMonitorModalOpen: isOpen }),


    setLookbackHours: (hours) => {
        set({ lookbackHours: hours });
        get().fetchAnalytics();
        get().fetchResearch();
    },

    fetchResearch: async () => {
        try {
            const { lookbackHours, activeScan, timeline, currentIndex } = get();
            console.log('[Research] Fetching data...', { currentIndex, hasActiveScan: !!activeScan, timelineLen: timeline.length });

            let refTimeStr = '';
            if (activeScan && activeScan.timestamp) {
                refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
            } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
            }

            const query = `${API_BASE}/analytics/research?hours=${lookbackHours || 24}${refTimeStr}`;
            const res = await fetch(query);
            const data = await res.json();
            set({ researchData: data });
        } catch (err) {
            console.error('Research API Error:', err);
        }
    },
}));
