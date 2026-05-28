const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const filename = process.argv[2];
if (!filename) {
    console.error("Usage: node analyze_trace.js <trace.json.gz>");
    process.exit(1);
}

try {
    const fileBuffer = fs.readFileSync(filename);
    const unzipped = zlib.gunzipSync(fileBuffer);
    const trace = JSON.parse(unzipped.toString('utf-8'));
    const events = Array.isArray(trace) ? trace : trace.traceEvents || [];
    
    let totalTime = 0;
    let adGuardTime = 0;
    let vimiumTime = 0;
    let ourAppTime = 0;

    for (const event of events) {
        if ((event.name === 'FunctionCall' || event.name === 'EvaluateScript') && event.dur) {
            totalTime += event.dur;
            const url = event.args?.data?.url || '';
            
            if (url.includes('adguard')) {
                adGuardTime += event.dur;
            } else if (url.includes('chrome-extension://')) {
                vimiumTime += event.dur;
            } else if (url.includes('desktop-c92c19n')) {
                ourAppTime += event.dur;
            }
        }
    }
    
    console.log(`Total JS Execution Time: ${(totalTime/1000).toFixed(2)}ms`);
    console.log(`AdGuard Time: ${(adGuardTime/1000).toFixed(2)}ms`);
    console.log(`Other Extensions (Vimium, etc): ${(vimiumTime/1000).toFixed(2)}ms`);
    console.log(`Our React App Time: ${(ourAppTime/1000).toFixed(2)}ms`);

} catch (e) {
    console.error("Error analyzing trace:", e);
}
