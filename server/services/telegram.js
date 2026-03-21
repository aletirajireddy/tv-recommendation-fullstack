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
        // Track global last sent for the anti-spam throttle
        if (!this.lastGlobalAlertTime) this.lastGlobalAlertTime = 0;
        if (!this.knownTickers) this.knownTickers = new Set();
        
        const now = Date.now();
        const COOLDOWN_MS = 15 * 60 * 1000; // 15 Minutes minimum between pulses
        
        // 1. Extract all CURRENT active tickers across all meaningful strategies
        const currentTickers = new Set();
        const eyeCatchers = []; // Keep rich metadata for the alert
        
        for (const strat of currentStrategies) {
            if (strat.type === 'info') continue; // Skip boring stuff
            if (!strat.tickers) continue;
            
            for (const t of strat.tickers) {
                currentTickers.add(t.ticker);
                
                // If it's a completely new ticker we haven't seen before, it's a Catalyst!
                if (!this.knownTickers.has(t.ticker)) {
                    eyeCatchers.push({
                        ticker: t.ticker,
                        strategy: strat.title,
                        type: strat.type,
                        bias: t.bias || ''
                    });
                }
            }
        }
        
        // 2. Update Known Tickers Memory (Self-Healing memory)
        // We replace it entirely so if a coin drops out, it can re-trigger later
        this.knownTickers = currentTickers;
        
        // 3. EVENT GATE: Are there any new Eye-Catchers?
        if (eyeCatchers.length === 0) {
            return; // No new catalysts, stay totally silent
        }
        
        // 4. SPAM GATE: Has the 15-minute global cooldown elapsed?
        if (now - this.lastGlobalAlertTime < COOLDOWN_MS) {
            // Suppressing Pulse because Cooldown is Active. 
            // The memory already absorbed the coins, so we don't spam them when the gate opens later.
            return; 
        }
        
        // --- WE HAVE PASSED ALL GATES. COMPOSE THE MASTER AI PAYLOAD ---
        this.lastGlobalAlertTime = now;
        
        // A. Header: Market Score & Mood
        let header = `🚀 **GENIE AI MARKET PULSE**\n━━━━━━━━━━━━━━\n`;
        if (marketSentiment) {
            const { moodScore, mood, bullish, bearish, neutral } = marketSentiment;
            const moodIcon = moodScore >= 20 ? '🟢' : (moodScore <= -20 ? '🔴' : '🟡');
            const moodLabel = mood || (moodScore >= 20 ? 'BULLISH' : (moodScore <= -20 ? 'BEARISH' : 'NEUTRAL'));

            header += `🔮 **MOOD**: ${moodIcon} ${moodLabel} (${moodScore})\n`;
            header += `⚖️ **BREADTH**: 📈 ${bullish} | 📉 ${bearish} | ➖ ${neutral}\n`;
            
            const totalBars = 12;
            const normalized = Math.min(Math.max(moodScore, -100), 100); 
            const percent = (normalized + 100) / 200; 
            const filled = Math.round(percent * totalBars);
            const bar = '▓'.repeat(filled) + '░'.repeat(totalBars - filled);
            header += `\`[${bar}]\`\n`;
            header += `━━━━━━━━━━━━━━\n\n`;
        }

        // B. Catalysts: Eye Catching Coins
        let msg = header + `🎯 **NEW EYE-CATCHERS (${eyeCatchers.length})**:\n`;
        
        // De-duplicate the display list in case multiple strats hit the same coin simultaneously
        const displayed = new Set();
        for (const c of eyeCatchers) {
            if (displayed.has(c.ticker)) continue;
            displayed.add(c.ticker);
            const icon = c.type === 'opportunity' ? '⚡' : (c.type === 'risk' ? '⚠️' : '🌊');
            msg += `• ${icon} **${c.ticker}** _(${c.strategy})_ ${c.bias}\n`;
        }
        
        // C. Scenarios: Current Game Plan
        if (scenarios) {
            msg += `\n📝 **MARKET GAME PLAN**\n`;
            if (scenarios.planA && scenarios.planA.length > 0) {
                const planATickers = scenarios.planA.map(p => p.ticker).join(', ');
                msg += `🟢 **Plan A (Longs)**: ${planATickers}\n`;
            }
            if (scenarios.planB && scenarios.planB.length > 0) {
                const planBTickers = scenarios.planB.map(p => p.ticker).join(', ');
                msg += `🔴 **Plan B (Shorts)**: ${planBTickers}\n`;
            }
        }
        
        msg += `\n_Throttled Broadcast: 15min cooldown engaged._`;

        // D. Dispatch the single Pulse
        await this.sendAlert(msg, 'AI_PULSE', { eyeCatcherCount: eyeCatchers.length });
    }
}

module.exports = new TelegramService();
