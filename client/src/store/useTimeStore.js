import { create } from 'zustand';
import SocketService from '../services/SocketService';
import GenieSmart from '../services/GenieSmart';
import { globalApiQueue } from '../utils/RequestQueue';

const API_BASE = '/api';

// 500ms leading-edge throttle for lastDataPush.
// Collapses rapid socket bursts (scan+stream-d+validator firing together)
// into a single store write so widgets don't fire 3× HTTP requests at once.
let _lastPushMs = 0;
const _bumpDataPush = (set) => {
    const now = Date.now();
    if (now - _lastPushMs < 500) return;
    _lastPushMs = now;
    set({ lastDataPush: now });
};

// In-flight de-duplication guards.
// Module-scoped (not per-instance) because the store itself is a singleton.
// If a fetch is already in flight, callers receive the SAME promise — preventing
// React StrictMode double-invocation, multiple component subscribers, or rapid
// re-renders from issuing redundant requests for the same data.
const _inflight = {
    timeline: null,
    health:   null,
    telegram: null,
};

// Throttle guard for socket-triggered fetchFusionData calls.
// smart-level-update fires per-coin — on an active bar with 30 coins that's 30 rapid
// socket events. Without throttling, 30 concurrent fusion requests hit the server.
// Server now caches fusion for 10s, but we still skip redundant queue entries.
let _lastFusionSocketMs = 0;
const FUSION_SOCKET_THROTTLE_MS = 2_000; // at most one queued fetch per 2s from socket

export const useTimeStore = create((set, get) => ({
    // 1. STATE
    timeline: [],
    currentIndex: -1,
    isLoading: false,
    isPlaying: false,
    activeScan: null,
    // socket: null, // Managed by SocketService
    lastSyncTime: null,
    strategyLogs: [],  // TLogs (Telegram History)
    aiHistory: [],     // New History State
    analyticsData: null,
    analyticsDataFetchedAt: null,
    researchData: null, // New Research Data
    researchDataFetchedAt: null,
    fusionData: null, // New Fusion Dashboard Data
    fusionDataFetchedAt: null,
    participationPulse: [], // Phase 8: Inflow/Outflow Participation Data
    participationPulseFetchedAt: null,
    alphaSquad: [], // Phase 14: Time-Series Delta Alpha Quadrant
    cascadeHistory: [], // Phase 15: EMA Cascade Trends
    lastDataPush: 0, // Global invalidation signal — bumped on every socket push
    appReady: false,  // true after fetchTimeline first completes — gates eager-widget initial fetches
    viewMode: 'analytics', // 'monitor' | 'analytics' | 'research' | 'fusion'
    telegramEnabled: true, // Method to Toggle Global Notifications
    useSmartLevelsContext: true, // Enable AI Smart Levels Context
    lookbackHours: 720, // Default 30 days to capture all data
    isMonitorModalOpen: false, // New Modal State
    streamsHealth: null, // NEW: Tri-Stream Health
    selectedTicker: null, // Contextual ToolBox Target
    sidebarCollapsed: localStorage.getItem('tv_sidebarCollapsed') === 'true', // Layout state
    mobileMenuOpen: false, // New Mobile Layout state
    showPlayback: localStorage.getItem('tv_showPlayback') === null ? true : localStorage.getItem('tv_showPlayback') === 'true',
    coinMaskEnabled: localStorage.getItem('tv_coinMask') === 'true', // Global: show only current-scan coins

    // NEW: Genie Smart State
    marketMood: { score: 0, label: 'LOADING', stats: { bullish: 0, bearish: 0, total: 0 } },

    // ABORT CONTROLLERS
    abortControllers: {
        loadScan: null,
        analytics: null,
        research: null
    },

    // 2. ACTIONS
    setSelectedTicker: (ticker) => set({ selectedTicker: ticker }),
    setSidebarCollapsed: (collapsed) => {
        set({ sidebarCollapsed: collapsed });
        try { localStorage.setItem('tv_sidebarCollapsed', String(collapsed)); } catch {}
    },
    setMobileMenuOpen: (isOpen) => set({ mobileMenuOpen: isOpen }),
    setShowPlayback: (show) => {
        set({ showPlayback: !!show });
        localStorage.setItem('tv_showPlayback', String(!!show));
    },
    setTelegramEnabled: (enabled) => set({ telegramEnabled: enabled }),
    setCoinMaskEnabled: (enabled) => {
        set({ coinMaskEnabled: !!enabled });
        try { localStorage.setItem('tv_coinMask', String(!!enabled)); } catch {}
    },
    setSmartLevelsContext: (enabled) => {
        set({ useSmartLevelsContext: enabled });
        // Re-evaluate current scan to immediately apply changes
        const { activeScan, currentIndex, timeline, loadScan } = get();
        if (activeScan && timeline[currentIndex]) {
            loadScan(timeline[currentIndex].id);
        }
    },

    // NOTE: removed unused `fetchAiHistory` (was duplicate of fetchTimeline with no callers).
    // The same `/api/ai/history` endpoint is fetched by `fetchTimeline` below with
    // proper hours=720 parameter and timeline normalisation. Keeping a second action
    // that hits the same endpoint without parameters was dead code that risked
    // accidentally being wired up later as a third duplicate fetch.

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
            // Configrm from Server
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
        // De-dup: if a status fetch is already pending, return that promise.
        // Prevents StrictMode double-mount and the GlobalHeader effect from issuing
        // two parallel calls (this endpoint was 1.85s in trace; doing it twice was
        // pure waste). Server settings are also rarely-changing → reusing a 100ms-old
        // in-flight promise is always correct here.
        if (_inflight.telegram) return _inflight.telegram;
        _inflight.telegram = (async () => {
            try {
                const res = await fetch(`${API_BASE}/settings/telegram`);
                if (res.ok) {
                    const data = await res.json();
                    set({ telegramEnabled: !!data.enabled });
                }
            } catch (err) {
                console.error('Telegram status fetch failed:', err);
            } finally {
                _inflight.telegram = null;
            }
        })();
        return _inflight.telegram;
    },

    // ── Telegram category toggles + Coins of Interest ─────────────────────────
    telegramCategories: {},
    telegramWatchlist: [],

    fetchTelegramCategories: async () => {
        try {
            const res = await fetch(`${API_BASE}/telegram/settings`);
            if (res.ok) set({ telegramCategories: await res.json() });
        } catch (err) {
            console.error('Telegram categories fetch failed:', err);
        }
    },

    saveTelegramCategory: async (key, enabled) => {
        // Optimistic update
        set(s => ({ telegramCategories: { ...s.telegramCategories, [key]: { ...s.telegramCategories[key], enabled } } }));
        try {
            await fetch(`${API_BASE}/telegram/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: enabled }),
            });
        } catch (err) {
            console.error('Failed to save Telegram category:', err);
            get().fetchTelegramCategories(); // resync on failure
        }
    },

    fetchTelegramWatchlist: async () => {
        try {
            const res = await fetch(`${API_BASE}/telegram/watchlist`);
            if (res.ok) {
                const data = await res.json();
                set({ telegramWatchlist: data.coins || [] });
            }
        } catch (err) {
            console.error('Telegram watchlist fetch failed:', err);
        }
    },

    addTelegramWatchlistCoin: async (ticker) => {
        try {
            const res = await fetch(`${API_BASE}/telegram/watchlist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker }),
            });
            if (res.ok) await get().fetchTelegramWatchlist();
        } catch (err) {
            console.error('Failed to add watchlist coin:', err);
        }
    },

    updateTelegramWatchlistCoin: async (ticker, field, value) => {
        set(s => ({
            telegramWatchlist: s.telegramWatchlist.map(c => c.ticker === ticker ? { ...c, [field]: value ? 1 : 0 } : c),
        }));
        try {
            await fetch(`${API_BASE}/telegram/watchlist/${encodeURIComponent(ticker)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value }),
            });
        } catch (err) {
            console.error('Failed to update watchlist coin:', err);
            get().fetchTelegramWatchlist();
        }
    },

    removeTelegramWatchlistCoin: async (ticker) => {
        set(s => ({ telegramWatchlist: s.telegramWatchlist.filter(c => c.ticker !== ticker) }));
        try {
            await fetch(`${API_BASE}/telegram/watchlist/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
        } catch (err) {
            console.error('Failed to remove watchlist coin:', err);
            get().fetchTelegramWatchlist();
        }
    },

    fetchStreamsHealth: async () => {
        // De-dup: same rationale as fetchTelegramStatus. Stream health is also
        // server-cached for 30s now, so a duplicate call would just hit the cache —
        // but we still skip the network round trip entirely via this guard.
        if (_inflight.health) return _inflight.health;
        _inflight.health = (async () => {
            try {
                const res = await fetch(`${API_BASE}/system/health`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.success) {
                        set({ streamsHealth: data });
                    }
                }
            } catch (err) {
                console.error('Streams health fetch failed:', err);
            } finally {
                _inflight.health = null;
            }
        })();
        return _inflight.health;
    },

    initializeSocket: () => {
        // Use Singleton Service
        const socket = SocketService.connect();

        SocketService.on('scan-update', (newScanMeta) => {
            const { timeline, currentIndex, loadScan, fetchAnalytics, fetchResearch } = get();

            // isLive check allows us to buffer incoming data if the user is scrubbing historically
            const isLive = currentIndex === timeline.length - 1;
            const newTimeline = [...timeline, newScanMeta];

            set({
                timeline: newTimeline,
                lastSyncTime: new Date(),
                lastDataPush: Date.now(), // signal all widgets to refresh
            });

            // Rule #14 Guard: Live vs Replay
            if (isLive) {
                set({ currentIndex: newTimeline.length - 1 });
                loadScan(newScanMeta.id); // This triggers GenieSmart calculation and data fetching inside loadScan
            }

        });

        // Handle Ledger Updates (The Picker)
        SocketService.on('ledger-update', (_data) => {
            // reserved for future ledger reaction logic
        });

        // Handle Stream C Webhook Updates (Fusion Dashboard)
        // Throttle: smart-level-update fires per-coin so 30 coins = 30 events per bar.
        // We allow at most one fetchFusionData per FUSION_SOCKET_THROTTLE_MS via the queue.
        SocketService.on('smart-level-update', (_data) => {
            const { timeline, currentIndex } = get();
            const isLive = currentIndex === timeline.length - 1;
            if (isLive) {
                const now = Date.now();
                if (now - _lastFusionSocketMs >= FUSION_SOCKET_THROTTLE_MS) {
                    _lastFusionSocketMs = now;
                    get().fetchFusionData();
                }
            }
            _bumpDataPush(set);
        });

        // Handle Stream B Market Context Updates (Telemetry)
        SocketService.on('market-context-update', (_data) => {
            const { timeline, currentIndex } = get();
            const isLive = currentIndex === timeline.length - 1;
            if (isLive) {
                get().fetchParticipationPulse();
                get().fetchCascadeHistory();
            }
            _bumpDataPush(set);
        });

        // Handle Stream D volume/price pushes — EMA/Level/DistanceTracker widgets reload
        SocketService.on('stream-d-update', (_data) => {
            _bumpDataPush(set);
        });

        // Handle validator state machine transitions (WATCHING→CONFIRMED/FAILED etc)
        SocketService.on('validator-update', (_data) => {
            _bumpDataPush(set);
        });

        // Handle ghost queue mutations (approve / approve-all / toggle-auto)
        // GhostCoinWidget is viewport-wired to lastDataPush, so it reloads immediately.
        SocketService.on('ghost-update', (_data) => {
            _bumpDataPush(set);
        });
    },



    fetchStrategyLogs: async () => {
        return globalApiQueue.enqueue('fetchStrategyLogs', async () => {
        try {
            const { activeScan, timeline, currentIndex } = get();
            let refTimeStr = '';
            if (activeScan && activeScan.timestamp) {
                refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
            } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
            }

            const res = await fetch(`${API_BASE}/strategy/logs?limit=100${refTimeStr}&_t=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            set({ strategyLogs: Array.isArray(data) ? data : [] });
        } catch (err) {
            console.error('Failed to fetch TLogs:', err);
            set({ strategyLogs: [] });
        }
        }); // end globalApiQueue.enqueue
    },

    fetchAnalytics: async () => {
        return globalApiQueue.enqueue('fetchAnalytics', async () => {
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

                set({ analyticsData: data, analyticsDataFetchedAt: Date.now() });
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Analytics Error:', err);
                }
            }
        });
    },

    refreshAll: async () => {
        await get().fetchTimeline();
        await get().fetchAnalytics();
        await get().fetchResearch();
        await get().fetchAlphaSquad();
        const { timeline, currentIndex } = get();
        if (timeline[currentIndex]) {
            await get().loadScan(timeline[currentIndex].id);
        }
    },


    fetchTimeline: async () => {
        // De-dup guard: this is the LARGEST initial payload (~187KB / 30 days of scans).
        // Without this, React StrictMode in dev fetches it twice and so does any
        // accidental double-mount in prod. The endpoint is also pure read of
        // append-only data — a 200ms-old in-flight result is identical to a fresh one.
        if (_inflight.timeline) return _inflight.timeline;
        _inflight.timeline = (async () => {
        try {
            const hours = 720; // 30 Days fixed sandbox capacity
            // NOTE: removed the `_t=${Date.now()}` cache-buster. Express now sends
            // `Cache-Control: public, max-age=15` for hot endpoints, and the timeline
            // response is gzip-compressed. The cache-buster defeats both. We accept
            // up to 15s staleness on the slider — new scans push via socket anyway.
            const res = await fetch(`${API_BASE}/ai/history?hours=${hours}`);
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
                // [debug] console.log(`[Timeline] Loaded ${sorted.length} scans. Span: ${diffHours.toFixed(2)} hours.`);
            }

            set({
                timeline: sorted,
                currentIndex: get().currentIndex === -1 ? sorted.length - 1 : get().currentIndex,
                lastSyncTime: new Date(),
                appReady: true,  // ungate all eager widgets — timeline is loaded
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
        } finally {
            // Always release the in-flight slot, even on error, so the next call
            // (e.g. a manual refresh after a failure) can proceed.
            _inflight.timeline = null;
        }
        })();
        return _inflight.timeline;
    },

    loadScan: async (scanId) => {
        if (!scanId) return;
        // Cancel previous
        const { abortControllers } = get();
        if (abortControllers.loadScan) abortControllers.loadScan.abort();

        const controller = new AbortController();
        set({
            isLoading: true,
            abortControllers: { ...abortControllers, loadScan: controller }
        });

        try {
            // V3 API returns the raw JSON Blob
            // Note: API route is /api/scan/:id (added in index.js?) 
            // Check index.js: app.get('/api/scan/:id', ...) YES
            const res = await fetch(`/api/scan/${scanId}`, {
                signal: controller.signal
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // 🛠️ DATA NORMALIZATION: Flatten the V3 'data' nesting for Frontend consumption
            // This ensures widgets can access property directly (e.g. item.close) without checking item.data.close
            // 🛠️ DATA NORMALIZATION: Flatten the V3 'data' nesting for Frontend consumption
            // This ensures widgets can access property directly (e.g. item.close) without checking item.data.close
            const useSmartLevels = get().useSmartLevelsContext;
            const normalizedResults = (data.results || []).map(item => {
                // 1. Flatten Data
                // If 'data' exists, merge it up. If not, assume it's already flat.
                let flatItem = item.data ? { ...item.data, ...item, data: undefined } : { ...item };

                // 2. Genie Smart Override (Rule #1: Client-Side Scoring Truth)
                // We overwrite the static 'score', 'label', 'insights' with fresh logical values
                const smart = GenieSmart.calculateScore(flatItem, useSmartLevels);

                return {
                    ...flatItem,
                    ...smart, // Overwrites score, label, direction, insights
                    // Keep original properties that are not recalculated if needed, but 'smart' handles the core metrics
                };
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
            // Skip heavy queries if we are rapidly playing back frames
            if (!get().isPlaying) {
                get().fetchAnalytics();
                get().fetchResearch();
            }
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
            get().fetchAnalytics();
            get().fetchResearch();
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
        get().fetchParticipationPulse();
        get().fetchAlphaSquad();
        get().fetchCascadeHistory();
    },

    fetchResearch: async () => {
        return globalApiQueue.enqueue('fetchResearch', async () => {
            // Cancel previous request
            const { abortControllers } = get();
            if (abortControllers.research) abortControllers.research.abort();

            const controller = new AbortController();
            set({ abortControllers: { ...abortControllers, research: controller } });

            try {
                const { lookbackHours, activeScan, timeline, currentIndex } = get();
                // [debug] console.log('[Research] Fetching data...');

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
                set({ researchData: data, researchDataFetchedAt: Date.now() });
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Research API Error:', err);
                    set({ researchData: null });
                }
            }
        });
    },

    fetchFusionData: async () => {
        return globalApiQueue.enqueue('fetchFusionData', async () => {
            try {
                const { activeScan, timeline, currentIndex } = get();
                let refTimeStr = '';
                if (activeScan && activeScan.timestamp) {
                    refTimeStr = `?refTime=${encodeURIComponent(activeScan.timestamp)}`;
                } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                    refTimeStr = `?refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
                }

                const res = await fetch(`${API_BASE}/fusion/dashboard${refTimeStr}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                set({
                    fusionData: data.records || [],
                    rsiDistribution: data.rsi_distribution || null,
                    fusionDataFetchedAt: Date.now(),
                });
            } catch (err) {
                console.error('Failed to fetch Fusion Dashboard data:', err);
                set({ fusionData: [] });
            }
        });
    },

    fetchParticipationPulse: async () => {
        return globalApiQueue.enqueue('fetchParticipationPulse', async () => {
            try {
                const { lookbackHours, activeScan, timeline, currentIndex } = get();
                let refTimeStr = '';
                if (activeScan && activeScan.timestamp) {
                    refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
                } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                    refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
                }

                const res = await fetch(`${API_BASE}/analytics/participation-pulse?hours=${lookbackHours}${refTimeStr}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                set({ participationPulse: data.timeline || [], participationPulseFetchedAt: Date.now() });
            } catch (err) {
                console.error('Failed to fetch Participation Pulse data:', err);
                set({ participationPulse: [] });
            }
        });
    },

    fetchAlphaSquad: async () => {
        return globalApiQueue.enqueue('fetchAlphaSquad', async () => {
            try {
                const { lookbackHours, activeScan, timeline, currentIndex } = get();
                let refTimeStr = '';
                if (activeScan && activeScan.timestamp) {
                    refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
                } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                    refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
                }

                const res = await fetch(`${API_BASE}/analytics/alpha-squad?hours=${lookbackHours}${refTimeStr}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                set({ alphaSquad: Array.isArray(data) ? data : [] });
            } catch (err) {
                console.error('Failed to fetch Alpha Squad data:', err);
                set({ alphaSquad: [] });
            }
        });
    },

    fetchCascadeHistory: async () => {
        return globalApiQueue.enqueue('fetchCascadeHistory', async () => {
            try {
                const { lookbackHours, activeScan, timeline, currentIndex } = get();
                let refTimeStr = '';
                if (activeScan && activeScan.timestamp) {
                    refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
                } else if (timeline.length > 0 && currentIndex >= 0 && timeline[currentIndex]) {
                    refTimeStr = `&refTime=${encodeURIComponent(timeline[currentIndex].timestamp)}`;
                }

                const res = await fetch(`${API_BASE}/analytics/cascade-history?hours=${lookbackHours}${refTimeStr}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                set({ cascadeHistory: data.timeline || [] });
            } catch (err) {
                console.error('Failed to fetch Cascade History data:', err);
                set({ cascadeHistory: [] });
            }
        });
    },
}));
