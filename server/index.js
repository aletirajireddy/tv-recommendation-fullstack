const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database');
const path = require('path');
const dayjs = require('dayjs');
require('dotenv').config();
const TelegramService = require('./services/telegram');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---------------------------------------------------------
// WebSocket Logic
// ---------------------------------------------------------
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
});

// ---------------------------------------------------------
// V2 API Routes
// ---------------------------------------------------------

// RETENTION POLICY (98 Hours)
const RETENTION_HOURS = 98;
function cleanupOldData() {
    try {
        const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();
        const result = db.prepare('DELETE FROM scans WHERE timestamp < ?').run(cutoff);
        if (result.changes > 0) {
            console.log(`🧹 Cleanup: Removed ${result.changes} scans older than ${RETENTION_HOURS}h.`);
        }
    } catch (err) {
        console.error('Cleanup Error:', err);
    }
}
// Run cleanup every hour and on startup
setInterval(cleanupOldData, 60 * 60 * 1000);
cleanupOldData();

// 1. INGEST SCAN (Master Handler)
app.post('/scan-report', (req, res) => {
    const payload = req.body;
    console.log(`[POST] /scan-report | ID: ${payload.id} | Trigger: ${payload.trigger}`);

    try {
        const saveTransaction = db.transaction(() => {
            // A. MASTER SCAN
            db.prepare(`
                INSERT INTO scans (id, timestamp, trigger_type, latency, change_reason)
                VALUES (@id, @timestamp, @trigger, @latency, @reason)
            `).run({
                id: payload.id,
                timestamp: payload.timestamp,
                trigger: payload.trigger,
                latency: payload.metadata ? payload.metadata.timeSinceLastSend : null,
                reason: payload.metadata ? payload.metadata.changeReason : null
            });

            // B. MARKET SENTIMENT (Section 4)
            if (payload.market_sentiment) {
                const ms = payload.market_sentiment;
                db.prepare(`
                    INSERT INTO market_states (scan_id, mood, mood_score, counts_json, tickers_json)
                    VALUES (@id, @mood, @score, @counts, @tickers)
                `).run({
                    id: payload.id,
                    mood: ms.mood,
                    score: ms.moodScore,
                    counts: JSON.stringify({
                        bullish: ms.bullish,
                        bearish: ms.bearish,
                        neutral: ms.neutral,
                        total: ms.totalCoins
                    }),
                    tickers: JSON.stringify(ms.tickers || {})
                });
            }

            // C. SCAN RESULTS (Section 2)
            if (payload.results && Array.isArray(payload.results)) {
                const insertEntry = db.prepare(`
                    INSERT INTO scan_entries (scan_id, ticker, status, strategies_json, missed_reason, raw_data_json, label, direction)
                    VALUES (@scanId, @ticker, @status, @strategies, @missed, @raw, @label, @direction)
                `);

                for (const item of payload.results) {
                    insertEntry.run({
                        scanId: payload.id,
                        ticker: item.ticker,
                        status: item.status,
                        strategies: JSON.stringify(item.matchedStrategies || []),
                        missed: item.missedReason,
                        raw: JSON.stringify(item),
                        label: item.label || null,
                        direction: item.direction || null
                    });
                }
            }

            // D. PULSE EVENTS (Section 1)
            if (payload.institutional_pulse && payload.institutional_pulse.alerts) {
                const insertPulse = db.prepare(`
                    INSERT OR IGNORE INTO pulse_events (id, scan_id, timestamp, ticker, type, payload_json)
                    VALUES (@id, @scanId, @ts, @ticker, @type, @json)
                `);

                for (const alert of payload.institutional_pulse.alerts) {
                    insertPulse.run({
                        id: alert.id,
                        scanId: payload.id,
                        ts: alert.timestamp,
                        ticker: alert.asset ? alert.asset.ticker : 'UNKNOWN',
                        type: alert.signal ? alert.signal.category : 'UNKNOWN',
                        json: JSON.stringify(alert)
                    });
                }
            }
        });

        // EXECUTE
        saveTransaction();

        // SOCKET BROADCAST
        // Send lightweight update so frontend can update Timeline instantly
        const broadcastPayload = {
            id: payload.id,
            timestamp: payload.timestamp,
            trigger_type: payload.trigger,
            mood: payload.market_sentiment ? payload.market_sentiment.mood : 'NEUTRAL',
            mood_score: payload.market_sentiment ? payload.market_sentiment.moodScore : 0
        };
        io.emit('new_scan', broadcastPayload);

        console.log(`✅ Scan ${payload.id} Persisted & Broadcasted.`);



        res.json({ status: 'ok', id: payload.id });

    } catch (err) {
        console.error('❌ Insert Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. TIMELINE (Time Machine)
app.get('/api/history', (req, res) => {
    try {
        // DYNAMIC WINDOW SUPPORT
        const hours = parseFloat(req.query.hours) || 24; // Default to 24h if not specified (though frontend sends it)

        // 1. Determine Anchor (Same robust logic as /pulse)
        // 1. Determine Anchor (Same robust logic as /pulse)
        const lastScan = db.prepare('SELECT MAX(timestamp) as last FROM scans').get();
        // timestamp is TEXT (ISO), so we must convert to MS for Math.max
        const lastTs = lastScan?.last ? new Date(lastScan.last).getTime() : Date.now();
        const systemNow = Date.now();
        const anchorTime = Math.max(lastTs || 0, systemNow);

        // 2. Calculate Cutoff
        const cutoff = new Date(anchorTime - (hours * 60 * 60 * 1000)).toISOString();

        const timeline = db.prepare(`
            SELECT 
                s.id, s.timestamp, s.trigger_type, 
                m.mood, m.mood_score
            FROM scans s
            LEFT JOIN market_states m ON s.id = m.scan_id
            WHERE s.timestamp >= ?
            ORDER BY s.timestamp ASC
        `).all(cutoff);

        res.json(timeline);
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ error: error.message });
    }
});

// 1. ANALYTICS (Pulse & Strategy Insights)
app.get('/api/analytics/pulse', (req, res) => {
    try {
        const hours = parseFloat(req.query.hours) || 24;

        // 1. DETERMINE TIME ANCHOR
        const refTime = req.query.refTime ? new Date(req.query.refTime).getTime() : null;
        let anchorTime;

        if (refTime && !isNaN(refTime)) {
            // User specified a "Replay Time"
            anchorTime = refTime;
        } else {
            // Default: Snap to "Now" or Last Data (Live Mode)
            const lastEvent = db.prepare('SELECT MAX(timestamp) as last FROM pulse_events').get();
            const lastTs = lastEvent?.last ? new Date(lastEvent.last).getTime() : Date.now();
            const systemNow = Date.now();
            anchorTime = Math.max(lastTs, systemNow);
        }

        const cutoff = dayjs(anchorTime).subtract(hours, 'hour').toISOString();

        // Fetch Pulses in Window
        const pulses = db.prepare('SELECT * FROM pulse_events WHERE timestamp >= ? ORDER BY timestamp DESC').all(cutoff);

        // --- 1. TIME SPREAD ANALYSIS ---
        // Group by 5-minute windows
        const timeMap = new Map(); // Key: "10:00 AM" -> { count, coins: Set, timePoints: [], events: [] }
        const signalsMap = new Map(); // Key: Ticker -> { count, sumMom, biasScore }

        pulses.forEach(p => {
            const date = dayjs(p.timestamp);
            if (!date.isValid()) return; // Skip invalid dates

            // Format to nearest 5 min
            const minutes = Math.floor(date.minute() / 5) * 5;
            const keyTime = date.minute(minutes).second(0).millisecond(0);
            const timeStr = keyTime.format('HH:mm');

            if (!timeMap.has(timeStr)) {
                timeMap.set(timeStr, {
                    count: 0,
                    coins: new Set(),
                    bullish: 0,
                    bearish: 0,
                    timestamps: [], // to calc spread duration
                    events: [], // for timeline
                    momAcc: 0 // momentum accumulator
                });
            }

            const group = timeMap.get(timeStr);
            const payload = JSON.parse(p.payload_json || '{}');
            const ticker = p.ticker || 'UNK';

            group.count++;
            group.coins.add(ticker);
            group.timestamps.push(p.timestamp);

            // Bias Detection (Comprehensive)
            let isBull = false;
            let isBear = false;

            if (payload.signal) {
                const cat = payload.signal.category || '';
                const mom = payload.signal.momentum_pct;
                const d = payload.signal.d || payload.signal.di;

                // Explicit Categories
                if (cat === 'BULLISH') isBull = true;
                else if (cat === 'BEARISH') isBear = true;

                // Implicit via Momentum/Direction
                else {
                    if (mom > 0 || d > 0) isBull = true;
                    else if (mom < 0 || d < 0) isBear = true;
                }
            }

            // Fallback: Check raw text or type if signal is inconclusive
            if (!isBull && !isBear) {
                const rawText = (p.raw || '').toUpperCase();
                const pType = (p.type || '').toUpperCase();

                if (rawText.includes('LONG') || rawText.includes('BULL') || pType.includes('BULL')) isBull = true;
                else if (rawText.includes('SHORT') || rawText.includes('BEAR') || pType.includes('BEAR')) isBear = true;
                // Check payload description if available
                else if (payload.desc && payload.desc.toUpperCase().includes('LONG')) isBull = true;
                else if (payload.desc && payload.desc.toUpperCase().includes('SHORT')) isBear = true;
            }

            if (isBull) group.bullish++;
            if (isBear) group.bearish++;

            // Momentum (Safe Extraction attempt)
            // Prioritize 'signal.momentum_pct' (New Schema), fall back to 'asset.momentum' (Old)
            let rawMom = 0;
            if (payload.signal && payload.signal.momentum_pct !== undefined) {
                rawMom = parseFloat(payload.signal.momentum_pct);
            } else if (payload.asset && payload.asset.momentum !== undefined) {
                rawMom = parseFloat(payload.asset.momentum);
            }

            group.momAcc += rawMom;

            // Timeline Event
            const pTime = date.format('HH:mm:ss');

            group.events.push(`${ticker} ${pTime}`);

            // --- AGGREGATE SIGNALS FOR SCATTER PLOT ---
            // We want to map: X=Momentum, Y=Intensity (Count/Quality)
            if (!signalsMap.has(ticker)) {
                signalsMap.set(ticker, {
                    ticker,
                    count: 0,
                    sumMom: 0,
                    biasScore: 0,
                    lastTime: pTime
                });
            }
            const sig = signalsMap.get(ticker);
            sig.count++;
            sig.sumMom += rawMom;
            sig.biasScore += (isBull ? 1 : (isBear ? -1 : 0));
        });

        // Convert Signals Map to Array
        const signals = Array.from(signalsMap.values()).map(s => {
            const avgMom = s.count > 0 ? s.sumMom / s.count : 0;
            const intensity = Math.min(s.count * 10, 100); // Scale count to 0-100 score
            const netBias = s.biasScore > 0 ? 'BULLISH' : (s.biasScore < 0 ? 'BEARISH' : 'NEUTRAL');

            return {
                ticker: s.ticker,
                x: parseFloat(avgMom.toFixed(2)),
                y: intensity,
                bias: netBias,
                volSpike: s.count > 5 // Highlight high frequency
            };
        });

        // --- 2. INSIGHT ENGINE (Pattern Recognition) ---
        // Identify "Institutional Bursts" (High Density)
        const bursts = [];
        const spreadAnalysis = Array.from(timeMap.entries()).map(([keyTimeStr, d]) => {
            // 1. Calc Basic Metrics
            d.timestamps.sort((a, b) => (dayjs(a).valueOf() - dayjs(b).valueOf())); // Safe Sort

            const start = dayjs(d.timestamps[0]);
            const end = dayjs(d.timestamps[d.timestamps.length - 1]);
            const durationMs = end.diff(start);

            const spreadStr = durationMs > 0 ? (durationMs < 60000 ? `${Math.floor(durationMs / 1000)}s` : `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`) : 'Instant';

            const density = d.count / 5;
            const unique = d.coins.size;

            // 2. Format Date/Time (Universal)
            // Use START of cluster for label
            let dateObj = dayjs(d.timestamps[0]);
            if (!dateObj.isValid()) dateObj = dayjs();
            const fullTimeStr = dateObj.format('MM/DD HH:mm');

            // 3. Calc Mood
            const total = d.bullish + d.bearish;
            const moodScore = total > 0 ? Math.round(((d.bullish - d.bearish) / total) * 100) : 0;

            // 4. Derive Cluster & Wave Type
            let waveType = 'Isolated Flow';
            if (d.count >= 8) waveType = 'Burst Cluster';
            else if (d.count >= 4) waveType = 'Broad Flow';
            else if (unique === 1 && d.count > 1) waveType = 'Scalp Cluster';

            // 5. Populate Bursts (Now safe to use fullTimeStr)
            if (waveType === 'Burst Cluster' || waveType === 'Broad Flow' || d.count >= 5) {
                bursts.push({
                    time: fullTimeStr,
                    full_ts: d.timestamps[0],
                    count: d.count,
                    coins: Array.from(d.coins),
                    bias: d.bullish > d.bearish ? 'BULL' : 'BEAR'
                });
            }

            // 6. Timeline Events
            const sortedEvents = [...d.events].reverse();

            return {
                time: fullTimeStr,
                full_ts: d.timestamps[0],
                count: d.count,
                bullish: d.bullish,
                bearish: d.bearish,
                unique_coins: unique,
                spread: spreadStr,
                density: density.toFixed(2),
                cluster: d.count > 3 ? (d.count > 8 ? 'BURST' : 'STEADY') : 'ISOLATED',
                bias: d.bullish > d.bearish ? 'BULL' : (d.bearish > d.bullish ? 'BEAR' : 'NEUTRAL'),
                si: `${d.bullish}/${d.count}`,
                mon_pct: (d.momAcc / (d.count || 1)).toFixed(2) + '%',
                mood_score: moodScore,
                wave_type: waveType,
                timeline: sortedEvents.join(', ')
            };
        });

        // SORT BY TIME DESC (Recent First)
        spreadAnalysis.sort((a, b) => b.full_ts - a.full_ts);


        // 3. PREDICTIONS (Scope & Confluence)
        // ... (Keep existing Logic 200-234 roughly same but ensure context) ...
        const predictions = [];
        const latestScan = db.prepare('SELECT id FROM scans ORDER BY timestamp DESC LIMIT 1').get();
        if (latestScan) {
            const entries = db.prepare('SELECT ticker, raw_data_json FROM scan_entries WHERE scan_id = ?').all(latestScan.id);
            for (const entry of entries) {
                const raw = JSON.parse(entry.raw_data_json || '{}');
                const ticker = entry.ticker;

                // Logic 1: HIGH SCOPE
                if ((raw.resistDist || 0) > 5.0 && (raw.netTrend || 0) > 20) {
                    predictions.push({
                        type: 'HIGH_SCOPE',
                        coin: ticker,
                        confidence: 'High',
                        reason: `${(raw.resistDist || 0).toFixed(1)}% Room + Strong Momentum`
                    });
                }

                // Logic 2: NEURAL CONFLUENCE
                // Check if this ticker was in recent pulses (filtered by lookback "hours")
                const hasRecentAlert = pulses.some(p => p.ticker === ticker);
                if (hasRecentAlert && (Math.abs(raw.ema50Dist || 100) < 1.0 || Math.abs(raw.ema200Dist || 100) < 1.0)) {
                    predictions.push({
                        type: 'NEURAL_CONFLUENCE',
                        coin: ticker,
                        confidence: 'Max',
                        reason: 'Institutional Alert + EMA Touch'
                    });
                }
            }
        }

        // 2b. FORMAT BURSTS FOR INSIGHTS
        // Sort Bursts: Newest First
        bursts.sort((a, b) => b.full_ts - a.full_ts);
        // Note: 'bursts' populated in loop above. We need to capture full_ts in the loop for safe sorting or rely on timeMap order (usually safe but explicit is better).
        // Let's rely on map order for now or just add timestamp to burst object in the loop.

        const insightStrings = bursts.map(b =>
            `${b.time}: ${b.count} Alerts on ${b.coins.length} Assets (${b.bias})`
        );

        // 4. GENERATE RECOMMENDATIONS (AI Strategy Cards)
        // 4. GENERATE RECOMMENDATIONS (AI Strategy Cards)
        const recommendations = [];

        // Card 1: Market Momentum Strategy
        if (spreadAnalysis.length > 0) {
            const avgMood = spreadAnalysis.reduce((acc, s) => acc + (s.mood_score || 0), 0) / spreadAnalysis.length;
            if (avgMood > 40) {
                recommendations.push({
                    id: 'STRAT_TREND_BULL', // Deterministic ID
                    type: 'trend',
                    confidence: 'high',
                    title: 'Strong Bullish Momentum',
                    description: `Market sentiment is at +${avgMood.toFixed(0)}%. Trend-following systems active.`,
                    tickers: []
                });
            } else if (avgMood < -40) {
                recommendations.push({
                    id: 'STRAT_TREND_BEAR', // Deterministic ID
                    type: 'risk',
                    confidence: 'high',
                    title: 'Bearish Pressure Alert',
                    description: `Market sentiment is at ${avgMood.toFixed(0)}%. Caution advised.`,
                    tickers: []
                });
            }
        }

        // Card 2: Institutional Burst Opportunities
        if (bursts.length > 0) {
            const topBurst = bursts[0];
            // ID includes time to be unique per burst event, but stable for that specific burst
            // topBurst.full_ts is the timestamp of the burst
            recommendations.push({
                id: `STRAT_BURST_${topBurst.full_ts}`,
                type: 'opportunity',
                confidence: 'max',
                title: 'Institutional Activity Spike',
                description: `${topBurst.count} alerts detected at ${topBurst.time} across ${topBurst.coins.length} assets. Watch for follow-through.`,
                tickers: topBurst.coins.slice(0, 5).map(c => ({ ticker: c, bias: topBurst.bias }))
            });
        }

        // Card 3: High Scope Opportunities
        if (latestScan) {
            const highScopeAssets = db.prepare(`
                SELECT ticker, raw_data_json
                FROM scan_entries
                WHERE scan_id = ? AND status = 'PASS'
                ORDER BY json_extract(raw_data_json, '$.score') DESC
                LIMIT 5
            `).all(latestScan.id);

            if (highScopeAssets.length > 0) {
                recommendations.push({
                    id: 'STRAT_HIGH_SCOPE', // Deterministic ID
                    type: 'opportunity',
                    confidence: 'high',
                    title: 'High-Quality Setups',
                    description: `${highScopeAssets.length} assets passed all filters with strong confluence metrics.`,
                    tickers: highScopeAssets.map(a => {
                        const raw = JSON.parse(a.raw_data_json || '{}');
                        return { ticker: a.ticker, bias: raw.netTrend > 0 ? 'LONG' : 'SHORT' };
                    })
                });
            }
        }

        // Card 4: Chop Warning
        if (spreadAnalysis.length > 0) {
            const recentWindows = spreadAnalysis.slice(0, 3);
            const hasChop = recentWindows.every(w => Math.abs(w.mood_score || 0) < 20);
            if (hasChop) {
                recommendations.push({
                    id: 'STRAT_CHOP_WARNING', // Deterministic ID
                    type: 'info',
                    confidence: 'medium',
                    title: 'Low Conviction Environment',
                    description: 'Mixed signals with no clear directional bias. Reduce position sizes.',
                    tickers: []
                });
            }
        }

        // Calculate Volume Intent from actual data
        const totalBullish = spreadAnalysis.reduce((sum, s) => sum + s.bullish, 0);
        const totalBearish = spreadAnalysis.reduce((sum, s) => sum + s.bearish, 0);

        // SYNC TELEGRAM with Strategy Engine
        // This ensures alerts match the UI cards exactly
        TelegramService.syncStrategies(recommendations);

        res.json({
            lookback_hours: hours,
            time_spread: spreadAnalysis,
            volume_intent: { bullish: totalBullish, bearish: totalBearish },
            predictions: [],
            signals: signals, // Dynamic Scatter Plot Data
            recommendations: recommendations,
            insights: insightStrings,
            total_alerts: pulses.length
        });
    } catch (err) {
        console.error('Analytics Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 3. REPLAY STATE
app.get('/api/scan/:id', (req, res) => {
    try {
        const { id } = req.params;

        const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
        if (!scan) return res.status(404).json({ error: 'Scan not found' });

        const sentiment = db.prepare('SELECT * FROM market_states WHERE scan_id = ?').get(id);
        if (sentiment) {
            sentiment.counts = JSON.parse(sentiment.counts_json || '{}');
            sentiment.tickers = JSON.parse(sentiment.tickers_json || '{}');
            delete sentiment.counts_json;
            delete sentiment.tickers_json;
        }

        const entries = db.prepare('SELECT * FROM scan_entries WHERE scan_id = ?').all(id);
        const results = entries.map(e => ({
            ...JSON.parse(e.raw_data_json || '{}'),
            status: e.status,
            missedReason: e.missed_reason
        }));

        const alerts = db.prepare('SELECT * FROM pulse_events WHERE scan_id = ?').all(id);
        const pulse = {
            alerts: alerts.map(a => JSON.parse(a.payload_json || '{}'))
        };

        res.json({
            id: scan.id,
            timestamp: scan.timestamp,
            trigger: scan.trigger_type,
            results: results,
            market_sentiment: sentiment,
            institutional_pulse: pulse
        });

    } catch (error) {
        console.error(`Error loading scan ${req.params.id}:`, error);
        res.status(500).json({ error: error.message });
    }
});




// 4. RESEARCH ANALYTICS (The "Jet Dashboard")
app.get('/api/analytics/research', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const refTime = req.query.refTime ? new Date(req.query.refTime).getTime() : null;
        const result = {};

        // Calculate time boundary - Robust Anchor
        let anchorTime;
        if (refTime && !isNaN(refTime)) {
            anchorTime = refTime;
        } else {
            const lastScan = db.prepare('SELECT MAX(timestamp) as last FROM scans').get();
            const lastTs = lastScan?.last ? new Date(lastScan.last).getTime() : Date.now();
            const systemNow = Date.now();
            anchorTime = Math.max(lastTs, systemNow);
        }

        const cutoff = new Date(anchorTime - hours * 60 * 60 * 1000).toISOString();

        // A. Persistence Leaderboard ("Radar Locked On")
        const persistenceQuery = db.prepare(`
            SELECT ticker, COUNT(*) as persistence_score
            FROM scan_entries
            WHERE status = 'PASS'
            AND scan_id IN (SELECT id FROM scans WHERE timestamp >= ?)
            GROUP BY ticker
            HAVING persistence_score >= 1
            ORDER BY persistence_score DESC
            LIMIT 10
        `);
        result.persistence = persistenceQuery.all(cutoff);

        // B. Pulse Velocity ("Speedometer")
        let velocitySql = `
            SELECT 
                strftime('%Y-%m-%d %H:%M', timestamp) as time,
                COUNT(*) as count
            FROM pulse_events
            WHERE timestamp > ?
            GROUP BY time
            ORDER BY time ASC
        `;

        if (hours > 48) {
            velocitySql = `
            SELECT 
                strftime('%Y-%m-%d %H:00', timestamp) as time,
                COUNT(*) as count
            FROM pulse_events
            WHERE timestamp > ?
            GROUP BY time
            ORDER BY time ASC
           `;
        }

        const velocityQuery = db.prepare(velocitySql);
        result.velocity = velocityQuery.all(cutoff);

        // C. Rejection Heatmap ("Diagnostic System")
        const rejectionQuery = db.prepare(`
            SELECT missed_reason as name, COUNT(*) as value
            FROM scan_entries
            WHERE status = 'MISSED'
            AND scan_id IN (SELECT id FROM scans WHERE timestamp >= ?)
            GROUP BY missed_reason
            ORDER BY value DESC
        `);
        result.rejections = rejectionQuery.all(cutoff);

        // D. Latency & Sentiment (Snapshot - Always Latest)
        const snapshotQuery = db.prepare(`
            SELECT 
                s.latency, 
                m.mood_score as moodScore 
            FROM scans s
            LEFT JOIN market_states m ON s.id = m.scan_id
            ORDER BY s.timestamp DESC 
            LIMIT 1
        `);
        const snapshot = snapshotQuery.get() || {};
        result.latency = snapshot.latency || 0;
        result.moodScore = snapshot.moodScore || 0;

        res.json(result);
    } catch (err) {
        console.error('Research API Error:', err);
        res.status(500).json({ error: err.message });
    }
});


// 6. AI NOTIFICATIONS
app.get('/api/notifications', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const logs = db.prepare(`
            SELECT * FROM ai_notifications 
            ORDER BY timestamp DESC 
            LIMIT ?
        `).all(limit);
        res.json(logs);
    } catch (err) {
        console.error('Error fetching notifications:', err);
        res.status(500).json({ error: err.message });
    }
});

// 7. AI PASSED STRATEGY HISTORY (Last 48 Hours)
app.get('/api/ai/history', (req, res) => {
    try {
        const cutoff = Date.now() - (48 * 60 * 60 * 1000); // 48 Hours ago

        // Fetch PASS entries from the last 48h
        // We join with scans to get the timestamp
        const history = db.prepare(`
            SELECT 
                e.ticker, 
                e.label, 
                e.direction, 
                e.strategies_json, 
                s.timestamp, 
                m.mood_score 
            FROM scan_entries e 
            JOIN scans s ON e.scan_id = s.id 
            LEFT JOIN market_states m ON s.id = m.scan_id
            WHERE e.status = 'PASS' 
            AND s.timestamp > ? 
            ORDER BY s.timestamp DESC
            LIMIT 100
        `).all(new Date(cutoff).toISOString());

        res.json(history);
    } catch (err) {
        console.error('Error fetching AI history:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- PRUNING TASK (On Startup) ---
try {
    const pruneCutoff = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();

    // Prune AI Logs (User requested max 2 days history for logs)
    const result = db.prepare("DELETE FROM ai_notifications WHERE timestamp < ?").run(pruneCutoff);
    console.log(`🧹 Pruned ${result.changes} old AI notifications (< 48h)`);

    // Note: We do NOT prune 'scans' or 'scan_entries' yet as the Timeline might need them for replay.
    // Ideally, we prune scans > 30 days (720h)
} catch (e) {
    console.error('Pruning failed:', e);
}

// --- TELEGRAM SETTINGS ---
app.post('/api/settings/telegram', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Invalid setting' });

    const newState = TelegramService.toggle(enabled);
    res.json({ enabled: newState });
});

app.get('/api/settings/telegram', (req, res) => {
    res.json({ enabled: TelegramService.isEnabled });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`
🚀 Server running on port ${PORT}
   - API: http://localhost:${PORT}
   - Notifications: ${TelegramService.isEnabled ? 'ENABLED' : 'DISABLED'}
`);
});
