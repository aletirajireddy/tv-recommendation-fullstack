import React, { useEffect } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { Target, Layers, Activity, Ruler, Zap, Hexagon, Users, PanelLeftClose, PanelLeft, Brain, Bell, MonitorPlay } from 'lucide-react';
import styles from './Sidebar.module.css';

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

    // Each entry maps a nav id → its underlying widget chunk import.
    // On hover/focus we trigger the dynamic import so the chunk is warm
    // by the time the user actually navigates to it (zero-skeleton scroll).
    const menuItems = [
        { id: 'umpire',  label: '3rd Umpire',     icon: Target,  prefetch: () => import('./AnalyticsWidgets/ValidatorTimelineWidget') },
        { id: 'levels',  label: 'Levels Monitor', icon: Layers,  prefetch: () => import('./AnalyticsWidgets/LevelReactionWidget') },
        { id: 'cascade', label: 'EMA Cascade',    icon: Activity, prefetch: () => import('./AnalyticsWidgets/EMACascadeMonitor') },
        { id: 'dist',    label: 'Distance Board', icon: Ruler,   prefetch: () => import('./AnalyticsWidgets/DistanceTracker') },
        { id: 'alerts',  label: 'Smart Alerts',   icon: Bell,    prefetch: () => import('./AnalyticsWidgets/SmartAlertsWidget') },
        { id: 'alpha',   label: 'Alpha Squad',    icon: Zap,     prefetch: () => import('./AnalyticsWidgets/AlphaScatter') },
        { id: 'fusion',  label: 'Fusion Command', icon: Hexagon, prefetch: () => import('./AnalyticsWidgets/FusionDashboard') },
        { id: 'scout',   label: 'Participation',  icon: Users,   prefetch: () => import('./AnalyticsWidgets/ParticipationPulseWidget') },
    ];

    // Idempotent prefetch: webpack/vite cache the dynamic import promise,
    // so calling repeatedly costs nothing after the first.
    const prefetched = React.useRef(new Set());
    const handlePrefetch = (item) => {
        if (prefetched.current.has(item.id)) return;
        prefetched.current.add(item.id);
        try { item.prefetch?.(); } catch { /* ignore */ }
    };

    const scrollTo = (item) => {
        // Ensure chunk is requested before scroll begins (avoids skeleton flash)
        handlePrefetch(item);
        const el = document.getElementById(`section-${item.id}`);
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
                {menuItems.map(item => (
                    <button
                        key={item.id}
                        className={styles.navItem}
                        onClick={() => scrollTo(item)}
                        onMouseEnter={() => handlePrefetch(item)}
                        onFocus={() => handlePrefetch(item)}
                        title={item.label}
                    >
                        <span className={styles.icon}><item.icon size={16} strokeWidth={2.5} /></span>
                        {!collapsed && <span className={styles.label}>{item.label}</span>}
                    </button>
                ))}
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

                        <button 
                            className={`${styles.settingBtn} ${telegramEnabled ? styles.active : ''}`}
                            onClick={toggleTelegram}
                        >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Bell size={14} /> Telegram Alerts</span>
                            <span className={styles.status}>{telegramEnabled ? 'ON' : 'OFF'}</span>
                        </button>
                    </div>
                )}
                {!collapsed && <div className={styles.version}>v4.0.1 PRO</div>}
            </div>
        </aside>
        </>
    );
};
