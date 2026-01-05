import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { ScanResults } from './ScanResults';
import { X, Maximize2 } from 'lucide-react';
import styles from './MonitorDetailModal.module.css';

export function MonitorDetailModal() {
    const { isMonitorModalOpen, setMonitorModalOpen, activeScan } = useTimeStore();

    if (!isMonitorModalOpen) return null;

    return (
        <div className={styles.overlay}>
            <div className={styles.backdrop} onClick={() => setMonitorModalOpen(false)} />

            <div className={styles.modalContent}>
                <div className={styles.header}>
                    <div className={styles.titleInfo}>
                        <Maximize2 size={18} color="var(--accent-primary)" />
                        <h2>MONITOR DETAIL VIEW</h2>
                        {activeScan && (
                            <span className={styles.scanId}>
                                ID: {activeScan.id}
                            </span>
                        )}
                    </div>
                    <button className={styles.closeBtn} onClick={() => setMonitorModalOpen(false)}>
                        <X size={24} />
                    </button>
                </div>

                <div className={styles.body}>
                    <ScanResults />
                </div>
            </div>
        </div>
    );
}
