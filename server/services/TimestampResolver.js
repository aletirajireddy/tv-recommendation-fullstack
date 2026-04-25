/**
 * TimestampResolver — Single source of truth for canonical timestamps.
 *
 * Policy (locked 2026-04-25):
 *
 *   STREAM A (Tampermonkey scanner):
 *     → Trust payload.timestamp (browser is reading live prices = ground truth).
 *
 *   STREAM B (Coin scout):
 *     → Trust payload.timestamp (same rationale).
 *
 *   STREAM C — WEBHOOK path:
 *     → Use server receive time (new Date()).
 *     → Do NOT use payload.timestamp — TradingView's {{time}} placeholder
 *       returns BAR-OPEN time, which lags 3–5 min behind the actual fire moment.
 *
 *   STREAM C — EMAIL REHYDRATION path:
 *     1. Compute payload_hash. If a row with this hash already exists in DB → SKIP.
 *     2. Otherwise resolve timestamp:
 *        Let bar_open       = payload.timestamp (from TradingView)
 *        Let bar_size_ms    = derived from payload.interval / payload.timeframe
 *                             (default 5 min)
 *        Let bar_close      = bar_open + bar_size
 *        Let email_received = Gmail internalDate
 *
 *        IF email_received > (bar_close + 5 min):
 *            → Email arrived LATE. Use bar_close as authoritative timestamp.
 *        ELSE IF email_received within (bar_open, bar_close + 5 min):
 *            → Reasonable arrival window. Use email_received.
 *        ELSE (clock skew, email earlier than bar_open):
 *            → Fallback to bar_close.
 *
 * The resolver is called ONCE before insert. The chosen timestamp is persisted in
 * the canonical `timestamp` column. Every widget, chart, and API reads that column
 * verbatim — zero recalculation downstream.
 */

const crypto = require('crypto');

const FIVE_MIN_MS = 5 * 60 * 1000;

const BAR_SIZE_MAP_MS = {
    '1m': 60 * 1000,
    '3m': 3 * 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '60m': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    'D': 24 * 60 * 60 * 1000,
};

const DEFAULT_BAR_SIZE_MS = BAR_SIZE_MAP_MS['5m'];

/**
 * Derive bar size in milliseconds from a TradingView payload.
 * Looks at common fields (interval, timeframe, resolution). Falls back to 5m.
 */
function deriveBarSizeMs(payload) {
    if (!payload) return DEFAULT_BAR_SIZE_MS;
    const candidates = [
        payload.interval,
        payload.timeframe,
        payload.resolution,
        payload.bar_size,
        payload.tf,
    ];
    for (const raw of candidates) {
        if (!raw) continue;
        const key = String(raw).trim().toLowerCase();
        if (BAR_SIZE_MAP_MS[key] !== undefined) return BAR_SIZE_MAP_MS[key];
        // Numeric minutes (e.g. "5", "15", "30")
        const asNum = parseInt(key, 10);
        if (!isNaN(asNum) && asNum > 0 && asNum <= 1440) {
            return asNum * 60 * 1000;
        }
    }
    return DEFAULT_BAR_SIZE_MS;
}

/**
 * Compute a deterministic SHA256 hash of a payload, excluding fields that may
 * legitimately differ between webhook delivery and email rehydration of the
 * SAME alert (timestamps, server-attached metadata).
 *
 * Uses canonical (sorted-key) JSON serialization so hash is order-independent.
 */
function _canonicalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(_canonicalize);
    return Object.keys(value)
        .sort()
        .reduce((acc, k) => {
            acc[k] = _canonicalize(value[k]);
            return acc;
        }, {});
}

const VOLATILE_FIELDS = new Set([
    'timestamp', 'time', 'fire_time', 'received_at', 'server_time',
    'id', 'alert_id', 'message_id',
]);

function computePayloadHash(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const stripped = JSON.parse(JSON.stringify(payload));
    // Strip top-level volatile fields
    for (const k of Object.keys(stripped)) {
        if (VOLATILE_FIELDS.has(k)) delete stripped[k];
    }
    const canonical = _canonicalize(stripped);
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Resolve canonical timestamp.
 *
 * @param {Object} args
 * @param {'STREAM_A'|'STREAM_B'|'STREAM_C'} args.stream
 * @param {'WEBHOOK'|'EMAIL'|'SCAN_A'|'SCOUT_B'} args.source - Ingestion provenance
 * @param {Object} args.payload - The raw payload
 * @param {number} [args.emailReceivedMs] - Required when source='EMAIL' (Gmail internalDate)
 * @returns {{ timestampISO: string, source: string, reason: string }}
 */
function resolve({ stream, source, payload, emailReceivedMs }) {
    const safe = (iso, reason) => ({ timestampISO: iso, source, reason });

    // Stream A / B: trust payload.timestamp (browser truth).
    if (stream === 'STREAM_A' || stream === 'STREAM_B') {
        if (payload && payload.timestamp) {
            const t = new Date(payload.timestamp);
            if (!isNaN(t.getTime())) {
                return safe(t.toISOString(), `${stream}_payload_timestamp`);
            }
        }
        return safe(new Date().toISOString(), `${stream}_fallback_now`);
    }

    // Stream C — Webhook: server receive time.
    if (stream === 'STREAM_C' && source === 'WEBHOOK') {
        return safe(new Date().toISOString(), 'STREAM_C_webhook_server_time');
    }

    // Stream C — Email rehydration: bar-close pivot logic.
    if (stream === 'STREAM_C' && source === 'EMAIL') {
        if (!emailReceivedMs) {
            // Should never happen, but fail soft.
            return safe(new Date().toISOString(), 'STREAM_C_email_missing_received_fallback');
        }
        const barOpenMs = payload && payload.timestamp
            ? new Date(payload.timestamp).getTime()
            : null;

        // No bar open available → email received time is best we have.
        if (!barOpenMs || isNaN(barOpenMs)) {
            return safe(new Date(emailReceivedMs).toISOString(), 'STREAM_C_email_no_bar_open');
        }

        const barSizeMs = deriveBarSizeMs(payload);
        const barCloseMs = barOpenMs + barSizeMs;
        const lateThresholdMs = barCloseMs + FIVE_MIN_MS;

        if (emailReceivedMs > lateThresholdMs) {
            // Email arrived LATE → trust bar_close.
            return safe(
                new Date(barCloseMs).toISOString(),
                `STREAM_C_email_late_using_bar_close(barSize=${barSizeMs / 60000}m)`
            );
        }

        if (emailReceivedMs >= barOpenMs && emailReceivedMs <= lateThresholdMs) {
            // Reasonable window → trust email_received.
            return safe(
                new Date(emailReceivedMs).toISOString(),
                `STREAM_C_email_within_window(barSize=${barSizeMs / 60000}m)`
            );
        }

        // Email earlier than bar open (clock skew) → fallback to bar_close.
        return safe(
            new Date(barCloseMs).toISOString(),
            `STREAM_C_email_skew_using_bar_close(barSize=${barSizeMs / 60000}m)`
        );
    }

    // Default safety net.
    return safe(new Date().toISOString(), 'unknown_stream_fallback_now');
}

module.exports = {
    resolve,
    computePayloadHash,
    deriveBarSizeMs,
    DEFAULT_BAR_SIZE_MS,
};
