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
    
    // Trace events are usually under trace.traceEvents or just trace if it's an array
    const events = Array.isArray(trace) ? trace : trace.traceEvents || [];
    
    // Calculate self time for function calls
    // Note: this is a simple approximation for Chrome trace events
    const functionTimes = {};
    const reactComponentTimes = {};
    
    for (const event of events) {
        if (event.name === 'FunctionCall' || event.name === 'EvaluateScript') {
            const url = event.args?.data?.url || '';
            const functionName = event.args?.data?.functionName || 'anonymous';
            
            if (event.dur > 1000) { // more than 1ms
                const key = `${functionName} (${url})`;
                functionTimes[key] = (functionTimes[key] || 0) + event.dur;
            }
        }
        
        // Also look for React marks/measures if they exist (usually under UserTiming)
        if (event.cat === 'blink.user_timing' && event.name.includes('⚛️')) {
             reactComponentTimes[event.name] = (reactComponentTimes[event.name] || 0) + (event.dur || 0);
        }
    }
    
    // Print top 20 expensive functions
    console.log("=== TOP SCRIPT EVALUATIONS / FUNCTION CALLS ===");
    Object.entries(functionTimes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .forEach(([key, dur]) => {
            console.log(`${(dur/1000).toFixed(2)}ms : ${key}`);
        });

    console.log("\n=== TOP REACT COMPONENT RENDERS (if measured) ===");
    Object.entries(reactComponentTimes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .forEach(([key, dur]) => {
            console.log(`${(dur/1000).toFixed(2)}ms : ${key}`);
        });

} catch (e) {
    console.error("Error analyzing trace:", e);
}
