const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const db = require('../database'); // Import shared DB instance
require('dotenv').config({ path: path.join(__dirname, '../.env') });

class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.bot = null;

        // Control Flags
        // Load persisted state (Synchronous for better-sqlite3)
        try {
            const setting = db.prepare("SELECT value FROM system_settings WHERE key = 'telegram_enabled'").get();
            // Value is stored as string 'true'/'false'
            this.isEnabled = setting ? (setting.value === 'true') : true; // Default ON
        } catch (e) {
            console.warn('⚠️ Could not load Telegram settings, defaulting to ON');
            this.isEnabled = true;
        }

        this.bootTime = Date.now(); // Fresh Start Protocol

        // State Tracking for Smart Alerts
        this.lastSent = 0;
        this.lastAlertState = {
            score: 0,       // Mood score at last alert
            burstCount: 0,  // Number of alerts at last burst
            trend: null     // 'bull' or 'bear'
        };

        if (this.token && this.token !== 'YOUR_BOT_TOKEN_HERE') {
            try {
                this.bot = new TelegramBot(this.token, { polling: false });
                console.log(`✅ Telegram Service Initialized (Enabled: ${this.isEnabled})`);

                // [USER REQUEST]: Send explicit Startup Notification
                if (this.isEnabled) {
                    this.sendAlert(`🚀 **SYSTEM ONLINE**\n\nDashboard V3 is active and monitoring.\nTime: ${new Date().toLocaleTimeString()}`, 'INFO');
                }
            } catch (err) {
                console.error('❌ Telegram Init Error:', err);
            }
        } else {
            console.warn('⚠️ Telegram Token missing or invalid. Notifications disabled.');
        }
    }

    toggle(enabled) {
        this.isEnabled = enabled;
        try {
            // Persist to DB
            db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('telegram_enabled', ?)").run(enabled.toString());
            console.log(`[Telegram] Notifications ${enabled ? 'ENABLED' : 'DISABLED'} (Persisted)`);
        } catch (e) {
            console.error('Failed to persist Telegram setting:', e);
        }
        return this.isEnabled;
    }

    async sendAlert(message, level = 'INFO', meta = {}) {
        // 1. ALWAYS Log to History (TLog) - as per User Request
        try {
            const timestamp = new Date().toISOString();
            db.prepare(`
                INSERT INTO telegram_logs (timestamp, level, message, meta_json)
                VALUES (?, ?, ?, ?)
            `).run(timestamp, level, message, JSON.stringify(meta));
        } catch (dbErr) {
            console.error('❌ Failed to write TLog:', dbErr.message);
        }

        // 2. Control Gate: Only send to Telegram if Enabled
        if (!this.bot || !this.chatId || !this.isEnabled) return;

        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
            this.lastSent = Date.now();
            console.log('📤 Telegram Alert Sent');
        } catch (err) {
            console.error('❌ Failed to send Telegram alert:', err.message);
        }
    }

    getLogs(limit = 100) {
        try {
            return db.prepare('SELECT * FROM telegram_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
        } catch (e) {
            console.error('Failed to fetch TLogs:', e);
            return [];
        }
    }

    getCoinsInFocus(db, hours = 2) {
        try {
            const cutoff = new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
            const pulses = db.prepare(`SELECT ticker, COUNT(*) as count FROM unified_alerts WHERE timestamp > ? GROUP BY ticker`).all(cutoff);
            const scores = {};
            pulses.forEach(p => scores[p.ticker] = (scores[p.ticker] || 0) + (p.count * 1));
            return Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, s]) => `${t} (${s})`);
        } catch (err) { return []; }
    }

    /**
     * Core Logic: Replicates "AlertsAnalyzer.jsx" / "Strategy Engine"
     * SMART DEDUPLICATION: Compare against this.lastAlertState to prevent spam.
     */
    // Unified Strategy Sync (Direct from Engine)
    async syncStrategies(currentStrategies, marketSentiment, scenarios = null) {
        // NOTE: We do NOT return early here based on isEnabled.
        // We proceed to process logic so we can LOG the events.
        // The gate is inside sendAlert().

        // State Initialization
        if (!this.lastActiveStrategies) this.lastActiveStrategies = [];
        if (!this.cooldownMap) this.cooldownMap = new Map(); // Key: StrategyID, Value: Timestamp

        const oldStrategies = this.lastActiveStrategies;
        this.lastActiveStrategies = currentStrategies;

        const newIds = new Set(currentStrategies.map(s => s.id));
        const oldMap = new Map(oldStrategies.map(s => [s.id, s]));

        // 1. Detect COMPLETIONS (Removed Strategies)
        for (const oldStrat of oldStrategies) {
            if (!newIds.has(oldStrat.id)) {
                // Ignore boring "Info" exits
                if (oldStrat.type !== 'info') {
                    // console.log(`[Telegram] Strategy Exit: ${oldStrat.title}`);
                    // Optional: Send exit alert? For now, silence is golden.
                }
            }
        }

        // 2. Detect NEW ACTIVATIONS & UPDATES
        for (const strat of currentStrategies) {
            // FILTER: Suppress Low-Value "Info" strategies (Chop Warnings)
            if (strat.type === 'info') continue;

            const isNew = !oldMap.has(strat.id);
            const oldStrat = oldMap.get(strat.id);

            // Check for Significant Change (Ticker Count Changed)
            let isUpdate = false;
            let tickerHash = strat.tickers ? strat.tickers.map(t => t.ticker).sort().join(',') : '';
            if (!isNew && oldStrat) {
                let oldHash = oldStrat.tickers ? oldStrat.tickers.map(t => t.ticker).sort().join(',') : '';
                if (tickerHash !== oldHash) isUpdate = true;
            }

            // THROTTLING LOGIC (10 Minute Cooldown)
            const now = Date.now();
            const lastSent = this.cooldownMap.get(strat.id) || 0;
            const COOLDOWN_MS = 10 * 60 * 1000; // 10 Minutes

            // Strict Anti-Spam: Unless it's a brand new strategy, enforce the cooldown.
            // Small updates to the ticker list will be ignored until the cooldown expires.
            if (!isNew && (now - lastSent < COOLDOWN_MS)) {
                // console.log(`[Telegram] Throttled: ${strat.title} (Cooldown active)`);
                continue;
            }

            if (isNew || isUpdate) {
                // If it's an update, but the cooldown has expired, we process it and reset the timer.
                this.cooldownMap.set(strat.id, now);

                let icon = 'ℹ️';
                if (strat.type === 'trend') icon = '🌊';
                if (strat.type === 'opportunity') icon = '🚀';
                if (strat.type === 'risk') icon = '⚠️';

                let titlePrefix = isNew ? "NEW OPPORTUNITY" : "UPDATE";

                // --- BUILD HEADER (Mood & Splits) ---
                let header = '';
                if (marketSentiment) {
                    const { moodScore, mood, bullish, bearish, neutral } = marketSentiment;
                    const moodIcon = moodScore >= 20 ? '🟢' : (moodScore <= -20 ? '🔴' : '🟡');
                    const moodLabel = mood || (moodScore >= 20 ? 'BULLISH' : (moodScore <= -20 ? 'BEARISH' : 'NEUTRAL'));

                    header = `\n━━━━━━━━━━━━━━\n` +
                        `🔮 **GENIE MOOD**: ${moodIcon} ${moodLabel} (${moodScore})\n`;

                    // Add Plan Context if available
                    if (scenarios && scenarios.marketCheck) {
                        header += `🎯 **GAME PLAN**: ${moodScore > 0 ? 'Plan A (Longs)' : 'Plan B (Shorts)'}\n`;
                    }

                    // [VISUAL UPGRADE] ASCII Gauge
                    // Range: -100 to +100. Map to 10 bars.
                    // Bearish (-100 to 0) | Bullish (0 to 100)
                    const totalBars = 12;
                    const normalized = Math.min(Math.max(moodScore, -100), 100); // Clamp
                    const percent = (normalized + 100) / 200; // 0 to 1
                    const filled = Math.round(percent * totalBars);

                    const bar = '▓'.repeat(filled) + '░'.repeat(totalBars - filled);
                    header += `\`[${bar}]\`\n`;

                    header += `━━━━━━━━━━━━━━\n`;
                }

                // Compose Message
                const msg = `${icon} **${titlePrefix}**: ${strat.title}\n${header}\n${strat.description}`;

                // --- FULL TICKER LIST (Splitting if too long) ---
                let tickerTxt = '';
                const MAX_MSG_LENGTH = 3800; // Leave buffer for header

                if (strat.tickers && strat.tickers.length > 0) {
                    const tList = strat.tickers.map(t => {
                        const bias = t.bias || (t.desc ? t.desc : '');
                        return `• **${t.ticker}** ${bias ? 'via ' + bias : ''}`;
                    });

                    // Check if we need to split
                    // Crude check: Avg line 40 chars. 
                    let currentChunk = [];
                    let currentLen = 0;

                    // Send Header + First Chunk
                    // If list is massive, we iterate

                    // Strategy:
                    // 1. Build Header Message
                    // 2. Append as many tickers as fit
                    // 3. Send.
                    // 4. If tickers remain, send "Continued..." messages.

                    const fullListString = tList.join('\n');
                    const totalLen = msg.length + fullListString.length;

                    if (totalLen < MAX_MSG_LENGTH) {
                        // Fits in one
                        tickerTxt = `\n\n**Candidates (${strat.tickers.length})**:\n${fullListString}`;
                        await this.sendAlert(msg + tickerTxt, isNew ? 'ALERT' : 'UPDATE', { type: isNew ? 'NEW' : 'UPDATE', strategy: strat });
                    } else {
                        // Needs splitting
                        // Send Header First with summary
                        await this.sendAlert(`${msg}\n\n**Candidates (${strat.tickers.length})**:\n(List too long, splitting...)`, isNew ? 'ALERT' : 'UPDATE');

                        // Chunk the list
                        let chunk = '';
                        for (const line of tList) {
                            if (chunk.length + line.length > MAX_MSG_LENGTH) {
                                await this.sendAlert(chunk, 'INFO'); // Continuation
                                chunk = '';
                            }
                            chunk += line + '\n';
                        }
                        if (chunk.length > 0) {
                            await this.sendAlert(chunk, 'INFO');
                        }
                    }
                } else {
                    // No tickers, just message
                    await this.sendAlert(msg, isNew ? 'ALERT' : 'UPDATE', { type: isNew ? 'NEW' : 'UPDATE', strategy: strat });
                }
            }
        }
    }
}

module.exports = new TelegramService();
