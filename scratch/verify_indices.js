const db = require('../server/database');
const tables = [
    'scans', 
    'smart_level_events', 
    'institutional_interest_events', 
    'market_context_logs', 
    'qualified_picks', 
    'qualified_picks_log'
];

console.log('--- Database Index Verification ---');
tables.forEach(t => {
    const indices = db.prepare(`PRAGMA index_list(${t})`).all();
    const hasTimestampIndex = indices.some(idx => idx.name.includes('timestamp'));
    console.log(`Table: ${t.padEnd(30)} | Index count: ${indices.length} | Timestamp Index: ${hasTimestampIndex ? '✅' : '❌'}`);
    if (hasTimestampIndex) {
        const timestampIdx = indices.find(idx => idx.name.includes('timestamp'));
        console.log(`  - Found: ${timestampIdx.name}`);
    }
});
process.exit(0);
