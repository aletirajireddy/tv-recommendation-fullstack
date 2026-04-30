const db = require('../server/database');
const cutoff = '2026-04-30T12:11:00.000Z';

console.log(`--- Database Cleanup Protocol ---`);
console.log(`Cutoff: ${cutoff} (5:41 PM IST)`);

try {
    db.transaction(() => {
        // 1. Scans (cascades to scan_results)
        const scans = db.prepare('DELETE FROM scans WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${scans.changes} scans (and results)`);

        // 2. Pulse Events
        const pulses = db.prepare('DELETE FROM pulse_events WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${pulses.changes} pulse events`);

        // 3. Smart Levels & Institutional
        const sl = db.prepare('DELETE FROM smart_level_events WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${sl.changes} smart level events`);
        
        const inst = db.prepare('DELETE FROM institutional_interest_events WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${inst.changes} institutional interest events`);

        // 4. Volume Events
        const vol = db.prepare('DELETE FROM volume_events WHERE ts > ?').run(cutoff);
        console.log(`- Deleted ${vol.changes} volume events`);

        // 5. Telegram Logs
        const tlogs = db.prepare('DELETE FROM telegram_logs WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${tlogs.changes} telegram logs`);

        // 6. Master Coin Store
        const mcs = db.prepare('DELETE FROM master_coin_store WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${mcs.changes} master coin store entries`);
        
        // 7. Sentiment Logs
        const sent = db.prepare('DELETE FROM raw_market_sentiment_log WHERE timestamp > ?').run(cutoff);
        console.log(`- Deleted ${sent.changes} sentiment logs`);
    })();
    console.log('✅ Cleanup complete.');
} catch (e) {
    console.error('❌ Cleanup failed:', e.message);
}
