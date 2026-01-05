const db = require('../server/database'); // Ensure correct path to db export

console.log('🌱 Seeding History Data...');

// Timestamps: -30m, -20m, -10m, -5m, Now
const now = Date.now();
const timePoints = [
    now - 30 * 60 * 1000,
    now - 20 * 60 * 1000,
    now - 10 * 60 * 1000,
    now - 5 * 60 * 1000,
    now
];

// Helper to generate fake tickers
const tickers = ['BTC', 'ETH', 'SOL', 'AVAX', 'MATIC', 'ADA', 'XRP', 'DOGE'];
function getRandomTickers(count) {
    const shuffled = tickers.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count).map(t => ({
        t,
        nt: Math.floor(Math.random() * 100),
        s: Math.floor(Math.random() * 100)
    }));
}

// Transaction
const seed = db.transaction(() => {
    // Clear existing for clean test
    db.prepare('DELETE FROM scans').run();
    db.prepare('DELETE FROM market_states').run();
    db.prepare('DELETE FROM scan_entries').run();
    db.prepare('DELETE FROM pulse_events').run();

    let scanIdCounter = 1000;

    for (const ts of timePoints) {
        const id = `scan_${scanIdCounter++}`;
        const iso = new Date(ts).toISOString();

        // 1. Scan
        db.prepare('INSERT INTO scans (id, timestamp, trigger_type, latency, change_reason) VALUES (?, ?, ?, ?, ?)')
            .run(id, iso, 'auto', 1200, 'mock_seed');

        // 2. Market State
        const moodScore = Math.floor(Math.random() * 200) - 100; // -100 to 100
        const mood = moodScore > 20 ? 'BULLISH' : (moodScore < -20 ? 'BEARISH' : 'NEUTRAL');

        db.prepare(`INSERT INTO market_states (scan_id, mood, mood_score, counts_json, tickers_json) VALUES (?, ?, ?, ?, ?)`)
            .run(id, mood, moodScore, JSON.stringify({ bullish: 15, bearish: 10, neutral: 5, total: 30 }), JSON.stringify({
                bullish: getRandomTickers(3),
                bearish: getRandomTickers(2)
            }));

        // 3. Entries
        const entryCount = 5;
        for (let i = 0; i < entryCount; i++) {
            const ticker = tickers[i];
            db.prepare(`INSERT INTO scan_entries (scan_id, ticker, status, strategies_json, missed_reason, raw_data_json) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(id, ticker, 'PASS', JSON.stringify(['MOMENTUM', 'BREAKOUT']), null, JSON.stringify({
                    ticker, score: 85, netTrend: 70, status: 'PASS',
                    resistDist: Math.random() * 10, mom: Math.random() * 5, // [FIX] Added robust data for analytics
                    ema50Dist: Math.random() * 2 - 1, ema200Dist: Math.random() * 2 - 1
                }));
        }

        // 4. Pulse Events (For Analytics)
        if (ts > now - 15 * 60 * 1000) { // Only recent pulses
            db.prepare(`INSERT INTO pulse_events (id, scan_id, timestamp, ticker, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(`pulse_${scanIdCounter}`, id, ts, 'SOL', 'BULLISH', JSON.stringify({
                    asset: { ticker: 'SOL' },
                    signal: { category: 'BULLISH', price: 24.50 }
                }));
        }
    }
});

seed();
console.log('✅ Seeded 5 Scans.');
const count = db.prepare('SELECT count(*) as c FROM scans').get();
console.log('Total Scans in DB:', count.c);
