const db = require('better-sqlite3')('dashboard.db');
const dayjs = require('dayjs');

// 1. Check DB Count
const count = db.prepare('SELECT COUNT(*) as c FROM pulse_events').get().c;
console.log('DB Count:', count);

// 2. Check Raw Data Sample
const sample = db.prepare('SELECT * FROM pulse_events ORDER BY timestamp DESC LIMIT 3').all();
console.log('Sample Row:', sample[0]);

// 3. Replicate Logic
const hours = 720;
const lastEvent = db.prepare('SELECT MAX(timestamp) as last FROM pulse_events').get();
const lastTs = lastEvent?.last ? new Date(lastEvent.last).getTime() : Date.now();
const systemNow = Date.now();
const anchorTime = Math.max(lastTs, systemNow);

console.log('Anchor Time:', new Date(anchorTime).toISOString(), anchorTime);

const cutoff = dayjs(anchorTime).subtract(hours, 'hour').toISOString(); // ISO String?
const cutoffTs = dayjs(anchorTime).subtract(hours, 'hour').valueOf(); // Timestamp?

console.log('Cutoff (ISO):', cutoff);
console.log('Cutoff (TS):', cutoffTs);

// QUERY CHECK
// In index.js: WHERE timestamp >= ?
// The DB stores INTEGER (My Insert used .getTime())
// But cutoff is ISO STRING.
// SQLite comparison: INTEGER >= STRING might fail or yield weird results.

const pulsesISO = db.prepare('SELECT * FROM pulse_events WHERE timestamp >= ? ORDER BY timestamp DESC').all(cutoff);
console.log('Pulses Found (ISO Cutoff):', pulsesISO.length);

const pulsesTS = db.prepare('SELECT * FROM pulse_events WHERE timestamp >= ? ORDER BY timestamp DESC').all(cutoffTs);
console.log('Pulses Found (TS Cutoff):', pulsesTS.length);

// 4. Time Spread Logic (if data found)
if (pulsesTS.length > 0) {
    const timeMap = new Map();
    pulsesTS.forEach(p => {
        const date = dayjs(p.timestamp);
        if (!date.isValid()) return;

        const minutes = Math.floor(date.minute() / 5) * 5;
        const keyTime = date.minute(minutes).second(0).millisecond(0);
        const timeStr = keyTime.format('HH:mm');

        if (!timeMap.has(timeStr)) {
            timeMap.set(timeStr, { count: 0 });
        }
        timeMap.get(timeStr).count++;
    });
    console.log('Time Spread Keys:', Array.from(timeMap.keys()));
}
