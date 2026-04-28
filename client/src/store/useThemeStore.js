import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const defaultThemes = {
  modern: {
    id: 'modern',
    name: 'Next-Level Modern',
    colors: {
      light: {
        '--bg-app': '#F3F4F6',
        '--bg-panel': '#FFFFFF',
        '--border': '#E5E7EB',
        '--text-main': '#111827',
        '--text-muted': '#6B7280',
        '--primary': '#2D3047',
        '--accent-green': '#10B981',
        '--accent-red': '#EF4444',
        '--accent-blue': '#3B82F6',
        '--accent-orange': '#F59E0B'
      },
      dark: {
        '--bg-app': '#111827',
        '--bg-panel': '#1F2937',
        '--border': '#374151',
        '--text-main': '#F9FAFB',
        '--text-muted': '#9CA3AF',
        '--primary': '#2D3047',
        '--accent-green': '#10B981',
        '--accent-red': '#EF4444',
        '--accent-blue': '#3B82F6',
        '--accent-orange': '#F59E0B'
      }
    }
  },
  legacy: {
    id: 'legacy',
    name: 'Institutional Legacy',
    colors: {
      light: {
        '--bg-app': '#f7fafc',
        '--bg-panel': '#ffffff',
        '--border': '#e2e8f0',
        '--text-main': '#1a202c',
        '--text-muted': '#4a5568',
        '--primary': '#3182ce',
        '--accent-green': '#38a169',
        '--accent-red': '#e53e3e',
        '--accent-blue': '#3182ce',
        '--accent-orange': '#dd6b20'
      },
      dark: {
        '--bg-app': '#1a202c',
        '--bg-panel': '#2d3748',
        '--border': '#4a5568',
        '--text-main': '#f7fafc',
        '--text-muted': '#a0aec0',
        '--primary': '#63b3ed',
        '--accent-green': '#48bb78',
        '--accent-red': '#f56565',
        '--accent-blue': '#63b3ed',
        '--accent-orange': '#ed8936'
      }
    }
  }
};

export const useThemeStore = create(
  persist(
    (set, get) => ({
      themeMode: 'dark', // 'light' or 'dark'
      activeThemeId: 'modern',
      themes: defaultThemes,
      
      setThemeMode: (mode) => {
        set({ themeMode: mode });
        get().applyTheme();
      },
      
      setActiveThemeId: (id) => {
        if (get().themes[id]) {
          set({ activeThemeId: id });
          get().applyTheme();
        }
      },
      
      saveCustomTheme: (id, name, colors) => {
        set(state => ({
          themes: {
            ...state.themes,
            [id]: { id, name, colors }
          }
        }));
        get().applyTheme();
      },

      deleteTheme: (id) => {
          if (id === 'modern' || id === 'legacy') return;
          set(state => {
              const newThemes = { ...state.themes };
              delete newThemes[id];
              const newActiveId = state.activeThemeId === id ? 'modern' : state.activeThemeId;
              return { themes: newThemes, activeThemeId: newActiveId };
          });
          get().applyTheme();
      },
      
      applyTheme: () => {
        const { themeMode, activeThemeId, themes } = get();
        const root = document.documentElement;
        
        if (themeMode === 'dark') {
          root.classList.add('dark');
        } else {
          root.classList.remove('dark');
        }
        
        const activeTheme = themes[activeThemeId] || themes.modern;
        const colors = activeTheme.colors[themeMode] || activeTheme.colors.dark; // fallback
        
        Object.entries(colors).forEach(([key, value]) => {
          root.style.setProperty(key, value);
        });
      }
    }),
    {
      name: 'dashboard-theme-storage',
      onRehydrateStorage: () => (state) => {
        if (state) {
            setTimeout(() => state.applyTheme(), 0);
        }
      }
    }
  )
);
