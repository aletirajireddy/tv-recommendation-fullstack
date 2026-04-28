import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
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

    const menuItems = [
        { id: 'umpire',    label: '3rd Umpire', icon: '🎯' },
        { id: 'levels',    label: 'Levels Monitor', icon: '📏' },
        { id: 'cascade',   label: 'EMA Cascade', icon: '🪜' },
        { id: 'dist',      label: 'Distance Board', icon: '📏' },
        { id: 'alpha',     label: 'Alpha Squad', icon: '🎯' },
        { id: 'fusion',    label: 'Fusion Command', icon: '💠' },
        { id: 'scout',     label: 'Participation', icon: '📊' },
    ];

    const scrollTo = (id) => {
        const el = document.getElementById(`section-${id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
            <div className={styles.toggleRow}>
                <button className={styles.toggleBtn} onClick={() => setCollapsed(!collapsed)}>
                    {collapsed ? '→' : '←'}
                </button>
            </div>
            
            <nav className={styles.nav}>
                {menuItems.map(item => (
                    <button 
                        key={item.id} 
                        className={styles.navItem} 
                        onClick={() => scrollTo(item.id)}
                        title={item.label}
                    >
                        <span className={styles.icon}>{item.icon}</span>
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
                            <span>Playback HUD</span>
                        </label>

                        <div className={styles.divider} />

                        <button 
                            className={`${styles.settingBtn} ${useSmartLevelsContext ? styles.active : ''}`}
                            onClick={() => setSmartLevelsContext(!useSmartLevelsContext)}
                        >
                            <span>🧠 AI Intelligence</span>
                            <span className={styles.status}>{useSmartLevelsContext ? 'ON' : 'OFF'}</span>
                        </button>

                        <button 
                            className={`${styles.settingBtn} ${telegramEnabled ? styles.active : ''}`}
                            onClick={toggleTelegram}
                        >
                            <span>🔔 Telegram Alerts</span>
                            <span className={styles.status}>{telegramEnabled ? 'ON' : 'OFF'}</span>
                        </button>
                    </div>
                )}
                {!collapsed && <div className={styles.version}>v4.0.1 PRO</div>}
            </div>
        </aside>
    );
};
