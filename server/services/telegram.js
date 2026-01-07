const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.bot = null;
        this.lastSent = 0;
        this.RATE_LIMIT_MS = 60 * 1000; // Max 1 message per minute to avoid spam

        if (this.token && this.token !== 'YOUR_BOT_TOKEN_HERE') {
            try {
                this.bot = new TelegramBot(this.token, { polling: false });
                console.log('✅ Telegram Service Initialized');
            } catch (err) {
                console.error('❌ Telegram Init Error:', err);
            }
        } else {
            console.warn('⚠️ Telegram Token missing or invalid. Notifications disabled.');
        }
    }

    async sendAlert(message) {
        if (!this.bot || !this.chatId) return;

        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
            console.log('📤 Telegram Alert Sent');
        } catch (err) {
            console.error('❌ Failed to send Telegram alert:', err.message);
        }
    }

    /**
     * Core Logic: Replicates "AlertsAnalyzer.jsx" / "Strategy Engine"
     * Checks DB for High Confidence setup in the specific scan ID
     */
    async analyzeAndNotify(db, scanId) {
        if (!this.bot) return;

        // Rate Limit Check
        const now = Date.now();
        if (now - this.lastSent < this.RATE_LIMIT_MS) {
            console.log('⏳ Telegram Rate Limit (Skipping)');
            return;
        }

        try {
            // 1. Get Scan Metadata (Mood)
            const sentiment = db.prepare('SELECT * FROM market_states WHERE scan_id = ?').get(scanId);
            if (!sentiment) return;
            const moodScore = sentiment.mood_score || 0;

            // 2. Get Bursts (Pulse)
            const alerts = db.prepare('SELECT * FROM pulse_events WHERE scan_id = ?').all(scanId);

            // 3. Get High Scope Entries
            const highScope = db.prepare(`
                SELECT ticker, raw_data_json 
                FROM scan_entries 
                WHERE scan_id = ? AND status = 'PASS'
            `).all(scanId);

            let message = '';

            // --- STRATEGY 1: EXTREME MOOD ---
            if (moodScore > 60) {
                message += `🚀 **EXTREME BULLISH MOMENTUM**\nSentiment: +${moodScore}%\nReview Long Setups.\n\n`;
            } else if (moodScore < -60) {
                message += `📉 **EXTREME BEARISH PRESSURE**\nSentiment: ${moodScore}%\nReview Short Setups.\n\n`;
            }

            // --- STRATEGY 2: INSTITUTIONAL BURST ---
            if (alerts.length >= 5) {
                const uniqueTickers = new Set(alerts.map(a => a.ticker));
                message += `⚡ **INSTITUTIONAL ACTIVITY SPIKE**\n${alerts.length} alerts detected on ${uniqueTickers.size} assets.\n`;
                // Add top 3 tickers
                const top3 = Array.from(uniqueTickers).slice(0, 3).join(', ');
                message += `Active: ${top3}...\n\n`;
            }

            // --- STRATEGY 3: HIGH SCOPE CONFIDENCE ---
            const topPicks = [];
            for (const entry of highScope) {
                const raw = JSON.parse(entry.raw_data_json || '{}');
                // Replicate "High Scope" logic: Resist > 5% AND NetTrend > 20
                if ((raw.resistDist || 0) > 4.0 && (raw.netTrend || 0) > 20) {
                    topPicks.push(`${entry.ticker} (+${(raw.resistDist || 0).toFixed(1)}%)`);
                }
            }

            if (topPicks.length > 0) {
                message += `🎯 **HIGH SCOPE OPPORTUNITIES**\n${topPicks.slice(0, 3).join('\n')}\n`;
            }

            // SEND IF CONTENT EXISTS
            if (message) {
                const header = `🤖 **AI STRATEGY ENGINE**\n${new Date().toLocaleString()}\n\n`;
                await this.sendAlert(header + message);
                this.lastSent = now;
            }

        } catch (err) {
            console.error('❌ Strategy Engine Error:', err);
        }
    }
}

module.exports = new TelegramService();
