const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const db = require('../database');
const categorySettings = require('./telegramSettingsManager');
const { normaliseTicker } = require('../utils/tickerNormalize');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ─────────────────────────────────────────────────────────────────────────────
// SEVERITY TIERS
//   CRITICAL  — always delivered (ignores quiet hours, ignores rate limits)
//   HIGH      — delivered unless quiet hours; queued for morning digest if suppressed
//   INFO      — delivered unless quiet hours; silently dropped if suppressed
// ─────────────────────────────────────────────────────────────────────────────
const TIER = { CRITICAL: 3, HIGH: 2, INFO: 1 };

// Quiet hours gate: suppress HIGH/INFO during these UTC hours to avoid 3am spam
const QUIET_START_UTC = 0;   // 00:00 UTC
const QUIET_END_UTC   = 6;   // 06:00 UTC  (6 hours quiet window)

// Per-ticker cooldown: same ticker can't re-alert within this window
// (guards against repeated bounces generating repeated verdicts)
const PER_TICKER_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4 hours

// Stream A global cooldown (between syncStrategies pulses)
const STREAM_A_COOLDOWN_MS = 15 * 60 * 1000;  // 15 minutes

// Institutional bar move threshold for CRITICAL vs HIGH tier
const INST_CRITICAL_BAR_MOVE_PCT = 3.0;   // >= 3% = CRITICAL
const INST_HIGH_BAR_MOVE_PCT     = 1.5;   // >= 1.5% = HIGH (was previously unchecked)

// RelVol thresholds
const RVOL_CRITICAL = 3.0;   // >= 3.0× = CRITICAL
const RVOL_HIGH     = 1.8;   // >= 1.8× = HIGH

// Coins of Interest — minimum bar move to bother alerting even a watched coin
// (avoids literal 0.0x% noise while still being well below INST_HIGH_BAR_MOVE_PCT)
const WATCHED_INST_MIN_BAR_MOVE_PCT = 0.5;

// Max items in the morning digest queue (prevents memory growth overnight)
const DIGEST_QUEUE_MAX = 30;

// Feed Health — minimum gap between repeat "still down" reminders for the
// SAME stream while it stays down. A stream down for 5 hours gets pinged
// once, then reminded hourly — not on every periodic check.
const FEED_HEALTH_REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

// 2026-09-11: "all 3 local streams dark" — a distinct, stronger signal from
// a single stream being down. The backend's tab-activation coordinator can
// only ever run when SOME stream is polling to ask it to — if all three go
// silent at once, nobody can ask, and the coordinator never gets a chance to
// run at all. That's exactly the case worth telling the user about
// separately: it likely means Automa itself is stuck/broken, not just one
// workflow. Own cooldown so it doesn't compete with or spam alongside the
// per-stream feed-health reminders.
const ALL_DARK_REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

const FEED_HEALTH_LABELS = {
    A: 'Stream A · Macro Scan',
    B: 'Stream B · Watchlist',
    C: 'Stream C · Webhooks',
    D: 'Stream D · Technicals',
};

// ─────────────────────────────────────────────────────────────────────────────
class TelegramService {
    constructor() {
        this.token  = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.bot    = null;

        this.env              = process.env.APP_ENV || 'local';
        this.isLocallyEnabled = process.env.TELEGRAM_ENABLED !== 'false';

        try {
            const setting = db.prepare("SELECT value FROM system_settings WHERE key = 'telegram_enabled'").get();
            this.dbEnabled = setting ? (setting.value === 'true') : true;
        } catch {
            this.dbEnabled = true;
        }

        this.isEnabled = this.isLocallyEnabled && this.dbEnabled;
        this.bootTime  = Date.now();

        // ── Anti-spam state ───────────────────────────────────────────────────
        // Stream A
        this.lastGlobalAlertTime = 0;
        // FIX: knownTickers persists across scans so coins that briefly leave
        // a strategy and re-enter don't falsely count as "new".
        // Only cleared when the per-ticker global cooldown expires.
        this.knownTickers = new Map();   // ticker → lastSeenMs  (was Set — BUG FIXED)

        // Per-ticker global cooldown (guards Stream C / validator verdict spam)
        this.tickerLastAlerted = new Map();  // ticker → lastAlertedMs

        // Morning digest queue — HIGH alerts suppressed during quiet hours
        this.digestQueue = [];

        // Retry queue — failed sends retried on next successful delivery
        this._retryQueue = [];

        // Feed Health alerting — separate cooldown/state from per-ticker alerts,
        // since streams (not tickers) are what's being tracked here.
        // lastAlertedAt: stream -> ms, gates repeat "still down" reminders.
        // wasDown: stream -> bool, so a recovery message only fires for a
        // stream we actually alerted about going down (never spam a recovery
        // for something that was never announced as broken).
        this.feedHealthLastAlertedAt = new Map();
        this.feedHealthWasDown = new Map();
        this.allDarkLastAlertedAt = 0;
        this.allDarkWasActive = false;

        if (this.token && this.token !== 'YOUR_BOT_TOKEN_HERE') {
            try {
                this.bot = new TelegramBot(this.token, { polling: false });
                console.log(`✅ Telegram Service v2 [${this.env.toUpperCase()}] enabled=${this.isEnabled}`);
                if (this.isEnabled) {
                    this.sendAlert(`${this.getPrefix()} 🚀 *SYSTEM ONLINE*\n\nDashboard V3 is active and monitoring.\nTime: ${new Date().toUTCString()}`, 'INFO', {}, 'INFO');
                }
            } catch (err) {
                console.error('❌ Telegram Init Error:', err);
            }
        } else {
            console.warn(`⚠️ Telegram Token missing in [${this.env}]. Notifications suppressed.`);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    getPrefix() {
        if (this.env === 'cloud' || this.env === 'production') return '☁️ [CLOUD]';
        if (this.env === 'local' || this.env === 'development')  return '💻 [LOCAL]';
        return `🆔 [${this.env.toUpperCase()}]`;
    }

    _isQuietHours() {
        const h = new Date().getUTCHours();
        return h >= QUIET_START_UTC && h < QUIET_END_UTC;
    }

    _isTickerOnCooldown(ticker) {
        const last = this.tickerLastAlerted.get(ticker) || 0;
        return (Date.now() - last) < PER_TICKER_COOLDOWN_MS;
    }

    _markTickerAlerted(ticker) {
        this.tickerLastAlerted.set(ticker, Date.now());
    }

    // Format a price intelligently depending on magnitude
    _fmtPrice(p) {
        if (!p && p !== 0) return '?';
        const n = parseFloat(p);
        if (n >= 1000)   return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        if (n >= 1)      return `$${n.toFixed(3)}`;
        if (n >= 0.001)  return `$${n.toFixed(5)}`;
        return `$${n.toExponential(3)}`;
    }

    _tierLevel(levelStr) {
        return TIER[levelStr] || TIER.INFO;
    }

    toggle(enabled) {
        this.isEnabled = enabled;
        try {
            db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('telegram_enabled', ?)").run(enabled.toString());
            console.log(`[Telegram] Notifications ${enabled ? 'ENABLED' : 'DISABLED'} (persisted)`);
        } catch (e) {
            console.error('Failed to persist Telegram setting:', e);
        }
        return this.isEnabled;
    }

    // ── Core send ─────────────────────────────────────────────────────────────

    /**
     * Low-level send.  All public alert methods route through here.
     * @param {string} message   - Markdown message text
     * @param {string} level     - DB log level string (e.g. 'SUCCESS', 'WARN', 'AI_PULSE')
     * @param {object} meta      - Optional meta for DB log
     * @param {string} tier      - 'CRITICAL' | 'HIGH' | 'INFO'  — controls quiet-hours gate
     * @param {string} [category] - Category key suffix (e.g. 'stream_a_pulse'); when set,
     *                              gated by the user's per-category Telegram toggle.
     */
    async sendAlert(message, level = 'INFO', meta = {}, tier = 'INFO', category = null) {
        // 1. Always write to telegram_logs
        try {
            db.prepare(`INSERT INTO telegram_logs (timestamp, level, message, meta_json) VALUES (?, ?, ?, ?)`)
              .run(new Date().toISOString(), level, message, JSON.stringify({ ...meta, tier, category }));
        } catch (e) {
            console.error('❌ TLog write failed:', e.message);
        }

        if (!this.bot || !this.chatId || !this.isEnabled) return;

        // 2. Category gate — user muted this category, silently drop (already logged above)
        if (category && !categorySettings.readKey(`telegram.category.${category}`)) return;

        const tierLevel = this._tierLevel(tier);

        // 3. Quiet hours gate — only CRITICAL bypasses
        if (this._isQuietHours() && tierLevel < TIER.CRITICAL) {
            if (tierLevel >= TIER.HIGH && this.digestQueue.length < DIGEST_QUEUE_MAX) {
                this.digestQueue.push({ message, level, meta, tier, queued_at: new Date().toISOString() });
                console.log(`[Telegram] 🌙 Quiet hours — queued HIGH alert for morning digest (queue=${this.digestQueue.length})`);
            }
            return;
        }

        // 4. Retry failed sends from previous cycle first
        await this._drainRetryQueue();

        // 5. Send
        try {
            const prefix      = this.getPrefix();
            const taggedMsg   = message.startsWith(prefix) ? message : `${prefix} ${message}`;
            await this.bot.sendMessage(this.chatId, taggedMsg, { parse_mode: 'Markdown' });
            this.lastSent = Date.now();
            console.log(`📤 Telegram [${tier}] sent [${this.env}]`);
        } catch (err) {
            console.error('❌ Telegram send failed:', err.message);
            // Buffer for retry (max 5 items to avoid unbounded growth)
            if (this._retryQueue.length < 5) {
                this._retryQueue.push({ message, level, meta, tier, failedAt: Date.now() });
            }
        }
    }

    async _drainRetryQueue() {
        if (this._retryQueue.length === 0) return;
        const toRetry = this._retryQueue.splice(0, 2); // retry up to 2 per cycle
        for (const item of toRetry) {
            try {
                await this.bot.sendMessage(this.chatId, `🔄 _[RETRY]_ ${item.message}`, { parse_mode: 'Markdown' });
                console.log(`[Telegram] ♻️ Retry delivered`);
            } catch {
                this._retryQueue.push(item); // put back if still failing
                break;
            }
        }
    }

    // ── Digest sender (called at 06:00 UTC by heartbeat) ─────────────────────

    async sendMorningDigest() {
        if (this.digestQueue.length === 0) return;
        const count = this.digestQueue.length;
        const items = this.digestQueue.splice(0); // drain

        let msg = `☀️ *MORNING DIGEST* — ${count} overnight alert${count > 1 ? 's' : ''} held:\n\n`;
        items.forEach((it, i) => {
            // Show first line of each queued message
            const firstLine = it.message.split('\n')[0].slice(0, 120);
            msg += `${i + 1}. ${firstLine}\n`;
        });
        msg += `\n_These were suppressed during quiet hours (00:00-06:00 UTC)._`;
        await this.sendAlert(msg, 'DIGEST', { count }, 'CRITICAL', 'heartbeat'); // force delivery
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAM A — Proactive strategy pulse
    // ─────────────────────────────────────────────────────────────────────────

    async syncStrategies(currentStrategies, marketSentiment, scenarios = null) {
        const now = Date.now();

        // SPAM GATE: 15-min global cooldown between AI_PULSE broadcasts
        if (now - this.lastGlobalAlertTime < STREAM_A_COOLDOWN_MS) return;

        const currentTickers = new Set();
        const eyeCatchers    = [];

        for (const strat of currentStrategies) {
            if (strat.type === 'info' || !strat.tickers) continue;
            for (const t of strat.tickers) {
                currentTickers.add(t.ticker);

                // BUG FIX: a ticker is "new" only if we've NEVER seen it, OR if it
                // hasn't appeared in any strategy within the per-ticker cooldown window.
                // Previously the Set was replaced each scan → coins that briefly left
                // and re-entered were re-counted as new.
                const lastSeen = this.knownTickers.get(t.ticker) || 0;
                if ((now - lastSeen) > PER_TICKER_COOLDOWN_MS) {
                    eyeCatchers.push({ ticker: t.ticker, strategy: strat.title, type: strat.type, bias: t.bias || '' });
                }
            }
        }

        // Merge — update timestamps for currently active tickers
        currentTickers.forEach(tk => this.knownTickers.set(tk, now));
        // Evict tickers not seen in 24h (memory guard)
        const H24 = 24 * 60 * 60 * 1000;
        for (const [tk, ts] of this.knownTickers) {
            if (now - ts > H24) this.knownTickers.delete(tk);
        }

        if (eyeCatchers.length === 0) return; // nothing new

        this.lastGlobalAlertTime = now;

        // Build message
        let header = `🚀 *GENIE MARKET PULSE*\n━━━━━━━━━━━━━\n`;
        if (marketSentiment) {
            const { moodScore, mood, bullish, bearish, neutral } = marketSentiment;
            const moodIcon  = moodScore >= 20 ? '🟢' : (moodScore <= -20 ? '🔴' : '🟡');
            const moodLabel = mood || (moodScore >= 20 ? 'BULLISH' : moodScore <= -20 ? 'BEARISH' : 'NEUTRAL');
            const bar       = (() => {
                const filled = Math.round((Math.min(Math.max(moodScore, -100), 100) + 100) / 200 * 12);
                return '▓'.repeat(filled) + '░'.repeat(12 - filled);
            })();
            header += `🔮 *Mood*: ${moodIcon} ${moodLabel} (${moodScore})\n`;
            header += `⚖️ *Breadth*: 📈 ${bullish} | 📉 ${bearish} | ➖ ${neutral}\n`;
            header += `\`[${bar}]\`\n`;
            header += `━━━━━━━━━━━━━\n\n`;
        }

        const displayed = new Set();
        let body = `🎯 *NEW EYE-CATCHERS (${eyeCatchers.length})*:\n`;
        for (const c of eyeCatchers) {
            if (displayed.has(c.ticker)) continue;
            displayed.add(c.ticker);
            const icon = c.type === 'opportunity' ? '⚡' : c.type === 'risk' ? '⚠️' : '🌊';
            body += `• ${icon} *${c.ticker}* _(${c.strategy})_ ${c.bias}\n`;
        }

        if (scenarios?.planA?.length) body += `\n🟢 *Plan A*: ${scenarios.planA.map(p => p.ticker).join(', ')}\n`;
        if (scenarios?.planB?.length) body += `🔴 *Plan B*: ${scenarios.planB.map(p => p.ticker).join(', ')}\n`;

        body += `\n\`[A·MACRO] #EYE_CATCHER\``;

        await this.sendAlert(header + body, 'AI_PULSE', { eyeCatcherCount: eyeCatchers.length }, 'HIGH', 'stream_a_pulse');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAM C — Institutional bar move (was completely unalerted)
    // ─────────────────────────────────────────────────────────────────────────

    _isWatchedCoin(ticker, category) {
        try {
            const norm = normaliseTicker(ticker);
            if (!norm) return false;
            const row = db.prepare(
                `SELECT * FROM telegram_watchlist WHERE ticker = ? AND ${category} = 1`
            ).get(norm);
            return !!row;
        } catch { return false; }
    }

    async onInstitutionalBarMove({ ticker, price, barMovePct, direction, volume }) {
        const absMove = Math.abs(barMovePct);
        if (absMove < INST_HIGH_BAR_MOVE_PCT) {
            // Below the general noise threshold — still worth a ping if this is
            // a hand-picked Coin of Interest and the move clears a much lower bar.
            if (absMove >= WATCHED_INST_MIN_BAR_MOVE_PCT && this._isWatchedCoin(ticker, 'institutional')) {
                await this.onWatchedSignal({
                    ticker, price, signalType: 'INSTITUTIONAL',
                    detail: `Bar Move: *${barMovePct >= 0 ? '+' : ''}${barMovePct.toFixed(2)}%*`,
                });
            }
            return;
        }

        const tier = absMove >= INST_CRITICAL_BAR_MOVE_PCT ? 'CRITICAL' : 'HIGH';

        // Per-ticker cooldown (don't alert same ticker every 5 min if whale is trading actively)
        if (tier !== 'CRITICAL' && this._isTickerOnCooldown(ticker)) return;
        this._markTickerAlerted(ticker);

        const dirIcon  = direction  > 0 ? '📈 BULL' : direction < 0 ? '📉 BEAR' : '➡️ NEUTRAL';
        const moveIcon = absMove >= 3   ? '🔥' : '🏦';
        const volStr   = volume ? ` · Vol: $${(volume / 1e6).toFixed(1)}M` : '';
        const levelTag = tier === 'CRITICAL' ? '🚨 CRITICAL' : '⚠️ HIGH';

        const msg =
            `${moveIcon} *INSTITUTIONAL MOVE* [${levelTag}]\n` +
            `*${ticker}* · ${this._fmtPrice(price)} · ${dirIcon}\n` +
            `Bar Move: *${barMovePct >= 0 ? '+' : ''}${barMovePct.toFixed(2)}%*${volStr}\n` +
            `\`[C·ALERT] #INST_MOVE\``;

        await this.sendAlert(msg, 'INST_MOVE', { ticker, barMovePct, direction }, tier, 'institutional_move');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAM B — Scout graduation (coin enters active watchlist)
    // ─────────────────────────────────────────────────────────────────────────

    async onScoutGraduation({ ticker, price, type, volChange }) {
        // Only alert STABLE graduations (meaningful) not every ORPHANED_STABLE retry
        if (type !== 'STABLE') return;
        // Suppress if same ticker alerted recently
        if (this._isTickerOnCooldown(ticker)) return;
        this._markTickerAlerted(ticker);

        const volStr = volChange ? ` · Vol Δ: *+${Math.abs(volChange).toFixed(0)}%*` : '';
        const msg =
            `🔍 *SCOUT GRADUATION*\n` +
            `*${ticker}* · ${this._fmtPrice(price)}\n` +
            `Status: *STABLE* — entering active watchlist${volStr}\n` +
            `\`[B·SCOUT] #GRADUATION\``;

        await this.sendAlert(msg, 'SCOUT', { ticker, type, volChange }, 'HIGH', 'scout_graduation');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GHOST QUEUE — operator approval required (was completely unalerted)
    // ─────────────────────────────────────────────────────────────────────────

    // 2026-09-16: now fires in BOTH ghost_auto_approve modes (previously auto
    // mode pruned instantly with no queue entry at all, so this only ever
    // fired in manual mode). The "what happens if nobody acts" line has to
    // say something different depending on mode now — auto mode WILL remove
    // the coin once the ghost-hours window expires; manual mode still won't.
    async onGhostQueued({ ticker, reason, autoApprove }) {
        // Ghost alerts are INFO — don't spam if coin keeps bouncing into ghost territory
        if (this._isTickerOnCooldown(ticker)) return;
        this._markTickerAlerted(ticker);

        const outcomeLine = autoApprove
            ? `Will auto-clear if it doesn't turn around — whitelist it in dashboard to protect it, or approve now to prune early.`
            : `Approve in dashboard or it stays active.`;

        const msg =
            `👻 *GHOST QUEUE*\n` +
            `*${ticker}* needs review\n` +
            `Reason: _${reason}_\n` +
            `${outcomeLine}\n` +
            `\`[SYSTEM] #GHOST_PENDING\``;

        await this.sendAlert(msg, 'GHOST', { ticker, reason }, 'INFO', 'ghost_queue');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAM D — Relative volume spike (institutional footprint; was unalerted)
    // ─────────────────────────────────────────────────────────────────────────

    async onRelVolSpike({ ticker, price, relVol }) {
        const tier = relVol >= RVOL_CRITICAL ? 'CRITICAL' : 'HIGH';
        if (tier !== 'CRITICAL' && this._isTickerOnCooldown(ticker)) return;
        this._markTickerAlerted(ticker);

        const icon   = relVol >= RVOL_CRITICAL ? '🚨' : '⚡';
        const tierStr = tier === 'CRITICAL' ? 'CRITICAL' : 'HIGH';

        const msg =
            `${icon} *REL-VOL SPIKE* [${tierStr}]\n` +
            `*${ticker}* · ${this._fmtPrice(price)}\n` +
            `Relative Volume: *${relVol.toFixed(2)}×* (institutional footprint)\n` +
            `\`[D·REALTIME] #RVOL_SPIKE\``;

        await this.sendAlert(msg, 'RVOL_SPIKE', { ticker, relVol }, tier, 'rvol_spike');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FEED HEALTH — proactive "a data stream is down" alerting (2026-09-02)
    // Closes a real gap: Stream A sat offline for 27 hours before anyone
    // noticed, because the only signal was a dashboard widget nobody was
    // looking at. Called periodically from index.js with the SAME
    // _computeFeedHealth() output the widget itself uses — one source of
    // truth, no separate threshold logic to drift out of sync.
    // ─────────────────────────────────────────────────────────────────────────

    async onFeedHealthCheck(streams) {
        for (const [stream, info] of Object.entries(streams || {})) {
            const label = FEED_HEALTH_LABELS[stream] || `Stream ${stream}`;
            const isDown = info.status === 'stalled' || info.status === 'frozen';
            const wasDown = this.feedHealthWasDown.get(stream) || false;

            if (isDown) {
                const lastAlertedAt = this.feedHealthLastAlertedAt.get(stream) || 0;
                if (Date.now() - lastAlertedAt < FEED_HEALTH_REMINDER_COOLDOWN_MS) continue; // already pinged recently, stay quiet

                this.feedHealthLastAlertedAt.set(stream, Date.now());
                this.feedHealthWasDown.set(stream, true);

                const tier = info.status === 'stalled' ? 'CRITICAL' : 'HIGH';
                const icon = info.status === 'stalled' ? '🔴' : '🟠';
                const reminderTag = wasDown ? ' _(still down)_' : '';

                let detail;
                if (info.status === 'stalled') {
                    const ageStr = info.lastWriteAgeMinutes != null
                        ? `${info.lastWriteAgeMinutes}min ago (${(info.lastWriteAgeMinutes / 60).toFixed(1)}h)`
                        : 'no data at all';
                    detail = `No new data at all — last write: ${ageStr}`;
                } else {
                    const n = (info.frozenTickers || []).length;
                    const worst = (info.frozenTickers || [])[0];
                    detail = `${n} ticker${n === 1 ? '' : 's'} stuck on repeated values` +
                        (worst ? ` (worst: *${worst.ticker}*, ${worst.frozenMinutes}min)` : '');
                }

                const msg =
                    `${icon} *DATA FEED DOWN*${reminderTag}\n` +
                    `*${label}*\n` +
                    `${detail}\n` +
                    `\`[FEED_HEALTH] #${info.status.toUpperCase()}\``;

                await this.sendAlert(msg, 'FEED_HEALTH', { stream, status: info.status }, tier, 'feed_health');

            } else if (wasDown) {
                // Recovered — only announce this for a stream we actually alerted about.
                this.feedHealthWasDown.set(stream, false);
                this.feedHealthLastAlertedAt.delete(stream);

                const msg =
                    `✅ *DATA FEED RECOVERED*\n` +
                    `*${label}* is healthy again.\n` +
                    `\`[FEED_HEALTH] #RECOVERED\``;

                await this.sendAlert(msg, 'FEED_HEALTH', { stream, status: 'recovered' }, 'HIGH', 'feed_health');
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ALL-DARK — Streams A, B, and D (the three local-tab streams) have ALL
    // gone silent past their thresholds at once. 2026-09-11: the tab-activation
    // coordinator (_getCoordinatedActivationTarget in index.js) can only ever
    // run when at least one of them is polling to ask it to fire — if all
    // three are silent, nobody can ask, and the whole self-healing mechanism
    // is powerless. Worth calling out distinctly: this usually means Automa
    // itself is stuck/broken (not just one workflow), or the browser/laptop
    // went properly idle — either way, it needs a human, not another retry.
    // ─────────────────────────────────────────────────────────────────────────
    async onAllStreamsDark(isAllDark, detail) {
        if (isAllDark) {
            if (Date.now() - this.allDarkLastAlertedAt < ALL_DARK_REMINDER_COOLDOWN_MS) return; // already pinged recently
            this.allDarkLastAlertedAt = Date.now();
            this.allDarkWasActive = true;

            const msg =
                `🔴🔴🔴 *ALL STREAMS DARK*\n` +
                `Streams A, B, and D are all silent past their thresholds at the same time.\n` +
                `${detail}\n` +
                `The backend's self-healing tab-activation can't help here — no stream is polling to trigger it. ` +
                `Likely Automa is stuck/broken, or the browser/laptop went idle. Needs a manual check.\n` +
                `\`[FEED_HEALTH] #ALL_DARK\``;

            await this.sendAlert(msg, 'FEED_HEALTH', { allDark: true }, 'CRITICAL', 'feed_health');
        } else if (this.allDarkWasActive) {
            this.allDarkWasActive = false;
            this.allDarkLastAlertedAt = 0;

            const msg =
                `✅ *STREAMS RECOVERED*\n` +
                `At least one of A/B/D is polling again.\n` +
                `\`[FEED_HEALTH] #ALL_DARK_RECOVERED\``;

            await this.sendAlert(msg, 'FEED_HEALTH', { allDark: false }, 'HIGH', 'feed_health');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COINS OF INTEREST — elevated alerts for a user-curated ticker watchlist.
    // Fires on a lower/bypassed bar than the generic breakout/institutional/rvol
    // paths above, since these are hand-picked coins the user explicitly wants
    // to hear about, not general noise-filtered market signals.
    // ─────────────────────────────────────────────────────────────────────────

    async onWatchedSignal({ ticker, signalType, price, detail }) {
        const cooldownKey = `WATCH:${signalType}:${ticker}`;
        if (this._isTickerOnCooldown(cooldownKey)) return;
        this._markTickerAlerted(cooldownKey);

        const ICONS = { BREAKOUT: '🦅', INSTITUTIONAL: '🏦', RVOL: '⚡' };
        const LABELS = { BREAKOUT: 'BREAKOUT', INSTITUTIONAL: 'INSTITUTIONAL MOVE', RVOL: 'VOLUME SPIKE' };
        const icon  = ICONS[signalType] || '⭐';
        const label = LABELS[signalType] || signalType;

        const msg =
            `⭐ *WATCHED COIN* — ${icon} ${label}\n` +
            `*${ticker}*${price != null ? ` · ${this._fmtPrice(price)}` : ''}\n` +
            (detail ? `${detail}\n` : '') +
            `\`[WATCHLIST] #WATCHED_${signalType}\``;

        await this.sendAlert(msg, 'WATCHED_SIGNAL', { ticker, signalType }, 'HIGH', 'watchlist');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HOURLY HEARTBEAT — system-alive digest + market state
    // ─────────────────────────────────────────────────────────────────────────

    async onHeartbeat() {
        try {
            // Morning digest delivery at first heartbeat after 06:00 UTC
            if (new Date().getUTCHours() === 6 && this.digestQueue.length > 0) {
                await this.sendMorningDigest();
            }

            // Gather live stats
            const nowISO  = new Date().toISOString();
            const hour1   = new Date(Date.now() - 60 * 60 * 1000).toISOString();

            const mood = db.prepare(`SELECT raw_mood_score, raw_label FROM raw_market_sentiment_log ORDER BY timestamp DESC LIMIT 1`).get();
            const trialsActive = db.prepare(`SELECT COUNT(*) as n FROM validation_trials WHERE state IN ('WATCHING','EARLY_FAVORABLE','CONFIRMED')`).get();
            const recentAlerts = db.prepare(`SELECT COUNT(*) as n FROM telegram_logs WHERE timestamp > ? AND level NOT IN ('HEARTBEAT','DIGEST')`).get(hour1);
            const topCoins = db.prepare(`
                SELECT ticker, COUNT(*) as n FROM volume_events WHERE ts > ? GROUP BY ticker ORDER BY n DESC LIMIT 3
            `).all(hour1);

            const moodIcon  = (mood?.raw_mood_score || 0) >= 20 ? '🟢' : (mood?.raw_mood_score || 0) <= -20 ? '🔴' : '🟡';
            const topStr    = topCoins.length ? topCoins.map(c => `${c.ticker} (${c.n}×)`).join(', ') : 'none';

            const msg =
                `💓 *SYSTEM HEARTBEAT* — ${new Date().toUTCString().slice(17, 22)} UTC\n` +
                `Mood: ${moodIcon} *${mood?.raw_label || 'UNKNOWN'}* (${mood?.raw_mood_score ?? '?'})\n` +
                `Active Trials: *${trialsActive?.n ?? 0}*\n` +
                `Alerts last hour: *${recentAlerts?.n ?? 0}*\n` +
                `Top activity: ${topStr}\n` +
                `\`[SYSTEM] #HEARTBEAT\``;

            await this.sendAlert(msg, 'HEARTBEAT', {}, 'INFO', 'heartbeat');
        } catch (err) {
            console.error('[Telegram] Heartbeat error:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOG READER (UI)
    // ─────────────────────────────────────────────────────────────────────────

    getLogs(limit = 100, anchorStr = null) {
        try {
            if (anchorStr) {
                return db.prepare('SELECT * FROM telegram_logs WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT ?').all(anchorStr, limit);
            }
            return db.prepare('SELECT * FROM telegram_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
        } catch {
            return [];
        }
    }

    getCoinsInFocus(dbInst, hours = 2) {
        try {
            const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
            const pulses = dbInst.prepare(`SELECT ticker, COUNT(*) as count FROM unified_alerts WHERE timestamp > ? GROUP BY ticker`).all(cutoff);
            const scores = {};
            pulses.forEach(p => { scores[p.ticker] = (scores[p.ticker] || 0) + p.count; });
            return Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, s]) => `${t} (${s})`);
        } catch { return []; }
    }
}

module.exports = new TelegramService();
