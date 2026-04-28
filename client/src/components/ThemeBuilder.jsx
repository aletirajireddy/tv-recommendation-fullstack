import React, { useState } from 'react';
import { useThemeStore } from '../store/useThemeStore';

export const ThemeBuilder = ({ onClose }) => {
  const { themes, activeThemeId, themeMode, setThemeMode, setActiveThemeId, saveCustomTheme, deleteTheme } = useThemeStore();
  const activeTheme = themes[activeThemeId] || themes.modern;
  
  const [editMode, setEditMode] = useState(false);
  const [newThemeName, setNewThemeName] = useState('');
  // Local state for editing colors before saving
  const [editColors, setEditColors] = useState(activeTheme.colors[themeMode]);

  const handleColorChange = (key, value) => {
    setEditColors(prev => {
        const newColors = { ...prev, [key]: value };
        // Instantly preview by setting it on the document root
        document.documentElement.style.setProperty(key, value);
        return newColors;
    });
  };

  const handleSave = () => {
    if (!newThemeName.trim()) {
        alert('Please enter a theme name');
        return;
    }
    const id = newThemeName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    // We only edit the current mode (light or dark). We'll inherit the other mode from the base theme.
    const fullColors = {
        light: themeMode === 'light' ? editColors : activeTheme.colors.light,
        dark: themeMode === 'dark' ? editColors : activeTheme.colors.dark
    };
    
    saveCustomTheme(id, newThemeName, fullColors);
    setActiveThemeId(id);
    setEditMode(false);
    setNewThemeName('');
  };

  const handleCancel = () => {
      setEditMode(false);
      // Re-apply the active theme from the store to undo preview changes
      useThemeStore.getState().applyTheme();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-panel-light dark:bg-panel-dark border border-border-light dark:border-border-dark p-6 rounded-lg shadow-xl w-96 flex flex-col max-h-[90vh] overflow-hidden text-text-light dark:text-text-dark">
        
        <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">Theme Builder</h2>
            <button onClick={onClose} className="p-1 hover:bg-background-light dark:hover:bg-background-dark rounded text-text-muted-light dark:text-text-muted-dark">
                <span className="material-icons text-sm">close</span>
            </button>
        </div>

        <div className="space-y-4 overflow-y-auto pr-2 pb-4 scrollbar-hide">
            {/* MODE SWITCHER */}
            <div className="flex items-center justify-between p-3 bg-background-light dark:bg-background-dark rounded-md">
                <span className="text-sm font-bold">Mode</span>
                <div className="flex bg-panel-light dark:bg-panel-dark rounded border border-border-light dark:border-border-dark p-0.5">
                    <button 
                        onClick={() => setThemeMode('light')}
                        className={`px-3 py-1 text-xs font-bold rounded ${themeMode === 'light' ? 'bg-background-light dark:bg-background-dark shadow' : 'text-text-muted-light dark:text-text-muted-dark hover:text-text-light dark:hover:text-text-dark'}`}
                    >LIGHT</button>
                    <button 
                        onClick={() => setThemeMode('dark')}
                        className={`px-3 py-1 text-xs font-bold rounded ${themeMode === 'dark' ? 'bg-background-light dark:bg-background-dark shadow' : 'text-text-muted-light dark:text-text-muted-dark hover:text-text-light dark:hover:text-text-dark'}`}
                    >DARK</button>
                </div>
            </div>

            {/* THEME SELECTOR */}
            {!editMode && (
                <div className="space-y-2">
                    <label className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase">Active Palette</label>
                    <select 
                        value={activeThemeId}
                        onChange={(e) => setActiveThemeId(e.target.value)}
                        className="w-full bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-light dark:text-text-dark text-sm rounded p-2 focus:ring-1 focus:ring-accent-blue"
                    >
                        {Object.values(themes).map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>
                    
                    <div className="flex space-x-2 mt-2">
                        <button 
                            onClick={() => {
                                setEditColors(activeTheme.colors[themeMode]);
                                setEditMode(true);
                            }}
                            className="flex-1 bg-accent-blue text-white text-xs font-bold py-2 rounded hover:bg-blue-600 transition-colors"
                        >
                            CUSTOMIZE CURRENT
                        </button>
                        {activeThemeId !== 'modern' && activeThemeId !== 'legacy' && (
                             <button 
                             onClick={() => deleteTheme(activeThemeId)}
                             className="px-3 bg-accent-red/10 text-accent-red border border-accent-red/30 text-xs font-bold py-2 rounded hover:bg-accent-red/20 transition-colors"
                         >
                             DELETE
                         </button>
                        )}
                    </div>
                </div>
            )}

            {/* COLOR EDITOR */}
            {editMode && (
                <div className="space-y-4 animate-fade">
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase">New Theme Name</label>
                        <input 
                            type="text" 
                            placeholder="e.g. Midnight Synth"
                            value={newThemeName}
                            onChange={e => setNewThemeName(e.target.value)}
                            className="w-full bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-light dark:text-text-dark text-sm rounded p-2 focus:ring-1 focus:ring-accent-blue"
                        />
                    </div>

                    <div className="space-y-3">
                        <label className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase">Color Tokens ({themeMode})</label>
                        <div className="grid grid-cols-2 gap-3">
                            {Object.entries(editColors).map(([key, value]) => (
                                <div key={key} className="flex flex-col space-y-1">
                                    <span className="text-[10px] font-medium truncate">{key.replace('--', '')}</span>
                                    <div className="flex items-center space-x-2">
                                        <input 
                                            type="color" 
                                            value={value}
                                            onChange={(e) => handleColorChange(key, e.target.value)}
                                            className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                                        />
                                        <input 
                                            type="text" 
                                            value={value}
                                            onChange={(e) => handleColorChange(key, e.target.value)}
                                            className="w-full bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-light dark:text-text-dark text-[10px] rounded p-1 uppercase"
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex space-x-2 pt-2 border-t border-border-light dark:border-border-dark">
                        <button 
                            onClick={handleCancel}
                            className="flex-1 bg-background-light dark:bg-background-dark text-text-light dark:text-text-dark border border-border-light dark:border-border-dark text-xs font-bold py-2 rounded hover:bg-border-light dark:hover:bg-border-dark transition-colors"
                        >
                            CANCEL
                        </button>
                        <button 
                            onClick={handleSave}
                            className="flex-1 bg-accent-green text-white text-xs font-bold py-2 rounded hover:bg-green-600 transition-colors"
                        >
                            SAVE THEME
                        </button>
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  );
};
