const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const db = require('../database');
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

// Max items in the morning digest queue (prevents memory growth overnight)
const DIGEST_QUEUE_MAX = 30;

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
     */
    async sendAlert(message, level = 'INFO', meta = {}, tier = 'INFO') {
        // 1. Always write to telegram_logs
        try {
            db.prepare(`INSERT INTO telegram_logs (timestamp, level, message, meta_json) VALUES (?, ?, ?, ?)`)
              .run(new Date().toISOString(), level, message, JSON.stringify({ ...meta, tier }));
        } catch (e) {
            console.error('❌ TLog write failed:', e.message);
        }

        if (!this.bot || !this.chatId || !this.isEnabled) return;

        const tierLevel = this._tierLevel(tier);

        // 2. Quiet hours gate — only CRITICAL bypasses
        if (this._isQuietHours() && tierLevel < TIER.CRITICAL) {
            if (tierLevel >= TIER.HIGH && this.digestQueue.length < DIGEST_QUEUE_MAX) {
                this.digestQueue.push({ message, level, meta, tier, queued_at: new Date().toISOString() });
                console.log(`[Telegram] 🌙 Quiet hours — queued HIGH alert for morning digest (queue=${this.digestQueue.length})`);
            }
            return;
        }

        // 3. Retry failed sends from previous cycle first
        await this._drainRetryQueue();

        // 4. Send
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
        await this.sendAlert(msg, 'DIGEST', { count }, 'CRITICAL'); // force delivery
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

        await this.sendAlert(header + body, 'AI_PULSE', { eyeCatcherCount: eyeCatchers.length }, 'HIGH');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAM C — Institutional bar move (was completely unalerted)
    // ─────────────────────────────────────────────────────────────────────────

    async onInstitutionalBarMove({ ticker, price, barMovePct, direction, volume }) {
        const absMove = Math.abs(barMovePct);
        if (absMove < INST_HIGH_BAR_MOVE_PCT) return; // below threshold — skip

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

        await this.sendAlert(msg, 'INST_MOVE', { ticker, barMovePct, direction }, tier);
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

        await this.sendAlert(msg, 'SCOUT', { ticker, type, volChange }, 'HIGH');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GHOST QUEUE — operator approval required (was completely unalerted)
    // ─────────────────────────────────────────────────────────────────────────

    async onGhostQueued({ ticker, reason }) {
        // Ghost alerts are INFO — don't spam if coin keeps bouncing into ghost territory
        if (this._isTickerOnCooldown(ticker)) return;
        this._markTickerAlerted(ticker);

        const msg =
            `👻 *GHOST QUEUE*\n` +
            `*${ticker}* needs review\n` +
            `Reason: _${reason}_\n` +
            `Approve in dashboard or it stays active.\n` +
            `\`[SYSTEM] #GHOST_PENDING\``;

        await this.sendAlert(msg, 'GHOST', { ticker, reason }, 'INFO');
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

        await this.sendAlert(msg, 'RVOL_SPIKE', { ticker, relVol }, tier);
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

            await this.sendAlert(msg, 'HEARTBEAT', {}, 'INFO');
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
