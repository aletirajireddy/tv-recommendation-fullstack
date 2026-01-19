import { create } from 'zustand';
import SocketService from '../services/SocketService';
import GenieSmart from '../services/GenieSmart';

const API_BASE = `http://${window.location.hostname}:3000/api`;

export const useTimeStore = create((set, get) => ({
    // 1. STATE
    timeline: [],
    currentIndex: -1,
    isLoading: false,
    isPlaying: false,
    activeScan: null,
    // socket: null, // Managed by SocketService
    lastSyncTime: null,
    notifications: [], // AI Log
    strategyLogs: [],  // TLogs (Telegram History)
    aiHistory: [],     // New History State
    analyticsData: null,
    researchData: null, // New Research Data
    viewMode: 'analytics', // 'monitor' | 'analytics' | 'research'
    telegramEnabled: true, // Method to Toggle Global Notifications
    lookbackHours: 720, // Default 30 days to capture all data
    isMonitorModalOpen: false, // New Modal State

    // NEW: Genie Smart State
    marketMood: { score: 0, label: 'LOADING', stats: { bullish: 0, bearish: 0, total: 0 } },

    // ABORT CONTROLLERS
    abortControllers: {
        loadScan: null,
        analytics: null,
        research: null
    },

    // 2. ACTIONS
    setTelegramEnabled: (enabled) => set({ telegramEnabled: enabled }),

    fetchAiHistory: async () => {
        try {
            const res = await fetch(`${API_BASE}/ai/history`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            // Defensive check
            set({ aiHistory: Array.isArray(data) ? data : [] });
        } catch (err) {
            console.error('Failed to fetch AI history:', err);
            set({ aiHistory: [] }); // Fallback
        }
    },

    toggleTelegram: async () => {
        try {
            const current = get().telegramEnabled;
            // Optimistic Update
            set({ telegramEnabled: !current });

            const res = await fetch(`${API_BASE}/settings/telegram`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !current })
            });
            const data = await res.json();
            // Confirm from Server
            if (data && typeof data.enabled !== 'undefined') {
                set({ telegramEnabled: data.enabled });
            }
        } catch (err) {
            console.error('Failed to toggle Telegram:', err);
            // Revert
            set({ telegramEnabled: !get().telegramEnabled });
        }
    },

    fetchTelegramStatus: async () => {
        try {
            const res = await fetch(`${API_BASE}/settings/telegram`);
            if (res.ok) {
                const data = await res.json();
                set({ telegramEnabled: !!data.enabled });
            }
        } catch (err) {
            console.error('Telegram status fetch failed:', err);
        }
    },

    initializeSocket: () => {
        // Use Singleton Service
        const socket = SocketService.connect();

        SocketService.on('scan-update', (newScanMeta) => {
            console.log('⚡ New Scan Received:', newScanMeta);
            const { timeline, currentIndex, loadScan, fetchAnalytics, fetchResearch, fetchNotifications } = get();

            const isLive = currentIndex === timeline.length - 1;
            const newTimeline = [...timeline, newScanMeta];

            set({
                timeline: newTimeline,
                lastSyncTime: new Date()
            });

            // Rule #8: Live Reactivity - Snap to latest if we were already live
            if (isLive) {
                set({ currentIndex: newTimeline.length - 1 });
                loadScan(newScanMeta.id); // This triggers GenieSmart calculation inside loadScan
            }

            // Refresh analytics on new data
            if (fetchAnalytics) fetchAnalytics();
            if (fetchResearch) fetchResearch();
            if (fetchNotifications) fetchNotifications();
            if (get().fetchStrategyLogs) get().fetchStrategyLogs(); // Refresh TLogs
        });

        // Handle Ledger Updates (The Picker)
        SocketService.on('ledger-update', (data) => {
            console.log('⚡ Picker Update:', data);
            // In V3, we might want to refresh a "Watchlist" component here
            // For now, simpler notification or just log
        });
    },

    fetchNotifications: async () => {
        try {
            const res = await fetch(`${API_BASE}/notifications?limit=100&_t=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            set({ notifications: Array.isArray(data) ? data : [] });
        } catch (err) {
            console.error('Failed to fetch notifications:', err);
            set({ notifications: [] });
        }
    },

    fetchStrategyLogs: async () => {
        try {
            const res = await fetch(`${API_BASE}/strategy/logs?limit=100&_t=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            set({ strategyLogs: Array.isArray(data) ? data : [] });
        } catch (err) {
            console.error('Failed to fetch TLogs:', err);
            set({ strategyLogs: [] });
        }
    },

    fetchAnalytics: async () => {
        // ... existing analytics fetch ...
        // Cancel previous request
        const { abortControllers } = get();
        if (abortControllers.analytics) abortControllers.analytics.abort();

        const controller = new AbortController();
        set({ abortControllers: { ...abortControllers, analytics: controller } });

        try {
            const { lookbackHours, activeScan, timeline, currentIndex } = get();

            // Determine Reference Time (Replay vs Live)
            let refTimeStr = '';
            if (activeScan && activeScan.timestamp) {
                refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
            } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
            }

            const res = await fetch(`${API_BASE}/analytics/pulse?hours=${lookbackHours}${refTimeStr}&_t=${Date.now()}`, {
                signal: controller.signal
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            set({ analyticsData: data });
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Analytics Error:', err);
            }
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
            const res = await fetch(`${API_BASE}/ai/history?hours=${hours}&_t=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // Fix: improperly handled error response (e.g. 500) causing data to be an error object instead of array
            const sorted = (Array.isArray(data) ? data : []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Calculate Max History Duration for Slider
            if (sorted.length > 0) {
                const first = new Date(sorted[0].timestamp);
                const last = new Date(); // now
                const diffHours = (last - first) / (1000 * 60 * 60);

                // Debugging Window Issue
                console.log(`[Timeline] Loaded ${sorted.length} scans. Span: ${diffHours.toFixed(2)} hours. Current Lookback: ${get().lookbackHours}`);
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
            set({ timeline: [] });
        }
    },

    loadScan: async (scanId) => {
        // Cancel previous
        const { abortControllers } = get();
        if (abortControllers.loadScan) abortControllers.loadScan.abort();

        const controller = new AbortController();
        set({
            isLoading: true,
            activeScan: null,
            abortControllers: { ...abortControllers, loadScan: controller }
        });

        try {
            // V3 API returns the raw JSON Blob
            // Note: API route is /api/scan/:id (added in index.js?) 
            // Check index.js: app.get('/api/scan/:id', ...) YES
            const res = await fetch(`http://${window.location.hostname}:3000/api/scan/${scanId}`, {
                signal: controller.signal
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // 🛠️ DATA NORMALIZATION: Flatten the V3 'data' nesting for Frontend consumption
            // This ensures widgets can access property directly (e.g. item.close) without checking item.data.close
            const normalizedResults = (data.results || []).map(item => {
                // If 'data' exists, merge it up. If not, assume it's already flat.
                if (item.data) {
                    return { ...item.data, ...item, data: undefined }; // Spread data first, then meta, remove identifier
                }
                return item;
            });

            // Update the payload
            const normalizedData = { ...data, results: normalizedResults };

            // 🧠 GENIE SMART: Derive Client-Side Intelligence
            const derivedMood = GenieSmart.analyzeMarketMood(normalizedResults);

            set({
                activeScan: normalizedData,
                marketMood: derivedMood, // <--- The New Source of Truth
                isLoading: false
            });

            // Sync Analytics & Research to new time context
            // Note: In V3, activeScan.timestamp is strictly UTC ISO
            get().fetchAnalytics();
            get().fetchResearch();
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Failed to load scan details:', err);
                set({ isLoading: false });
            }
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
        // Cancel previous request
        const { abortControllers } = get();
        if (abortControllers.research) abortControllers.research.abort();

        const controller = new AbortController();
        set({ abortControllers: { ...abortControllers, research: controller } });

        try {
            const { lookbackHours, activeScan, timeline, currentIndex } = get();
            console.log('[Research] Fetching data...', { currentIndex, hasActiveScan: !!activeScan, timelineLen: timeline.length });

            let refTimeStr = '';
            if (activeScan && activeScan.timestamp) {
                refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
            } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
            }

            const query = `${API_BASE}/analytics/research?hours=${lookbackHours || 24}${refTimeStr}&_t=${Date.now()}`;
            const res = await fetch(query, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            set({ researchData: data });
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Research API Error:', err);
                set({ researchData: null });
            }
        }
    },
}));
