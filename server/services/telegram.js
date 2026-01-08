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

    async sendAlert(message) {
        if (!this.bot || !this.chatId || !this.isEnabled) return;

        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
            console.log('📤 Telegram Alert Sent');
        } catch (err) {
            console.error('❌ Failed to send Telegram alert:', err.message);
        }
    }

    getCoinsInFocus(db, hours = 2) {
        try {
            const cutoff = Date.now() - (hours * 60 * 60 * 1000);
            const pulses = db.prepare(`SELECT ticker, COUNT(*) as count FROM pulse_events WHERE timestamp > ? GROUP BY ticker`).all(cutoff);
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
    async syncStrategies(currentStrategies) {
        if (!this.isEnabled) return;

        // State Initialization
        if (!this.lastActiveStrategies) this.lastActiveStrategies = [];

        // 0. COMMIT STATE IMMEDIATELY (Prevent Race Conditions)
        // We capture the old state for diffing, but update the global state synchronously
        // so that any subsequent calls (ms later) see the new state and don't re-trigger.
        const oldStrategies = this.lastActiveStrategies;
        this.lastActiveStrategies = currentStrategies;

        const newIds = new Set(currentStrategies.map(s => s.id));
        const oldIds = new Set(oldStrategies.map(s => s.id));

        // 1. Detect COMPLETIONS (Removed Strategies)
        for (const oldStrat of oldStrategies) {
            if (!newIds.has(oldStrat.id)) {
                // Smart Filter: Only notify completion for major strategies, ignore 'chop' noise disappearance
                if (oldStrat.type !== 'info') {
                    const icon = oldStrat.type === 'opportunity' ? '✅' : '🏁';
                    await this.sendAlert(`${icon} **STRATEGY COMPLETED**: ${oldStrat.title}\n\nCondition has resolved or expired.`);
                }
            }
        }

        // 2. Detect NEW ACTIVATIONS (Added Strategies)
        for (const strat of currentStrategies) {
            if (!oldIds.has(strat.id)) {
                let icon = 'ℹ️';

                // Smart Logic: Formatting & Tone
                if (strat.type === 'trend') icon = '🌊';
                if (strat.type === 'opportunity') icon = '🚀';
                if (strat.type === 'risk') icon = '⚠️';
                if (strat.type === 'info') icon = '😴';

                // Compose Message
                const msg = `${icon} **NEW STRATEGY ACTIVE**: ${strat.title}\n\n${strat.description}`;

                // For High Priority, add Tickers if available
                let tickerTxt = '';
                if (strat.tickers && strat.tickers.length > 0) {
                    const tList = strat.tickers.slice(0, 5).map(t => `• ${t.ticker} (${t.bias})`).join('\n');
                    tickerTxt = `\n\n**Targets**:\n${tList}`;
                }

                await this.sendAlert(msg + tickerTxt);
            }
        }
    }
}

module.exports = new TelegramService();
