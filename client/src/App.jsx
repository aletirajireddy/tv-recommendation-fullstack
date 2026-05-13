import React, { lazy, Suspense, useEffect, useState } from 'react';
import styles from './App.module.css';
import { GlobalHeader } from './components/GlobalHeader';
import { Sidebar } from './components/Sidebar';
import { SelectionDrawer } from './components/SelectionDrawer';
import { useTimeStore } from './store/useTimeStore';
import { LazyWidget } from './components/LazyWidget';
import { MobileFloatingBar } from './components/MobileFloatingBar';
import { Target } from 'lucide-react';

// These 4 are conditional — they only render when the user explicitly opens
// them. Lazy-loading keeps them out of the initial JS bundle entirely so the
// main dashboard doesn't pay their parse cost on every page load.
const FloatingTimeController = lazy(() => import('./components/FloatingTimeController').then(m => ({ default: m.FloatingTimeController })));
const FloatingMediaPlayer    = lazy(() => import('./components/FloatingMediaPlayer').then(m => ({ default: m.FloatingMediaPlayer })));
const MonitorDetailModal     = lazy(() => import('./components/MonitorDetailModal').then(m => ({ default: m.MonitorDetailModal })));
const ThemeBuilder           = lazy(() => import('./components/ThemeBuilder').then(m => ({ default: m.ThemeBuilder })));

// CODE-SPLIT WIDGETS — each becomes its own chunk, fetched only when in viewport.
// Above-the-fold widgets get a smaller rootMargin; deeper sections get more aggressive
// prefetch so the user never sees a skeleton during normal scroll.
const ValidatorTimelineWidget   = lazy(() => import('./components/AnalyticsWidgets/ValidatorTimelineWidget').then(m => ({ default: m.ValidatorTimelineWidget })));
const DailyCalendarWidget       = lazy(() => import('./components/AnalyticsWidgets/DailyCalendarWidget').then(m => ({ default: m.DailyCalendarWidget })));
const LevelReactionWidget       = lazy(() => import('./components/AnalyticsWidgets/LevelReactionWidget').then(m => ({ default: m.LevelReactionWidget })));
const EMACascadeMonitor         = lazy(() => import('./components/AnalyticsWidgets/EMACascadeMonitor').then(m => ({ default: m.EMACascadeMonitor })));
const DistanceTracker           = lazy(() => import('./components/AnalyticsWidgets/DistanceTracker').then(m => ({ default: m.DistanceTracker })));
const MarketSentimentTimeline   = lazy(() => import('./components/AnalyticsWidgets/MarketSentimentTimeline').then(m => ({ default: m.MarketSentimentTimeline })));
const AlertFrequencyTimeline    = lazy(() => import('./components/AnalyticsWidgets/AlertFrequencyTimeline').then(m => ({ default: m.AlertFrequencyTimeline })));
const FusionDashboard           = lazy(() => import('./components/AnalyticsWidgets/FusionDashboard'));
const RSIDistributionWidget     = lazy(() => import('./components/AnalyticsWidgets/RSIDistributionWidget'));
const MarketStructureWidget     = lazy(() => import('./components/AnalyticsWidgets/MarketStructureWidget').then(m => ({ default: m.MarketStructureWidget })));
const ConfluenceGrid            = lazy(() => import('./components/AnalyticsWidgets/ConfluenceGrid').then(m => ({ default: m.ConfluenceGrid })));
const AlertsAnalyzer            = lazy(() => import('./components/AnalyticsWidgets/AlertsAnalyzer').then(m => ({ default: m.AlertsAnalyzer })));
const RecommendationsFeed       = lazy(() => import('./components/AnalyticsWidgets/RecommendationsFeed'));
const ParticipationPulseWidget  = lazy(() => import('./components/AnalyticsWidgets/ParticipationPulseWidget').then(m => ({ default: m.ParticipationPulseWidget })));
const CoinAgeWidget             = lazy(() => import('./components/AnalyticsWidgets/CoinAgeWidget').then(m => ({ default: m.CoinAgeWidget })));
const GhostCoinWidget           = lazy(() => import('./components/AnalyticsWidgets/GhostCoinWidget').then(m => ({ default: m.GhostCoinWidget })));
const AlphaScatter              = lazy(() => import('./components/AnalyticsWidgets/AlphaScatter').then(m => ({ default: m.AlphaScatter })));
const SmartAlertsWidget         = lazy(() => import('./components/AnalyticsWidgets/SmartAlertsWidget').then(m => ({ default: m.SmartAlertsWidget })));
const ATRRaceWidget             = lazy(() => import('./components/AnalyticsWidgets/ATRRaceWidget').then(m => ({ default: m.ATRRaceWidget })));
const SmartMoodChart            = lazy(() => import('./components/AnalyticsWidgets/SmartMoodChart').then(m => ({ default: m.SmartMoodChart })));
const MomentumPulse             = lazy(() => import('./components/AnalyticsWidgets/MomentumPulse').then(m => ({ default: m.MomentumPulse })));
const RSIGridWall               = lazy(() => import('./components/AnalyticsWidgets/RSIGridWall').then(m => ({ default: m.RSIGridWall })));

function App() {
  const isLive = useTimeStore(s => s.timeline.length > 0 ? s.currentIndex === s.timeline.length - 1 : false);
  const showPlayback = useTimeStore(s => s.showPlayback);
  const alphaSquad = useTimeStore(s => s.alphaSquad);
  const [showThemeBuilder, setShowThemeBuilder] = useState(false);

  // Floating Banner State
  const [isAlphaBannerVisible, setIsAlphaBannerVisible] = useState(false);
  const hasInstitutionalActivity = alphaSquad && alphaSquad.length > 0;

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

          {/* SECTION: 3rd UMPIRE VALIDATOR (above-the-fold — small margin) */}
          <section id="section-umpire" className={styles.widgetSection}>
            <LazyWidget minHeight={420} rootMargin="200px 0px">
              <ValidatorTimelineWidget />
            </LazyWidget>
          </section>


          {/* SECTION: LEVELS & CASCADE MONITOR (SPLIT ROW) */}
          <div className={styles.splitGrid}>
            <section id="section-levels" className={styles.widgetSection}>
              <LazyWidget minHeight={520}>
                <LevelReactionWidget />
              </LazyWidget>
            </section>

            {/* RIGHT COLUMN: CASCADE + SCOUT + GHOST */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--widget-gap)' }}>
              <section id="section-cascade" className={styles.widgetSection}>
                <LazyWidget minHeight={280}>
                  <EMACascadeMonitor />
                </LazyWidget>
              </section>

              <section id="section-scout" className={styles.widgetSection}>
                <LazyWidget minHeight={280}>
                  <ParticipationPulseWidget />
                </LazyWidget>
              </section>

              {isLive && (
                <section className={styles.widgetSection}>
                  <LazyWidget minHeight={240}>
                    <GhostCoinWidget />
                  </LazyWidget>
                </section>
              )}
              <section id="section-alpha" className={styles.widgetSection}>
                <LazyWidget minHeight={320}>
                  <AlphaScatter />
                </LazyWidget>
              </section>
            </div>
          </div>

          {/* SECTION: DISTANCE BOARD & TIMELINES (SPLIT ROW) */}
          <div className={styles.splitGrid}>
            <section id="section-dist" className={styles.widgetSection}>
              <LazyWidget minHeight={520}>
                <DistanceTracker />
              </LazyWidget>
            </section>

            {/* RIGHT SIDE: ANALYTICS COLUMN (STACKED) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--widget-gap)' }}>
              <LazyWidget minHeight={250}>
                <MarketSentimentTimeline />
              </LazyWidget>
              <LazyWidget minHeight={250}>
                <AlertFrequencyTimeline />
              </LazyWidget>
            </div>
          </div>


          {/* SECTION: ATR RACE — multi-coin ATR% / RVOL% momentum flow */}
          <section id="section-race" className={styles.widgetSection}>
            <LazyWidget minHeight={480}>
              <ATRRaceWidget />
            </LazyWidget>
          </section>

          {/* SECTION: SMART ALERTS — created from DistanceTracker cell-clicks */}
          <section id="section-alerts" className={styles.widgetSection}>
            <LazyWidget minHeight={420}>
              <SmartAlertsWidget />
            </LazyWidget>
          </section>

          {/* SECTION: FUSION COMMAND */}
          <section id="section-fusion" className={styles.widgetSection}>
            <LazyWidget minHeight={480}>
              <FusionDashboard />
            </LazyWidget>
          </section>

          {/* RSI DISTRIBUTION */}
          <section id="section-rsi-dist" className={styles.widgetSection}>
            <LazyWidget minHeight={320}>
              <RSIDistributionWidget />
            </LazyWidget>
          </section>

          {/* MARKET STRUCTURE (FULL WIDTH) */}
          <section id="section-market-structure" className={styles.widgetSection}>
            <LazyWidget minHeight={420}>
              <MarketStructureWidget />
            </LazyWidget>
          </section>

          {/* CONFLUENCE GRID (FULL WIDTH) */}
          <section id="section-confluence" className={styles.widgetSection}>
            <LazyWidget minHeight={420}>
              <ConfluenceGrid />
            </LazyWidget>
          </section>

          {/* ALERTS ANALYZER (FULL WIDTH) */}
          <section id="section-alerts-analyzer" className={styles.widgetSection}>
            <LazyWidget minHeight={420}>
              <AlertsAnalyzer />
            </LazyWidget>
          </section>

          {/* RECOMMENDATIONS FEED (FULL WIDTH) */}
          <section id="section-recommendations" className={styles.widgetSection}>
            <LazyWidget minHeight={420}>
              <RecommendationsFeed />
            </LazyWidget>
          </section>

          {/* INSTITUTIONAL (LIVE ONLY) */}
          {isLive && (
            <section id="section-coin-age" className={styles.widgetSection}>
              <LazyWidget minHeight={320}>
                <CoinAgeWidget />
              </LazyWidget>
            </section>
          )}

          {/* SECTION: RSI GRID WALL — per-coin RSI candle wall (cascade series + wick line) */}
          <section id="section-rsi-grid" className={styles.widgetSection}>
            <LazyWidget minHeight={360}>
              <RSIGridWall />
            </LazyWidget>
          </section>

          {/* SECTION: MOMENTUM PULSE — RVOL persistence × EMA distance × day change */}
          <section id="section-momentum-pulse" className={styles.widgetSection}>
            <LazyWidget minHeight={340}>
              <MomentumPulse />
            </LazyWidget>
          </section>

          {/* SECTION: SMART MOOD CHART — breadth/mood timeline with shift detection */}
          <section id="section-smart-mood" className={styles.widgetSection}>
            <LazyWidget minHeight={340}>
              <SmartMoodChart />
            </LazyWidget>
          </section>

          {/* SECTION: DAILY CALENDAR (FOOTER) */}
          <section id="section-calendar" className={styles.widgetSection} style={{ marginTop: '24px' }}>
            <LazyWidget minHeight={300}>
              <DailyCalendarWidget />
            </LazyWidget>
          </section>

        </main>
      </div>

      {/* OVERLAYS & FLOATING — chunks only download when the user opens them */}
      <SelectionDrawer />
      {showPlayback && (
        <Suspense fallback={null}>
          <FloatingTimeController />
          <FloatingMediaPlayer />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <MonitorDetailModal />
      </Suspense>

      {/* FLOATING ADS BANNER (ALPHA SQUAD) */}
      <div className={styles.alphaBannerWrapper}>
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

      {showThemeBuilder && (
        <Suspense fallback={null}>
          <ThemeBuilder onClose={() => setShowThemeBuilder(false)} />
        </Suspense>
      )}

      {/* Mobile-only floating status bubble — hidden on desktop via CSS */}
      <MobileFloatingBar onOpenThemeBuilder={() => setShowThemeBuilder(true)} />
    </div>
  );
}

export default App;
