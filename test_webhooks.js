async function testWebhooks() {
    console.log('--- Testing Dual-Webhook Ingestion ---');

    // 1. Test Institutional Interest Webhook
    const instPayload = {
        ticker: "BTCUSDT.P",
        price: 65000,
        direction: 1,
        bar_move_pct: 0.5,
        today_change_pct: 2.1,
        today_volume: 1200000,
        timestamp: "2026-03-21T08:00:00Z"
    };

    console.log('\n[1/2] Sending Institutional Interest Payload...');
    try {
        const instRes = await fetch('http://localhost:3000/api/webhook/smart-levels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(instPayload)
        });
        const instData = await instRes.json();
        console.log('✅ Success:', instData);
    } catch (err) {
        console.error('❌ Failed:', err.message);
    }

    // 2. Test Smart Levels Webhook
    const smartPayload = {
        ticker: "ETHUSDT.P",
        price: 3500,
        direction: -1,
        momentum: {
            direction: -1,
            roc_pct: -1.2
        },
        timestamp: "2026-03-21T08:05:00Z"
    };

    console.log('\n[2/2] Sending Smart Levels Payload...');
    try {
        const smartRes = await fetch('http://localhost:3000/api/webhook/smart-levels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(smartPayload)
        });
        const smartData = await smartRes.json();
        console.log('✅ Success:', smartData);
    } catch (err) {
        console.error('❌ Failed:', err.message);
    }
}

testWebhooks();
