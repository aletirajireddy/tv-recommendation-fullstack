// Native fetch used


async function testIngest() {
    try {
        const res = await fetch('http://localhost:3000/scan-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                results: [],
                metadata: { moodScore: 0, trendStrength: 0, vol24h: 0 },
                trigger: 'MANUAL_TEST'
            })
        });
        const text = await res.text();
        console.log('Status:', res.status);
        console.log('Response Body:', text);
    } catch (err) {

        console.error('Fetch Error:', err);
    }
}

testIngest();
