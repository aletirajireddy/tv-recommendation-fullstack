// Smart Alerts evaluator — runs on each scan tick, checks every active alert
// against its current price / EMA200 / ATR, records triggers, broadcasts via
// Socket.IO, and (for APPROACH events only) dispatches Telegram.
//
// Performance: a single batched query fetches the latest Stream D blob per
// distinct ticker — alerts on the same ticker share one DB hit. Even with
// 100 active alerts across 30 tickers we're at 30 row reads per scan tick.

const service        = require('./service');
const telegramService = require('../telegram');

const TF_BY_RES = { 1: 'm1', 5: 'm5', 15: 'm15', 60: 'h1', 240: 'h4' };
const TF_RES_MIN = { m1: 1, m5: 5, m15: 15, h1: 60, h4: 240 };

let _io = null;
let _mainDb = null;

function init({ io, db }) {
    _io = io;
    _mainDb = db;
    console.log(`✅ Smart Alerts Evaluator armed`);
}

// Public — called from server's scan tick handler.
async function evaluateAll(reason = 'scan-update') {
    if (!_mainDb) return;
    const alerts = service.listEvaluable();
    if (!alerts.length) return;

    // Auto-expire pass first (no DB hits per alert needed for this)
    const nowIso = new Date().toISOString();
    const stillActive = [];
    for (const a of alerts) {
        if (a.expires_at && a.expires_at < nowIso) {
            service.recordExpiry(a);
            broadcast('smart-alert-expired', { id: a.id, ticker: a.ticker, timeframe: a.timeframe });
        } else {
            stillActive.push(a);
        }
    }
    if (!stillActive.length) return;

    // Batch fetch: latest Stream D row per distinct ticker
    const tickers = [...new Set(stillActive.map(a => a.ticker))];
    const placeholders = tickers.map(() => '?').join(',');
    let dRows = [];
    try {
        dRows = _mainDb.prepare(`
            SELECT m.ticker, m.timestamp, m.stream_d_state, m.price
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS mx
                FROM master_coin_store
                WHERE trigger_source = 'STREAM_D' AND stream_d_state IS NOT NULL
                  AND ticker IN (${placeholders})
                GROUP BY ticker
            ) t ON t.ticker=m.ticker AND t.mx=m.timestamp
            WHERE m.trigger_source = 'STREAM_D'
        `).all(...tickers);
    } catch (e) {
        console.error('[SmartAlerts] batch fetch failed:', e.message);
        return;
    }

    // Build per-ticker quote map (price + per-TF EMA + per-TF ATR)
    const quoteByTicker = new Map();
    for (const r of dRows) {
        let d; try { d = JSON.parse(r.stream_d_state); } catch { continue; }
        if (!d) continue;
        const emas = {}, atrs = {};
        for (const k of Object.keys(d)) {
            const mE = k.match(/^ema_200Timeresolution(\d+)$/i);
            if (mE) {
                const slot = TF_BY_RES[parseInt(mE[1], 10)];
                if (slot) emas[slot] = parseFloat(d[k]);
                continue;
            }
            const mA = k.match(/^averagetruerangepercent_\d+Timeresolution(\d+)$/i);
            if (mA) {
                const slot = TF_BY_RES[parseInt(mA[1], 10)];
                if (slot) atrs[slot] = parseFloat(d[k]);
            }
        }
        // ATR nearest-TF fallback (matches /api/ema-distance-board behaviour)
        const tfsWithAtr = Object.keys(atrs).filter(tf => atrs[tf] != null && !isNaN(atrs[tf]));
        if (tfsWithAtr.length) {
            for (const tf of Object.keys(TF_RES_MIN)) {
                if (atrs[tf] != null && !isNaN(atrs[tf])) continue;
                const target = TF_RES_MIN[tf];
                let best = tfsWithAtr[0], bestDelta = Math.abs(TF_RES_MIN[best] - target);
                for (const cand of tfsWithAtr) {
                    const delta = Math.abs(TF_RES_MIN[cand] - target);
                    if (delta < bestDelta) { bestDelta = delta; best = cand; }
                }
                atrs[tf] = atrs[best];
            }
        }
        const price = parseFloat(d.price ?? d.close ?? r.price);
        if (!isNaN(price)) quoteByTicker.set(r.ticker, { price, emas, atrs, ts: r.timestamp });
    }

    // Per-alert evaluation
    for (const a of stillActive) {
        const q = quoteByTicker.get(a.ticker);
        if (!q) continue;

        const ema = q.emas[a.timeframe];
        const atr = q.atrs[a.timeframe];
        const price = q.price;
        if (price == null || ema == null || isNaN(ema)) continue;

        const newSide = service.sideOf(price, ema);
        const distAtr = service.deltaAtr(price, ema, atr);
        const triggers = a.triggers || [];
        const params   = a.params   || {};

        let firedType = null;

        // Order: TOUCH > APPROACH > CROSS — strongest signal wins per tick
        if (triggers.includes('touch') && distAtr != null && distAtr <= (params.touch_atr ?? service.DEFAULT_TOUCH_ATR)) {
            firedType = 'touch';
        } else if (triggers.includes('cross') && a.last_side && newSide && a.last_side !== newSide && (a.last_side === 'above' || a.last_side === 'below') && (newSide === 'above' || newSide === 'below')) {
            firedType = 'cross';
        } else if (triggers.includes('approach') && distAtr != null && distAtr <= (params.approach_atr ?? service.DEFAULT_APPROACH_ATR)) {
            firedType = 'approach';
        }

        // Cooldown gate for recurring alerts (avoid re-firing every tick while inside zone)
        if (firedType && a.params?.recurring && a.last_qualified_at) {
            const cooldownMs = (params.cooldown_min ?? service.DEFAULT_COOLDOWN_MIN) * 60_000;
            const sinceLast = Date.now() - new Date(a.last_qualified_at).getTime();
            if (sinceLast < cooldownMs) firedType = null;
        }

        if (firedType) {
            service.recordTrigger({ alert: a, eventType: firedType, price, ema, atr });
            broadcast('smart-alert-qualified', {
                id: a.id, ticker: a.ticker, clean_ticker: a.clean_ticker, timeframe: a.timeframe,
                event_type: firedType, price, ema, atr,
                distance_pct: service.deltaPct(price, ema), distance_atr: distAtr,
            });

            // Telegram for APPROACH only (per spec). Format mirrors existing services.
            if (firedType === 'approach') {
                dispatchTelegram(a, { price, ema, atr, distAtr });
            }
        }

        // Always record the evaluation so cross-detection has up-to-date last_side
        service.recordEvaluation({
            id: a.id, ts: new Date().toISOString(), price, ema, atr, side: newSide,
        });
    }
}

function dispatchTelegram(alert, { price, ema, atr, distAtr }) {
    if (!telegramService || !telegramService.isEnabled) return;
    const tfLabel = { m1:'1m', m5:'5m', m15:'15m', h1:'1h', h4:'4h' }[alert.timeframe] || alert.timeframe;
    const dirArrow = price > ema ? '⬇️ approaching from above' : '⬆️ approaching from below';
    const distPct  = service.deltaPct(price, ema);
    const note     = alert.params?.note ? `\n_${alert.params.note}_` : '';

    const msg =
        `🎯 *SMART ALERT — APPROACH*\n` +
        `*${alert.clean_ticker}* · ${tfLabel} EMA200\n` +
        `Price ${formatPrice(price)} ${dirArrow}\n` +
        `EMA: ${formatPrice(ema)} · Δ ${distPct >= 0 ? '+' : ''}${distPct.toFixed(3)}% (${distAtr?.toFixed(2)}× ATR)${note}\n` +
        `\`[E·SMART] #EMA200_APPROACH\``;

    // Use 'INFO' tier — non-spammy; smart alerts have their own cooldowns
    telegramService.sendAlert(msg, 'SMART_ALERT', {
        alert_id: alert.id, ticker: alert.clean_ticker, tf: alert.timeframe,
        price, ema, distance_atr: distAtr,
    }, 'INFO').catch(err => console.error('[SmartAlerts] tg send failed:', err.message));
}

function formatPrice(p) {
    if (p == null || isNaN(p)) return '?';
    const n = parseFloat(p);
    if (n >= 1000)   return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    if (n >= 1)      return `$${n.toFixed(4)}`;
    if (n >= 0.001)  return `$${n.toFixed(6)}`;
    return `$${n.toExponential(3)}`;
}

function broadcast(event, payload) {
    if (!_io) return;
    try { _io.emit(event, { ...payload, ts: new Date().toISOString() }); } catch (e) { /* swallow */ }
}

module.exports = { init, evaluateAll };
