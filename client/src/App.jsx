import React, { useEffect } from 'react';
import styles from './App.module.css';
import { GlobalHeader } from './components/GlobalHeader';
import { MacroHUD } from './components/MacroHUD';
import { ScanResults } from './components/ScanResults';
import { PulseFeed } from './components/PulseFeed';
import { AlertsAnalyzer } from './components/AnalyticsWidgets/AlertsAnalyzer';
import { ConfluenceGrid } from './components/AnalyticsWidgets/ConfluenceGrid';
import { MarketStructureWidget } from './components/AnalyticsWidgets/MarketStructureWidget';
import { AlphaScatter } from './components/AnalyticsWidgets/AlphaScatter';
import { TrendFlowChart } from './components/AnalyticsWidgets/TrendFlowChart';
import RecommendationsFeed from './components/AnalyticsWidgets/RecommendationsFeed';
import ScenarioBoard from './components/AnalyticsWidgets/ScenarioBoard';
import MarketSentimentTimeline from './components/AnalyticsWidgets/MarketSentimentTimeline';
import AlertFrequencyTimeline from './components/AnalyticsWidgets/AlertFrequencyTimeline';
import { ParticipationPulseWidget } from './components/AnalyticsWidgets/ParticipationPulseWidget';
import FusionDashboard from './components/AnalyticsWidgets/FusionDashboard';

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

        {/* UNIFIED TIMELINE VIEW */}
        <div className={styles.colAnalytics} style={{ padding: 0 }}>
        
            {/* ROW 1: TIMELINE ANALYZERS (Moved to the very top!) */}
            <div className={styles.analyticsSplitRow} style={{ marginBottom: '24px' }}>
                <MarketSentimentTimeline />
                <AlertFrequencyTimeline />
            </div>

            {/* ROW 2: FUSION DASHBOARD (Command Center) */}
            <div className={styles.analyticsFullRow} style={{ marginBottom: '24px' }}>
                <FusionDashboard />
            </div>

            {/* ROW 2: ENHANCED MACRO SUMMARY (Full Width) */}
            <div className={styles.analyticsFullRow}>
                <MarketStructureWidget />
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

            {/* ROW 4: SCOUT SCREENER (Participation Pulse moved to bottom) */}
            <div className={styles.analyticsFullRow} style={{ marginTop: '24px' }}>
                <ParticipationPulseWidget />
            </div>
        </div>

        {/* FLOATING CONTROLS (Always Visible in BOTH Modes) */}
        <FloatingTimeController />
        <FloatingMediaPlayer />
        <MonitorDetailModal />

      </main>
    </div>
  );
}

export default App;
