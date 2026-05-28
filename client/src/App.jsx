import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import styles from './App.module.css';
import { GlobalHeader } from './components/GlobalHeader';
import { Sidebar } from './components/Sidebar';
import { SelectionDrawer } from './components/SelectionDrawer';
import { useTimeStore } from './store/useTimeStore';
import { LazyWidget } from './components/LazyWidget';
import { MobileFloatingBar } from './components/MobileFloatingBar';
import { Target, AlertTriangle, X } from 'lucide-react';
import socketService from './services/SocketService';

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
import { ValidatorTimelineWidget } from './components/AnalyticsWidgets/ValidatorTimelineWidget';
import { LevelReactionWidget } from './components/AnalyticsWidgets/LevelReactionWidget';
import { DistanceTracker } from './components/AnalyticsWidgets/DistanceTracker';
import { BYCWidget } from './components/AnalyticsWidgets/BYCWidget';

const DailyCalendarWidget       = lazy(() => import('./components/AnalyticsWidgets/DailyCalendarWidget').then(m => ({ default: m.DailyCalendarWidget })));
const EMACascadeMonitor         = lazy(() => import('./components/AnalyticsWidgets/EMACascadeMonitor').then(m => ({ default: m.EMACascadeMonitor })));
const CascadeTrendWidget        = lazy(() => import('./components/AnalyticsWidgets/CascadeTrendWidget').then(m => ({ default: m.CascadeTrendWidget })));
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

// Thin placeholder shown while the timeline is loading — same visual weight
// as a widget skeleton but without mounting the actual widget (and firing its fetch).
function WidgetGate({ minHeight = 80, children }) {
  const appReady = useTimeStore(s => s.appReady);
  if (!appReady) {
    return (
      <div style={{
        width: '100%', minHeight,
        borderRadius: 8,
        background: 'linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.05) 50%, rgba(255,255,255,0.02) 100%)',
        backgroundSize: '200% 100%',
        animation: 'lazyShimmer 1.6s ease-in-out infinite',
        border: '1px solid rgba(255,255,255,0.04)',
      }} aria-busy="true" aria-label="Loading widget" />
    );
  }
  return children;
}

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

  // ── Stream B overload banner ────────────────────────────────────────────────
  // Fires when backend receives > 40 unique .P coins in a single Stream B push.
  // Qualification is suppressed server-side; banner tells user to fix the scanner.
  const [streamBAlert, setStreamBAlert] = useState(null); // { uniqueCount, rawCount, maxAllowed, timestamp }
  const alertTimerRef = useRef(null);

  useEffect(() => {
    const sock = socketService.connect();
    const handle = (data) => {
      setStreamBAlert(data);
      // Auto-clear after 5 minutes if not manually dismissed
      clearTimeout(alertTimerRef.current);
      alertTimerRef.current = setTimeout(() => setStreamBAlert(null), 5 * 60 * 1000);
    };
    sock.on('stream-b-overload', handle);
    return () => {
      sock.off('stream-b-overload', handle);
      clearTimeout(alertTimerRef.current);
    };
  }, []);

  return (
    <div className={styles.appContainer}>
      <header className={styles.topBar}>
        <GlobalHeader onOpenThemeBuilder={() => setShowThemeBuilder(true)} />
      </header>

      <div className={styles.viewLayout}>
        <Sidebar />

        <main className={styles.mainContent}>

          {/* SECTION: BYOC SCREENER
              Eagerly imported but gated — mounts only after timeline loads.
              Prevents its /api/byc-screener fetch from racing fetchTimeline at T=0. */}
          <section id="section-byc" className={styles.widgetSection}>
            <WidgetGate minHeight={90}>
              <BYCWidget />
            </WidgetGate>
          </section>

          {/* SECTION: 3rd UMPIRE VALIDATOR
              Same gate — /api/validator/trials deferred until timeline is ready. */}
          <section id="section-umpire" className={styles.widgetSection}>
            <WidgetGate minHeight={320}>
              <ValidatorTimelineWidget />
            </WidgetGate>
          </section>

          {/* SECTION: LEVELS & CASCADE MONITOR (SPLIT ROW) */}
          <div className={styles.splitGrid}>
            {/* LevelReactionWidget: gated — /api/level-reactions deferred until ready */}
            <section id="section-levels" className={styles.widgetSection}>
              <WidgetGate minHeight={500}>
                <LevelReactionWidget />
              </WidgetGate>
            </section>

            {/* RIGHT COLUMN: CASCADE + SCOUT + GHOST
                minHeights set to realistic rendered sizes so the IO doesn't see all
                of them as "in viewport" on first paint (old 280px was too small). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--widget-gap)' }}>
              <section id="section-cascade" className={styles.widgetSection}>
                <LazyWidget minHeight={480}>
                  <EMACascadeMonitor />
                </LazyWidget>
              </section>

              <section id="section-cascade-trend" className={styles.widgetSection}>
                <LazyWidget minHeight={520}>
                  <CascadeTrendWidget />
                </LazyWidget>
              </section>

              <section id="section-scout" className={styles.widgetSection}>
                <LazyWidget minHeight={380}>
                  <ParticipationPulseWidget />
                </LazyWidget>
              </section>

              {isLive && (
                <section className={styles.widgetSection}>
                  <LazyWidget minHeight={260}>
                    <GhostCoinWidget />
                  </LazyWidget>
                </section>
              )}
              <section id="section-alpha" className={styles.widgetSection}>
                <LazyWidget minHeight={420}>
                  <AlphaScatter />
                </LazyWidget>
              </section>
            </div>
          </div>

          {/* SECTION: DISTANCE BOARD & TIMELINES (SPLIT ROW) */}
          <div className={styles.splitGrid}>
            {/* DistanceTracker: gated — /api/ema-distance-board deferred until ready */}
            <section id="section-dist" className={styles.widgetSection}>
              <WidgetGate minHeight={520}>
                <DistanceTracker />
              </WidgetGate>
            </section>

            {/* RIGHT SIDE: ANALYTICS COLUMN (STACKED) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--widget-gap)' }}>
              <LazyWidget minHeight={320}>
                <MarketSentimentTimeline />
              </LazyWidget>
              <LazyWidget minHeight={320}>
                <AlertFrequencyTimeline />
              </LazyWidget>
            </div>
          </div>

          {/* SECTION: ATR RACE */}
          <section id="section-race" className={styles.widgetSection}>
            <LazyWidget minHeight={640}>
              <ATRRaceWidget />
            </LazyWidget>
          </section>

          {/* SECTION: SMART ALERTS */}
          <section id="section-alerts" className={styles.widgetSection}>
            <LazyWidget minHeight={520}>
              <SmartAlertsWidget />
            </LazyWidget>
          </section>

          {/* SECTION: FUSION COMMAND */}
          <section id="section-fusion" className={styles.widgetSection}>
            <LazyWidget minHeight={600}>
              <FusionDashboard />
            </LazyWidget>
          </section>

          {/* RSI DISTRIBUTION */}
          <section id="section-rsi-dist" className={styles.widgetSection}>
            <LazyWidget minHeight={400}>
              <RSIDistributionWidget />
            </LazyWidget>
          </section>

          {/* MARKET STRUCTURE */}
          <section id="section-market-structure" className={styles.widgetSection}>
            <LazyWidget minHeight={500}>
              <MarketStructureWidget />
            </LazyWidget>
          </section>

          {/* CONFLUENCE GRID */}
          <section id="section-confluence" className={styles.widgetSection}>
            <LazyWidget minHeight={500}>
              <ConfluenceGrid />
            </LazyWidget>
          </section>

          {/* ALERTS ANALYZER */}
          <section id="section-alerts-analyzer" className={styles.widgetSection}>
            <LazyWidget minHeight={500}>
              <AlertsAnalyzer />
            </LazyWidget>
          </section>

          {/* RECOMMENDATIONS FEED */}
          <section id="section-recommendations" className={styles.widgetSection}>
            <LazyWidget minHeight={500}>
              <RecommendationsFeed />
            </LazyWidget>
          </section>

          {/* INSTITUTIONAL (LIVE ONLY) */}
          {isLive && (
            <section id="section-coin-age" className={styles.widgetSection}>
              <LazyWidget minHeight={400}>
                <CoinAgeWidget />
              </LazyWidget>
            </section>
          )}

          {/* SECTION: RSI GRID WALL */}
          <section id="section-rsi-grid" className={styles.widgetSection}>
            <LazyWidget minHeight={460}>
              <RSIGridWall />
            </LazyWidget>
          </section>

          {/* SECTION: MOMENTUM PULSE */}
          <section id="section-momentum-pulse" className={styles.widgetSection}>
            <LazyWidget minHeight={440}>
              <MomentumPulse />
            </LazyWidget>
          </section>

          {/* SECTION: SMART MOOD CHART */}
          <section id="section-smart-mood" className={styles.widgetSection}>
            <LazyWidget minHeight={420}>
              <SmartMoodChart />
            </LazyWidget>
          </section>

          {/* SECTION: DAILY CALENDAR (FOOTER) */}
          <section id="section-calendar" className={styles.widgetSection} style={{ marginTop: '24px' }}>
            <LazyWidget minHeight={380}>
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

      {/* ── Stream B overload sticky footer banner ── */}
      {streamBAlert && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
          background: 'linear-gradient(90deg, #7c2d12, #92400e)',
          borderTop: '2px solid #f97316',
          padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 -4px 20px rgba(249,115,22,0.35)',
          animation: 'none',
        }}>
          <AlertTriangle size={16} color="#fb923c" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: '#fb923c', marginRight: 8 }}>
              ⚠ STREAM B OVERLOADED
            </span>
            <span style={{ fontSize: 11, color: '#fcd34d' }}>
              {streamBAlert.uniqueCount} unique .P coins received (raw: {streamBAlert.rawCount} · max: {streamBAlert.maxAllowed}).
              {' '}Qualification was <strong style={{ color: '#f87171' }}>SKIPPED</strong> to protect data integrity.
              {' '}Fix your TradingView watchlist scanner — reduce to under {streamBAlert.maxAllowed} coins.
            </span>
            <span style={{ fontSize: 10, color: '#f97316', marginLeft: 8, opacity: 0.7 }}>
              {new Date(streamBAlert.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <button
            onClick={() => setStreamBAlert(null)}
            style={{
              background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 4, color: '#fb923c', cursor: 'pointer', padding: '3px 6px',
              display: 'flex', alignItems: 'center', flexShrink: 0,
            }}
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
