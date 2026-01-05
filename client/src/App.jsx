import React from 'react';
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
import { FloatingTimeController } from './components/FloatingTimeController';
import { FloatingMediaPlayer } from './components/FloatingMediaPlayer';
import { MonitorDetailModal } from './components/MonitorDetailModal';
import { useTimeStore } from './store/useTimeStore';

function App() {
  const { viewMode } = useTimeStore();

  return (
    <div className={styles.appContainer}>
      <header className={styles.topBar}>
        <GlobalHeader />
      </header>

      <main className={styles.mainGrid}>

        <section className={styles.colAnalytics}>

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

          {/* FLOATING CONTROLS (Always Visible) */}
          <FloatingTimeController />
          <FloatingMediaPlayer />
          <MonitorDetailModal />
        </section>

      </main>
    </div>
  );
}

export default App;
