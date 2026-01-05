const http = require('http');

const payload = {
    id: `scan_${Date.now()}`,
    // Intentionally missing timestamp to test fallback? No, let's test valid first, then invalid.
    // timestamp: new Date().toISOString(), 
    trigger: 'manual',
    results: [
        {
            ticker: 'BTCUSDT',
            score: 85,
            netTrend: 55.5,
            positionCode: 530,
            signal: { label: 'STRONG', direction: 'BULL' }
        }
    ]
};

const data = JSON.stringify(payload);

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/scan-report',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = http.request(options, (res) => {
    console.log(`StatusCode: ${res.statusCode}`);
    res.on('data', (d) => {
        process.stdout.write(d);
    });
});

req.on('error', (error) => {
    console.error(error);
});

req.write(data);
req.end();
