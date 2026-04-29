import React, { useEffect, useState } from 'react';
import styles from './App.module.css';
import { GlobalHeader } from './components/GlobalHeader';
import { Sidebar } from './components/Sidebar';
import { SelectionDrawer } from './components/SelectionDrawer';
import { ValidatorTimelineWidget } from './components/AnalyticsWidgets/ValidatorTimelineWidget';
import { DailyCalendarWidget } from './components/AnalyticsWidgets/DailyCalendarWidget';
import { LevelReactionWidget } from './components/AnalyticsWidgets/LevelReactionWidget';
import { EMACascadeMonitor } from './components/AnalyticsWidgets/EMACascadeMonitor';
import { DistanceTracker } from './components/AnalyticsWidgets/DistanceTracker';
import { MarketSentimentTimeline } from './components/AnalyticsWidgets/MarketSentimentTimeline';
import { AlertFrequencyTimeline } from './components/AnalyticsWidgets/AlertFrequencyTimeline';
import FusionDashboard from './components/AnalyticsWidgets/FusionDashboard';
import RSIDistributionWidget from './components/AnalyticsWidgets/RSIDistributionWidget';
import { MarketStructureWidget } from './components/AnalyticsWidgets/MarketStructureWidget';
import { ConfluenceGrid } from './components/AnalyticsWidgets/ConfluenceGrid';
import { AlertsAnalyzer } from './components/AnalyticsWidgets/AlertsAnalyzer';
import RecommendationsFeed from './components/AnalyticsWidgets/RecommendationsFeed';
import { ParticipationPulseWidget } from './components/AnalyticsWidgets/ParticipationPulseWidget';
import { CoinAgeWidget } from './components/AnalyticsWidgets/CoinAgeWidget';
import { GhostCoinWidget } from './components/AnalyticsWidgets/GhostCoinWidget';
import { AlphaScatter } from './components/AnalyticsWidgets/AlphaScatter';
import { FloatingTimeController } from './components/FloatingTimeController';
import { FloatingMediaPlayer } from './components/FloatingMediaPlayer';
import { MonitorDetailModal } from './components/MonitorDetailModal';
import { useTimeStore } from './store/useTimeStore';
import { ThemeBuilder } from './components/ThemeBuilder';
import { Target } from 'lucide-react';

function App() {
  const isLive = useTimeStore(s => s.timeline.length > 0 ? s.currentIndex === s.timeline.length - 1 : false);
  const showPlayback = useTimeStore(s => s.showPlayback);
  const alphaSquad = useTimeStore(s => s.alphaSquad);
  const [showThemeBuilder, setShowThemeBuilder] = useState(false);
  
  // Floating Banner State
  const [isAlphaBannerVisible, setIsAlphaBannerVisible] = useState(false);
  const hasInstitutionalActivity = alphaSquad && alphaSquad.length > 0;

  // Auto-show banner only once per activity spike if not already visible
  useEffect(() => {
    if (hasInstitutionalActivity && !isAlphaBannerVisible) {
       // Optional: you could auto-trigger here, but user asked for a toggle icon
    }
  }, [hasInstitutionalActivity, isAlphaBannerVisible]);

  return (
    <div className={styles.appContainer}>
      <header className={styles.topBar}>
        <GlobalHeader onOpenThemeBuilder={() => setShowThemeBuilder(true)} />
      </header>

      <div className={styles.viewLayout}>
        <Sidebar />

        <main className={styles.mainContent}>
          
          {/* SECTION: 3rd UMPIRE VALIDATOR */}
          <section id="section-umpire" className={styles.widgetSection}>
            <ValidatorTimelineWidget />
          </section>


          {/* SECTION: LEVELS & CASCADE MONITOR (SPLIT ROW) */}
          <div className={styles.splitGrid}>
            <section id="section-levels" className={styles.widgetSection}>
              <LevelReactionWidget />
            </section>
            
            {/* RIGHT COLUMN: CASCADE + SCOUT + GHOST */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--widget-gap)' }}>
              <section id="section-cascade" className={styles.widgetSection}>
                <EMACascadeMonitor />
              </section>

              <section id="section-scout" className={styles.widgetSection}>
                <ParticipationPulseWidget />
              </section>

              {isLive && (
                <section className={styles.widgetSection}>
                  <GhostCoinWidget />
                </section>
              )}
              <section id="section-alpha" className={styles.widgetSection}>
                <AlphaScatter />
              </section>
            </div>
          </div>

          {/* SECTION: DISTANCE BOARD & TIMELINES (SPLIT ROW) */}
          <div className={styles.splitGrid}>
            <section id="section-dist" className={styles.widgetSection}>
              <DistanceTracker />
            </section>
            
            {/* RIGHT SIDE: ANALYTICS COLUMN (STACKED) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--widget-gap)' }}>
              <MarketSentimentTimeline />
              <AlertFrequencyTimeline />
            </div>
          </div>


          {/* SECTION: FUSION COMMAND */}
          <section id="section-fusion" className={styles.widgetSection}>
            <FusionDashboard />
          </section>

          {/* RSI DISTRIBUTION */}
          <section className={styles.widgetSection}>
            <RSIDistributionWidget />
          </section>

          {/* MARKET STRUCTURE (FULL WIDTH) */}
          <section className={styles.widgetSection}>
            <MarketStructureWidget />
          </section>

          {/* CONFLUENCE GRID (FULL WIDTH) */}
          <section className={styles.widgetSection}>
            <ConfluenceGrid />
          </section>

          {/* ALERTS ANALYZER (FULL WIDTH) */}
          <section className={styles.widgetSection}>
            <AlertsAnalyzer />
          </section>

          {/* RECOMMENDATIONS FEED (FULL WIDTH) */}
          <section className={styles.widgetSection}>
            <RecommendationsFeed />
          </section>

          {/* INSTITUTIONAL (LIVE ONLY) */}
          {isLive && (
            <section className={styles.widgetSection}>
              <CoinAgeWidget />
            </section>
          )}

          {/* SECTION: DAILY CALENDAR (FOOTER) */}
          <section className={styles.widgetSection} style={{ marginTop: '24px' }}>
            <DailyCalendarWidget />
          </section>

        </main>
      </div>

      {/* OVERLAYS & FLOATING */}
      <SelectionDrawer />
      {showPlayback && (
        <>
          <FloatingTimeController />
          <FloatingMediaPlayer />
        </>
      )}
      <MonitorDetailModal />
      
      {/* FLOATING ADS BANNER (ALPHA SQUAD) */}
      <div className={styles.alphaBannerWrapper}>
          {/* Banner removed: AlphaScatter lives in section-alpha in the main layout.
              The toggle button scrolls to it instead of duplicating the widget. */}
          
          <button 
            className={`${styles.alphaToggleBtn} ${hasInstitutionalActivity ? styles.alphaTogglePulse : ''}`}
            onClick={() => {
              document.getElementById('section-alpha')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              setIsAlphaBannerVisible(!isAlphaBannerVisible);
            }}
            title="Toggle Alpha Squad Banner"
          >
            <Target size={20} color={isAlphaBannerVisible ? 'var(--accent-blue)' : '#fff'} />
            {hasInstitutionalActivity && !isAlphaBannerVisible && (
                <span className={styles.alphaNotificationDot} />
            )}
          </button>
      </div>

      {showThemeBuilder && <ThemeBuilder onClose={() => setShowThemeBuilder(false)} />}
    </div>
  );
}

export default App;
