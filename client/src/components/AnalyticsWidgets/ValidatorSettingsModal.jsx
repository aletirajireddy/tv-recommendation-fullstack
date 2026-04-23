import React, { useState, useEffect } from 'react';
import styles from './ValidatorTimelineWidget.module.css';

const SETTINGS_META = [
    { key: 'validator.cooldown_minutes',         label: 'Cooldown (minutes)',              type: 'number', min: 5,   max: 60  },
    { key: 'validator.watch_window_minutes',      label: 'Watch window (minutes)',          type: 'number', min: 30,  max: 240 },
    { key: 'validator.win_threshold_30m_pct',     label: 'Win threshold % (30m)',           type: 'number', min: 0.1, max: 3,  step: 0.1 },
    { key: 'validator.early_check_enabled',       label: 'Early check enabled',             type: 'bool' },
    { key: 'validator.early_check_minutes',       label: 'Early check at (minutes)',        type: 'number', min: 5,   max: 30  },
    { key: 'validator.early_check_threshold_pct', label: 'Early check threshold %',         type: 'number', min: 0.1, max: 1,  step: 0.05 },
    { key: 'validator.reactive_zone_min_pct',     label: 'Reactive zone min %',             type: 'number', min: 0.1, max: 1,  step: 0.05 },
    { key: 'validator.reactive_zone_max_pct',     label: 'Reactive zone max %',             type: 'number', min: 0.2, max: 2,  step: 0.05 },
    { key: 'validator.telegram_phase2_enabled',   label: 'Telegram verdict alerts (live)',  type: 'bool' },
    { key: 'validator.telegram_early_check_enabled', label: 'Telegram early check alerts', type: 'bool' },
];

export function ValidatorSettingsModal({ onClose }) {
    const [values, setValues] = useState({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        fetch('/api/validator/settings')
            .then(r => r.json())
            .then(setValues)
            .catch(console.error);
    }, []);

    const handleChange = (key, value) => {
        setValues(v => ({ ...v, [key]: value }));
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await fetch('/api/validator/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            });
            setSaved(true);
            setTimeout(() => { setSaved(false); onClose(); }, 800);
        } catch (e) {
            console.error('Failed to save settings', e);
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div className={styles.csvModal} style={{ minWidth: 380 }}>
                <h4>⚙ Validator Settings</h4>
                <p style={{ fontSize: 11, color: '#718096', marginTop: -8, marginBottom: 16 }}>
                    Changes apply to new trials only. Existing in-flight trials keep their original config.
                </p>

                {SETTINGS_META.map(({ key, label, type, min, max, step }) => (
                    <div key={key} style={{ marginBottom: 12 }}>
                        <label>{label}</label>
                        {type === 'bool' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                <label className={styles.switch || 'switch'}>
                                    <input
                                        type="checkbox"
                                        checked={!!values[key]}
                                        onChange={e => handleChange(key, e.target.checked)}
                                    />
                                    <span style={{
                                        display: 'inline-block', width: 36, height: 20, background: values[key] ? 'rgba(72,187,120,0.4)' : 'rgba(255,255,255,0.1)',
                                        borderRadius: 10, position: 'relative', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.15)',
                                        transition: 'background 0.2s'
                                    }}>
                                        <span style={{
                                            position: 'absolute', top: 3, left: values[key] ? 17 : 3,
                                            width: 12, height: 12, borderRadius: '50%',
                                            background: values[key] ? '#68d391' : '#888',
                                            transition: 'left 0.2s'
                                        }} />
                                    </span>
                                    <span style={{ fontSize: 12, color: values[key] ? '#68d391' : '#718096', marginLeft: 8 }}>
                                        {values[key] ? 'ON' : 'OFF'}
                                    </span>
                                </label>
                            </div>
                        ) : (
                            <input
                                type="number"
                                min={min} max={max} step={step || 1}
                                value={values[key] ?? ''}
                                onChange={e => handleChange(key, parseFloat(e.target.value))}
                                style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', borderRadius: 6, padding: '8px', fontSize: 13, marginTop: 4 }}
                            />
                        )}
                    </div>
                ))}

                <div className={styles.csvModalActions} style={{ marginTop: 20 }}>
                    <button className={styles.btnSecondary} onClick={onClose}>Cancel</button>
                    <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Settings'}
                    </button>
                </div>
            </div>
        </>
    );
}
