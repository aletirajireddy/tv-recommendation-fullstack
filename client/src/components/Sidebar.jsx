import React, { useEffect } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import {
    Target, Layers, Activity, Ruler, Zap, Hexagon, Users,
    PanelLeftClose, PanelLeft, Brain, Bell, MonitorPlay,
    TrendingUp, BarChart2, Gauge, Heart, PieChart, Map,
    LayoutGrid, Search, Star, Calendar, Flame, Filter,
    GitCompareArrows, Settings, Radar,
} from 'lucide-react';
import styles from './Sidebar.module.css';
import { TelegramSettingsModal } from './TelegramSettingsModal';

export const Sidebar = () => {
    const collapsed = useTimeStore(s => s.sidebarCollapsed);
    const setCollapsed = useTimeStore(s => s.setSidebarCollapsed);
    const showPlayback = useTimeStore(s => s.showPlayback);
    const setShowPlayback = useTimeStore(s => s.setShowPlayback);
    const useSmartLevelsContext = useTimeStore(s => s.useSmartLevelsContext);
    const setSmartLevelsContext = useTimeStore(s => s.setSmartLevelsContext);
    const telegramEnabled = useTimeStore(s => s.telegramEnabled);
    const toggleTelegram = useTimeStore(s => s.toggleTelegram);
    const mobileMenuOpen = useTimeStore(s => s.mobileMenuOpen);
    const setMobileMenuOpen = useTimeStore(s => s.setMobileMenuOpen);
    const [telegramSettingsOpen, setTelegramSettingsOpen] = React.useState(false);

    // Body scroll lock when mobile drawer is open + ESC to close
    useEffect(() => {
        if (!mobileMenuOpen) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e) => { if (e.key === 'Escape') setMobileMenuOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = prev;
            window.removeEventListener('keydown', onKey);
        };
    }, [mobileMenuOpen, setMobileMenuOpen]);

    // Items listed in top-to-bottom page order. `divider: true` inserts a thin
    // rule between groups so the 18-item list stays scannable.
    const menuItems = [
        { id: 'byc',              label: 'BYOC Screener',    icon: Filter,     prefetch: () => import('./AnalyticsWidgets/BYCWidget') },
        { divider: true },
        { id: 'umpire',           label: '3rd Umpire',       icon: Target,     prefetch: () => import('./AnalyticsWidgets/ValidatorTimelineWidget') },
        { divider: true },
        // 2026-09-19: Levels Monitor temporarily disabled (diagnostic — checking
        // whether it's a meaningful contributor to backend load, since unlike
        // most widgets it uses an eager WidgetGate rather than viewport-lazy
        // LazyWidget, so it fetches /api/level-reactions on load regardless of
        // scroll position). Re-add this line to restore the sidebar entry —
        // the section is still in App.jsx, just commented out alongside it.
        // { id: 'levels',        label: 'Levels Monitor',   icon: Layers,     prefetch: () => import('./AnalyticsWidgets/LevelReactionWidget') },
        { id: 'cascade',          label: 'EMA Cascade',      icon: Activity,   prefetch: () => import('./AnalyticsWidgets/EMACascadeMonitor') },
        { id: 'cascade-trend',    label: 'Cascade Trend',    icon: Flame,      prefetch: () => import('./AnalyticsWidgets/CascadeTrendWidget').then(m => ({ default: m.CascadeTrendWidget })) },
        { id: 'scout',            label: 'Participation',    icon: Users,      prefetch: () => import('./AnalyticsWidgets/ParticipationPulseWidget') },
        { id: 'alpha',            label: 'Alpha Squad',      icon: Zap,        prefetch: () => import('./AnalyticsWidgets/AlphaScatter') },
        { id: 'dist',             label: 'Distance Board',   icon: Ruler,      prefetch: () => import('./AnalyticsWidgets/DistanceTracker') },
        { divider: true },
        { id: 'race',             label: 'Cascade Board',    icon: TrendingUp, prefetch: () => import('./AnalyticsWidgets/ATRRaceWidget') },
        { id: 'alerts',           label: 'Smart Alerts',     icon: Bell,       prefetch: () => import('./AnalyticsWidgets/SmartAlertsWidget') },
        { id: 'fusion',           label: 'Fusion Command',   icon: Hexagon,    prefetch: () => import('./AnalyticsWidgets/FusionDashboard') },
        { divider: true },
        { id: 'rsi-dist',         label: 'RSI Distribution', icon: PieChart,   prefetch: () => import('./AnalyticsWidgets/RSIDistributionWidget') },
        { id: 'market-structure', label: 'Market Structure', icon: Map,        prefetch: () => import('./AnalyticsWidgets/MarketStructureWidget') },
        { id: 'confluence',       label: 'Confluence Grid',  icon: LayoutGrid, prefetch: () => import('./AnalyticsWidgets/ConfluenceGrid') },
        { id: 'alerts-analyzer',  label: 'Alerts Analyzer',  icon: Search,     prefetch: () => import('./AnalyticsWidgets/AlertsAnalyzer') },
        { id: 'recommendations',  label: 'Recommendations',  icon: Star,       prefetch: () => import('./AnalyticsWidgets/RecommendationsFeed') },
        { divider: true },
        { id: 'rsi-grid',         label: 'RSI Grid Wall',    icon: BarChart2,  prefetch: () => import('./AnalyticsWidgets/RSIGridWall') },
        { id: 'momentum-pulse',   label: 'Momentum Pulse',   icon: Gauge,      prefetch: () => import('./AnalyticsWidgets/MomentumPulse') },
        { id: 'smart-mood',       label: 'Smart Mood',       icon: Heart,      prefetch: () => import('./AnalyticsWidgets/SmartMoodChart') },
        { id: 'sync-diag',        label: 'Stream Sync',      icon: GitCompareArrows, prefetch: () => import('./AnalyticsWidgets/StreamSyncDiagnostics') },
        { id: 'feed-health',      label: 'Feed Health',      icon: Radar,      prefetch: () => import('./AnalyticsWidgets/DataFeedHealthWidget') },
        { id: 'calendar',         label: 'Daily Calendar',   icon: Calendar,   prefetch: () => import('./AnalyticsWidgets/DailyCalendarWidget') },
    ];

    // Idempotent prefetch: webpack/vite cache the dynamic import promise,
    // so calling repeatedly costs nothing after the first. Returns that promise
    // (cached per item.id) so callers that need to know when the chunk is
    // actually ready — not just requested — can await it.
    // NOTE: a plain object, not `new Map()` — this file already imports `Map`
    // as a lucide-react icon component (used for the Market Structure item),
    // which shadows the global Map constructor and breaks `new Map()` in
    // production (minifier renamed the collision to `Map$5`, so it silently
    // resolved to the icon component instead of the built-in — confirmed live
    // via an unminified debug build after this crashed the whole app).
    const prefetchPromises = React.useRef({});
    const handlePrefetch = (item) => {
        const cache = prefetchPromises.current;
        if (item.id in cache) return cache[item.id];
        const p = Promise.resolve(item.prefetch?.()).catch(() => {});
        cache[item.id] = p;
        return p;
    };

    // 2026-09-18 fix — a real bug found via live browser testing: clicking a
    // sidebar item for a widget that hasn't been hover-prefetched yet (first
    // click after page load, keyboard/focus navigation, or fast clicking
    // before the mouseenter prefetch had time to land) found no
    // `section-{id}` element in the DOM yet — the widget's lazy chunk hadn't
    // resolved and mounted — so `if (el)` silently no-opped. Nothing scrolled,
    // no error, the sidebar item still visually highlighted as active. A
    // second click on the same item worked, because by then the import had
    // resolved. Fixed by awaiting the prefetch when the element isn't found
    // yet, then giving React two animation frames to complete the render
    // (import resolving and the component actually mounting are two separate
    // ticks) before retrying the lookup once.
    const scrollTo = async (item) => {
        let el = document.getElementById(`section-${item.id}`);
        if (!el) {
            await handlePrefetch(item);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            el = document.getElementById(`section-${item.id}`);
        }
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (mobileMenuOpen) setMobileMenuOpen(false); // auto close on mobile
    };

    return (
        <>
        {/* Mobile Backdrop */}
        {mobileMenuOpen && (
            <div className={styles.mobileBackdrop} onClick={() => setMobileMenuOpen(false)} />
        )}
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''} ${mobileMenuOpen ? styles.mobileOpen : ''}`}>
            <div className={styles.toggleRow}>
                <button className={styles.toggleBtn} onClick={() => setCollapsed(!collapsed)}>
                    {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
                </button>
            </div>
            
            <nav className={styles.nav}>
                {menuItems.map((item, i) => {
                    if (item.divider) {
                        return !collapsed
                            ? <div key={`div-${i}`} className={styles.navDivider} />
                            : <div key={`div-${i}`} className={styles.navDivider} style={{ margin: '4px 4px' }} />;
                    }
                    return (
                        <button
                            key={item.id}
                            className={styles.navItem}
                            onClick={() => scrollTo(item)}
                            onMouseEnter={() => handlePrefetch(item)}
                            onFocus={() => handlePrefetch(item)}
                            title={item.label}
                        >
                            <span className={styles.icon}><item.icon size={15} strokeWidth={2.2} /></span>
                            {!collapsed && <span className={styles.label}>{item.label}</span>}
                        </button>
                    );
                })}
            </nav>

            <div className={styles.footer}>
                {!collapsed && (
                    <div className={styles.settings}>
                        <label className={styles.toggleLabel}>
                            <input 
                                type="checkbox" 
                                checked={showPlayback} 
                                onChange={(e) => setShowPlayback(e.target.checked)}
                            />
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><MonitorPlay size={14} /> Playback HUD</span>
                        </label>

                        <div className={styles.divider} />

                        <button 
                            className={`${styles.settingBtn} ${useSmartLevelsContext ? styles.active : ''}`}
                            onClick={() => setSmartLevelsContext(!useSmartLevelsContext)}
                        >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Brain size={14} /> AI Intelligence</span>
                            <span className={styles.status}>{useSmartLevelsContext ? 'ON' : 'OFF'}</span>
                        </button>

                        <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                                className={`${styles.settingBtn} ${telegramEnabled ? styles.active : ''}`}
                                onClick={toggleTelegram}
                                style={{ flex: 1 }}
                            >
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Bell size={14} /> Telegram Alerts</span>
                                <span className={styles.status}>{telegramEnabled ? 'ON' : 'OFF'}</span>
                            </button>
                            <button
                                className={styles.settingBtn}
                                onClick={() => setTelegramSettingsOpen(true)}
                                title="Telegram alert categories & coins of interest"
                                style={{ flex: '0 0 auto', justifyContent: 'center', padding: '8px' }}
                            >
                                <Settings size={14} />
                            </button>
                        </div>
                    </div>
                )}
                {!collapsed && <div className={styles.version}>v4.0.1 PRO</div>}
            </div>
        </aside>
        {telegramSettingsOpen && <TelegramSettingsModal onClose={() => setTelegramSettingsOpen(false)} />}
        </>
    );
};
