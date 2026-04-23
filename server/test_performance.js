const http = require('http');

const measureOpts = (path) => new Promise((resolve) => {
    const start = Date.now();
    http.get({
        hostname: 'localhost',
        port: 3000,
        path: path
    }, (res) => {
        let size = 0;
        res.on('data', chunk => size += chunk.length);
        res.on('end', () => {
            resolve({
                path,
                time: Date.now() - start,
                sizeKb: (size / 1024).toFixed(2)
            });
        });
    }).on('error', (e) => resolve({ path, error: e.message }));
});

async function run() {
    const hours = 720;
    const refTime = new Date().toISOString(); 
    const p1 = await measureOpts(`/api/analytics/pulse?hours=${hours}&refTime=${encodeURIComponent(refTime)}`);
    console.log(p1);
    const p2 = await measureOpts(`/api/analytics/research?hours=${hours}&refTime=${encodeURIComponent(refTime)}`);
    console.log(p2);
    const p3 = await measureOpts(`/api/analytics/participation-pulse?hours=${hours}&refTime=${encodeURIComponent(refTime)}`);
    console.log(p3);
    const p4 = await measureOpts(`/api/analytics/alpha-squad?hours=${hours}&refTime=${encodeURIComponent(refTime)}`);
    console.log(p4);
    
    // Test base history loading
    const p5 = await measureOpts(`/api/ai/history?hours=${hours}`);
    console.log(p5);
}

run();
