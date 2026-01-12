import React, { useEffect } from 'react';
import styles from './App.module.css';
import { GlobalHeader } from './components/GlobalHeader';
import { MacroHUD } from './components/MacroHUD';
import { ScanResults } from './components/ScanResults';
import { PulseFeed } from './components/PulseFeed';
import { AlertsAnalyzer } from './components/AnalyticsWidgets/AlertsAnalyzer';
import { ConfluenceGrid } from './components/AnalyticsWidgets/ConfluenceGrid';
import { AlphaScatter } from './components/AnalyticsWidgets/AlphaScatter';
import { TrendFlowChart } from './components/AnalyticsWidgets/TrendFlowChart';
import RecommendationsFeed from './components/AnalyticsWidgets/RecommendationsFeed';
import ScenarioBoard from './components/AnalyticsWidgets/ScenarioBoard';
import { FloatingTimeController } from './components/FloatingTimeController';
import { FloatingMediaPlayer } from './components/FloatingMediaPlayer';
import { MonitorDetailModal } from './components/MonitorDetailModal';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { useTimeStore } from './store/useTimeStore';

function App() {
  const { viewMode } = useTimeStore();

  return (
    <div className={styles.appContainer}>
      <header className={styles.topBar}>
        <GlobalHeader />
      </header>

      <main className={styles.mainGridDefault}>

        {viewMode === 'research' ? (
          /* JET RESEARCH VIEW (Full Page) */
          <div className={styles.colAnalytics} style={{ padding: '0 24px' }}>
            <AnalyticsDashboard />

            {/* Floating controls still useful in research mode? Maybe. Leaving out for focus as per previous "Jet Mode" designs, or adding back if requested.
                    Actually, let's keep MonitorDetailModal available just in case.
                */}
          </div>
        ) : (
          /* DEFAULT TIMELINE VIEW */
          <div className={styles.colAnalytics} style={{ padding: 0 }}>

            {/* ALWAYS RENDER TIMELINE COMPONENTS */}
            <>
              {/* ROW 1: ENHANCED MACRO SUMMARY (Full Width) */}
              <div className={styles.analyticsFullRow}>
                <ConfluenceGrid />
              </div>



              {/* ROW 2: ALERTS & RECOMMENDATIONS */}
              <div className={styles.analyticsSplitRow}>
                <AlertsAnalyzer />
                <div style={{ height: '100%', minHeight: '300px' }}>
                  <RecommendationsFeed />
                </div>
              </div>

              {/* ROW 3: MOOD & ALPHA */}
              <div className={styles.analyticsSplitRow}>
                <TrendFlowChart />
                <AlphaScatter />
              </div>

              {/* ROW 4: SCENARIO PLANNING (War Room) */}
              <div className={styles.analyticsFullRow}>
                <ScenarioBoard />
              </div>
            </>
          </div>
        )}

        {/* FLOATING CONTROLS (Always Visible in BOTH Modes) */}
        <FloatingTimeController />
        <FloatingMediaPlayer />
        <MonitorDetailModal />

      </main>
    </div>
  );
}

export default App;
