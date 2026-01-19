const Database = require('better-sqlite3');
const path = require('path');

const db = new Database('dashboard_v3.db', { readonly: true });

// Get last 20 events
const events = db.prepare('SELECT payload_json FROM pulse_events ORDER BY timestamp DESC LIMIT 20').all();

console.log(`Found ${events.length} events.`);

if (events.length > 0) {
    events.forEach((e, i) => {
        try {
            const p = JSON.parse(e.payload_json);
            // Log keys of the 'signal' object or root if signal missing
            const signal = p.signal || {};
            const keys = Object.keys(signal);

            // Check for 'd', 'di', 'mom', 'm'
            const d = signal.d !== undefined ? signal.d : 'MISSING';
            const di = signal.di !== undefined ? signal.di : 'MISSING';
            const mom = signal.mom !== undefined ? signal.mom : (signal.momentum !== undefined ? signal.momentum : 'MISSING');

            console.log(`[${i}] Keys: ${keys.join(',')} | d: ${d} | di: ${di} | mom: ${mom}`);
        } catch (err) {
            console.log(`[${i}] Error parsing JSON`);
        }
    });
}
