const fs = require('fs');
const zlib = require('zlib');

const input = 'Trace-20260430T214608.json.gz';
const output = 'Trace-20260430T214608.json';

try {
    const fileContents = fs.readFileSync(input);
    const decompressed = zlib.gunzipSync(fileContents);
    fs.writeFileSync(output, decompressed);
    console.log(`✅ Decompressed ${input} to ${output}`);
} catch (e) {
    console.error(`❌ Decompression failed: ${e.message}`);
}
