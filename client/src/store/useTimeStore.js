import { create } from 'zustand';
import SocketService from '../services/SocketService';
import GenieSmart from '../services/GenieSmart';

const API_BASE = '/api';

let debounceTimerAnalytics = null;
let debounceTimerResearch = null;
let debounceTimerParticipation = null;
let debounceTimerAlpha = null;

// Track the scan timestamp for which analytics was last fetched.
// Analytics covers a lookback window (hours of aggregated data), so there is no
// value in re-fetching it when the replay position moves by only a few minutes.
// We only refetch when the scan time jumps by more than 30 minutes.
let _lastAnalyticsFetchMs = 0;
const ANALYTICS_TIME_DELTA_MS = 30 * 60 * 1000; // 30 min

// In-flight de-duplication guards.
// Module-scoped (not per-instance) because the store itself is a singleton.
// If a fetch is already in flight, callers receive the SAME promise — preventing
// React StrictMode double-invocation, multiple component subscribers, or rapid
// re-renders from issuing redundant requests for the same data.
const _inflight = {
    timeline:  null,
    health:    null,
    telegram:  null,
    analytics: null,
    research:  null,
};

// Throttle mechanism for UI invalidation
let lastPushTime = 0;
let pushTimeout = null;
const PUSH_THROTTLE_MS = 500;

const throttledDataPush = (set) => {
    const now = Date.now();
    if (now - lastPushTime > PUSH_THROTTLE_MS) {
        lastPushTime = now;
        set({ lastDataPush: now });
    } else {
        if (!pushTimeout) {
            pushTimeout = setTimeout(() => {
                lastPushTime = Date.now();
                set({ lastDataPush: lastPushTime });
                pushTimeout = null;
            }, PUSH_THROTTLE_MS - (now - lastPushTime));
        }
    }
};

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
    researchData: null, // New Research Data
    fusionData: null, // New Fusion Dashboard Data
    participationPulse: [], // Phase 8: Inflow/Outflow Participation Data
    alphaSquad: [], // Phase 14: Time-Series Delta Alpha Quadrant
    lastDataPush: 0, // Global invalidation signal — bumped on every socket push
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
                lastSyncTime: new Date()
            });
            throttledDataPush(set);

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
        SocketService.on('smart-level-update', (_data) => {
            const { timeline, currentIndex } = get();
            const isLive = currentIndex === timeline.length - 1;
            if (isLive) {
                get().fetchFusionData();
            }
            // bump global push signal so level/ema widgets pick up new smart-level data
            throttledDataPush(set);
        });

        // Handle Stream B Market Context Updates (Telemetry)
        SocketService.on('market-context-update', (_data) => {
            const { timeline, currentIndex } = get();
            const isLive = currentIndex === timeline.length - 1;
            if (isLive) {
                get().fetchParticipationPulse();
            }
            throttledDataPush(set);
        });

        // Handle Stream D volume/price pushes — EMA/Level/DistanceTracker widgets reload
        SocketService.on('stream-d-update', (_data) => {
            throttledDataPush(set);
        });

        // Handle validator state machine transitions (WATCHING→CONFIRMED/FAILED etc)
        SocketService.on('validator-update', (_data) => {
            throttledDataPush(set);
        });

        // Handle ghost queue mutations (approve / approve-all / toggle-auto)
        // GhostCoinWidget is viewport-wired to lastDataPush, so it reloads immediately.
        SocketService.on('ghost-update', (_data) => {
            throttledDataPush(set);
        });
    },



    fetchStrategyLogs: async () => {
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
    },

    fetchAnalytics: async () => {
        if (debounceTimerAnalytics) clearTimeout(debounceTimerAnalytics);
        await new Promise(r => { debounceTimerAnalytics = setTimeout(r, 300); });

        if (_inflight.analytics) return _inflight.analytics;
        _inflight.analytics = (async () => {
            const { abortControllers } = get();
            if (abortControllers.analytics) abortControllers.analytics.abort();
            const controller = new AbortController();
            set({ abortControllers: { ...abortControllers, analytics: controller } });
            try {
                const { lookbackHours, activeScan, timeline, currentIndex } = get();
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
                if (err.name !== 'AbortError') console.error('Analytics Error:', err);
            } finally {
                _inflight.analytics = null;
            }
        })();
        return _inflight.analytics;
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
                lastSyncTime: new Date()
            });

            // Force load the latest scan if nothing is active
            if (sorted.length > 0 && (!get().activeScan || get().currentIndex === -1)) {
                const targetIndex = sorted.length - 1;
                set({ currentIndex: targetIndex });
                get().loadScan(sorted[targetIndex].id);
            }
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

            // Sync Analytics & Research only when the scan time has moved by more than
            // 30 minutes since the last analytics fetch. Analytics covers a full lookback
            // window (hours of aggregated data) — re-fetching it for a 2-minute step
            // wastes bandwidth and blocks the main thread with a large JSON parse.
            if (!get().isPlaying) {
                const scanMs = new Date(normalizedData.timestamp).getTime();
                if (Math.abs(scanMs - _lastAnalyticsFetchMs) >= ANALYTICS_TIME_DELTA_MS) {
                    _lastAnalyticsFetchMs = scanMs;
                    setTimeout(() => {
                        get().fetchAnalytics();
                        get().fetchResearch();
                    }, 300);
                }
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
    },

    fetchResearch: async () => {
        if (debounceTimerResearch) clearTimeout(debounceTimerResearch);
        await new Promise(r => { debounceTimerResearch = setTimeout(r, 300); });

        if (_inflight.research) return _inflight.research;
        _inflight.research = (async () => {
            const { abortControllers } = get();
            if (abortControllers.research) abortControllers.research.abort();
            const controller = new AbortController();
            set({ abortControllers: { ...abortControllers, research: controller } });
            try {
                const { lookbackHours, activeScan, timeline, currentIndex } = get();
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
            } finally {
                _inflight.research = null;
            }
        })();
        return _inflight.research;
    },

    fetchFusionData: async () => {
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
                rsiDistribution: data.rsi_distribution || null
            });
        } catch (err) {
            console.error('Failed to fetch Fusion Dashboard data:', err);
            set({ fusionData: [] });
        }
    },

    fetchParticipationPulse: async () => {
        if (debounceTimerParticipation) clearTimeout(debounceTimerParticipation);
        return new Promise((resolve) => {
            debounceTimerParticipation = setTimeout(async () => {
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
                    set({ participationPulse: data.timeline || [] });
                } catch (err) {
                    console.error('Failed to fetch Participation Pulse data:', err);
                    set({ participationPulse: [] });
                }
                resolve();
            }, 300);
        });
    },

    fetchAlphaSquad: async () => {
        if (debounceTimerAlpha) clearTimeout(debounceTimerAlpha);
        return new Promise((resolve) => {
            debounceTimerAlpha = setTimeout(async () => {
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
                resolve();
            }, 300);
        });
    },
}));
