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
    viewMode: 'analytics', // 'monitor' | 'analytics'
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
            const { timeline, currentIndex, loadScan, fetchAnalytics } = get();

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
        });

        set({ socket });
    },

    fetchAnalytics: async () => {
        try {
            const { lookbackHours } = get();
            const res = await fetch(`${API_BASE}/analytics/pulse?hours=${lookbackHours}`);
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
        const { timeline, currentIndex } = get();
        if (timeline[currentIndex]) {
            await get().loadScan(timeline[currentIndex].id);
        }
    },

    fetchTimeline: async () => {
        try {
            const res = await fetch(`${API_BASE}/history`);
            const data = await res.json();
            const sorted = (data || []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

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

    setViewMode: (mode) => set({ viewMode: mode }),
    setMonitorModalOpen: (isOpen) => set({ isMonitorModalOpen: isOpen }),

    setLookbackHours: (hours) => {
        set({ lookbackHours: hours });
        get().fetchAnalytics();
    },
}));
