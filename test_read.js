// Native fetch used

async function testRead() {
    try {
        console.log('Testing GET /api/history?hours=24 ...');
        const res = await fetch('http://localhost:3000/api/history?hours=24');

        if (res.status !== 200) {
            const text = await res.text();
            console.error(`❌ FAILED (Status ${res.status}): ${text}`);
            return;
        }

        const json = await res.json();
        console.log(`✅ SUCCESS (Status 200)`);
        console.log(`Received ${json.length} timeline entries.`);

        if (json.length > 0) {
            console.log('Sample Entry:', JSON.stringify(json[0], null, 2));
        } else {
            console.log('⚠️ Warning: Timeline is empty (but API worked).');
        }

    } catch (err) {
        console.error('❌ NETWORK ERROR:', err);
    }
}

testRead();
