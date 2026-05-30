// Minimal timestamped logger — no deps, consistent prefixes.
function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
const log  = (...a) => console.log(`[${ts()}]`, ...a);
log.info  = (...a) => console.log(`[${ts()}] ℹ️ `, ...a);
log.ok    = (...a) => console.log(`[${ts()}] ✅`, ...a);
log.warn  = (...a) => console.warn(`[${ts()}] ⚠️ `, ...a);
log.err   = (...a) => console.error(`[${ts()}] ❌`, ...a);

module.exports = { log };
