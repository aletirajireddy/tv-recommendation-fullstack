import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useWidgetPrefs — single source of truth for per-widget localStorage prefs.
 *
 * Why a hook? Most widgets have ad-hoc patterns:
 *   const [foo, setFoo] = useState(loadPrefs().foo);
 *   useEffect(() => savePrefs({ foo }), [foo]);
 *
 * That's brittle (forgets keys, doesn't validate, no reset path). This hook
 * unifies it:
 *
 *   const [prefs, setPrefs, resetPrefs] = useWidgetPrefs('myWidget_prefs', {
 *       windowMin: 120,
 *       intervalMin: 2,
 *   });
 *
 *   // Update a single key (shallow merge):
 *   setPrefs({ windowMin: 60 });
 *
 *   // Reset to original defaults & clear localStorage:
 *   resetPrefs();
 *
 * Defaults are the SECOND arg — they ARE the schema. Unknown keys are stripped
 * on load so a stale localStorage entry from an old build can't poison state.
 */
export function useWidgetPrefs(storageKey, defaults) {
    const defaultsRef = useRef(defaults);

    const load = useCallback(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return { ...defaultsRef.current };
            const parsed = JSON.parse(raw);
            // Strip unknown keys, fall back to defaults for missing keys
            const cleaned = {};
            for (const k of Object.keys(defaultsRef.current)) {
                cleaned[k] = parsed[k] !== undefined ? parsed[k] : defaultsRef.current[k];
            }
            return cleaned;
        } catch {
            return { ...defaultsRef.current };
        }
    }, [storageKey]);

    const [prefs, _setPrefs] = useState(load);

    // Shallow-merge update
    const setPrefs = useCallback((patch) => {
        _setPrefs(prev => {
            const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
            try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
            return next;
        });
    }, [storageKey]);

    const resetPrefs = useCallback(() => {
        try { localStorage.removeItem(storageKey); } catch {}
        _setPrefs({ ...defaultsRef.current });
    }, [storageKey]);

    // Cross-tab sync: if another tab updates the same key, mirror the change
    useEffect(() => {
        const onStorage = (e) => {
            if (e.key !== storageKey) return;
            if (!e.newValue) { _setPrefs({ ...defaultsRef.current }); return; }
            try {
                const parsed = JSON.parse(e.newValue);
                const cleaned = {};
                for (const k of Object.keys(defaultsRef.current)) {
                    cleaned[k] = parsed[k] !== undefined ? parsed[k] : defaultsRef.current[k];
                }
                _setPrefs(cleaned);
            } catch {}
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [storageKey]);

    return [prefs, setPrefs, resetPrefs];
}

export default useWidgetPrefs;
