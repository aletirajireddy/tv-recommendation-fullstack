require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const readline = require('readline');

// --- CONFIGURATION ---
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const SYNC_STATE_PATH = path.join(__dirname, 'sync_state.json');

// V3 DB Path
const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'dashboard_v3.db');

// --- DATABASE CONNECTION ---
const db = new Database(dbPath);
console.log(`🔌 Connected to V3 Database: ${dbPath}`);
// Ensure we're using WAL mode for concurrency
db.pragma('journal_mode = WAL');

// --- AUTHENTICATION FLOW ---
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }

    try {
        await fs.access(CREDENTIALS_PATH);
    } catch (err) {
        console.error("🚨 ERROR: Missing credentials.json. Please follow Prerequisites in the implementation plan to download OAuth credentials from Google Cloud.");
        process.exit(1);
    }

    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });

    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}

// --- SYNC STATE MANAGEMENT ---
async function getSyncState() {
    try {
        const data = await fs.readFile(SYNC_STATE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        // Return 24 hours ago as default baseline
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return { lastProcessedDateMs: yesterday.getTime() };
    }
}

async function updateSyncState(lastMs) {
    await fs.writeFile(SYNC_STATE_PATH, JSON.stringify({ lastProcessedDateMs: lastMs }, null, 2));
}

// --- EMAIL PARSING ---
function decodeBase64URL(str) {
    // Replace non-url compatible chars with base64 standard chars
    str = (str + '===').slice(0, str.length + (str.length % 4));
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(str, 'base64').toString('utf8');
}

function extractEmailBody(payload) {
    let body = '';
    
    // Sometimes it's directly in the payload
    if (payload.body && payload.body.data) {
        body = decodeBase64URL(payload.body.data);
    } else if (payload.parts) {
        // It's multi-part
        for (const part of payload.parts) {
            // Prefer plain text, but take what we can get
            if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                body = decodeBase64URL(part.body.data);
                break;
            } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
                body = decodeBase64URL(part.body.data);
            }
        }
    }
    return body;
}

function parseJSONFromText(text) {
    // Strip out HTML tags if present (sometimes TV sends HTML emails)
    let cleanText = text.replace(/<[^>]*>?/gm, '').trim();
    
    try {
        // First attempt: clean text might just be pure JSON
        return JSON.parse(cleanText);
    } catch (e1) {
        // Second attempt: regex to find the first JSON-like block
        try {
            // Find from first { to last }
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                const jsonObjString = text.substring(start, end + 1);
                return JSON.parse(jsonObjString);
            }
        } catch (e2) {
            console.error("Failed to parse extracted JSON block. Text preview:", text.substring(0, 50).replace(/\n/g, ' '));
        }
    }
    return null;
}

// --- DEDUPLICATION ENGINE ---
function isDuplicate(ticker, price, direction, isoTimestamp, isInstitutional) {
    const table = isInstitutional ? 'institutional_interest_events' : 'smart_level_events';
    
    // SQLite query looking for exact Ticker, Price, Direction within +/- 5 minutes (300 seconds)
    const sql = `
        SELECT id FROM ${table}
        WHERE ticker = ? 
          AND direction = ? 
          AND ABS(price - ?) < 0.00001
          AND ABS(strftime('%s', ?) - strftime('%s', timestamp)) <= 300
        LIMIT 1
    `;
    
    const row = db.prepare(sql).get(ticker, direction, price, isoTimestamp);
    return !!row;
}

// --- DB INJECTION ENGINE ---
function injectToDatabase(payload, messageDateISO) {
    const ticker = payload.ticker;
    const price = parseFloat(payload.price || 0);

    const isInstitutional = typeof payload.bar_move_pct !== 'undefined';
    
    // Extract shared logic similar to server/index.js (Stream C)
    let direction = 0;
    if (isInstitutional) {
        direction = payload.direction !== undefined ? parseInt(payload.direction, 10) : 0;
    } else {
        direction = payload.momentum?.direction !== undefined ? parseInt(payload.momentum.direction, 10) : (payload.direction || 0);
    }
    
    // 1. DEDUPLICATION CHECK
    if (isDuplicate(ticker, price, direction, messageDateISO, isInstitutional)) {
        console.log(`[SKIP] Safely verified ${ticker} arrived in DB via webhook already.`);
        return { duplicates: 1, injected: 0 };
    }

    // 2. INJECTION (MISSING DATA)
    try {
        if (isInstitutional) {
            const bar_move_pct = parseFloat(payload.bar_move_pct);
            const today_change_pct = parseFloat(payload.today_change_pct || 0);
            const today_volume = parseFloat(payload.today_volume || 0);
            
            db.prepare(`
                INSERT OR IGNORE INTO institutional_interest_events (ticker, timestamp, price, direction, bar_move_pct, today_change_pct, today_volume, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(ticker, messageDateISO, price, direction, bar_move_pct, today_change_pct, today_volume, JSON.stringify(payload));
            
            console.log(`[INJECT] 💉 Restored Missing Institutional Alert: ${ticker} @ ${messageDateISO}`);
        } else {
            const roc_pct = payload.momentum?.roc_pct !== undefined ? parseFloat(payload.momentum.roc_pct) : 0.0;
            
            db.prepare(`
                INSERT OR IGNORE INTO smart_level_events (ticker, timestamp, price, direction, roc_pct, raw_data)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ticker, messageDateISO, price, direction, roc_pct, JSON.stringify(payload));
            
            console.log(`[INJECT] 💉 Restored Missing Smart Levels Alert: ${ticker} @ ${messageDateISO}`);
        }
        return { duplicates: 0, injected: 1 };
    } catch (e) {
        console.error(`💥 Failed to insert ${ticker}:`, e);
        return { duplicates: 0, injected: 0 };
    }
}

// --- MAIN PROCESS ---
async function fetchEmails() {
    console.log("========================================");
    console.log(`🕒 [${new Date().toISOString()}] Initiating Rehydration Routine...`);
    
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    const syncState = await getSyncState();
    let highestMsProcessed = syncState.lastProcessedDateMs || 0;
    
    try {
        // We use epoch seconds for Gmail query 'after:' to avoid fetching old emails
        const afterSeconds = Math.floor(highestMsProcessed / 1000);
        let query = `from:noreply@tradingview.com after:${afterSeconds}`;
        
        let messages = [];
        let pageToken = undefined;

        console.log(`Checking Gmail for Unread TradingView Updates... (Query: ${query})`);
        
        // Loop through all pages to fetch all emails, bypassing the 50 limit
        do {
            const res = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 500, // Fetch up to 500 at a time
                pageToken: pageToken
            });

            if (res.data.messages && res.data.messages.length > 0) {
                messages = messages.concat(res.data.messages);
            }
            pageToken = res.data.nextPageToken;
        } while (pageToken);

        if (messages.length === 0) {
            console.log("✨ No new alerts found.");
            return;
        }

        console.log(`📥 Found ${messages.length} total messages to process. Fetching details...`);

        let totalInjected = 0;
        let totalDuplicates = 0;
        let newHighestMs = highestMsProcessed;

        // Process oldest first so we preserve chronological order
        const messageDetails = [];
        // Fetch details in batches to not overwhelm the API
        for (let i = 0; i < messages.length; i += 10) {
            const batch = messages.slice(i, i + 10);
            const promises = batch.map(msg => gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' }));
            const results = await Promise.all(promises);
            results.forEach(res => messageDetails.push(res.data));
            process.stdout.write(`\rFetched details for ${messageDetails.length}/${messages.length} messages...`);
        }
        console.log('\n✅ Fetch complete. Beginning parsing and injection...');

        // Sort by timestamp ASC (oldest to newest)
        messageDetails.sort((a, b) => parseInt(a.internalDate) - parseInt(b.internalDate));

        for (const data of messageDetails) {
            const msgDateMs = parseInt(data.internalDate);
            
            // Skip if this message is older or equal to what we've already officially processed
            if (msgDateMs <= highestMsProcessed) {
                continue;
            }

            const bodyText = extractEmailBody(data.payload);
            const jsonPayload = parseJSONFromText(bodyText);

            if (jsonPayload && jsonPayload.ticker) {
                // Determine message timestamp in ISO correctly
                // ARCHITECTURE NOTE: We explicitly use the underlying Gmail 'internalDate' (Email Received Time).
                // Do NOT use jsonPayload.timestamp. TradingView's {{time}} placeholder outputs BAR OPEN time (e.g. 09:35 for a 5m bar).
                // Using the email received time perfectly mirrors the "Server Receive Time" logic used in the live webhook endpoint.
                const isoDate = new Date(msgDateMs).toISOString();
                
                const stats = injectToDatabase(jsonPayload, isoDate);
                totalInjected += stats.injected;
                totalDuplicates += stats.duplicates;
            } else {
                console.log(`⚠️ Ignored an email (ID: ${data.id}) that did not contain valid JSON payload.`);
            }

            // Move the high watermark up
            if (msgDateMs > newHighestMs) {
                newHighestMs = msgDateMs;
            }
        }

        console.log(`----------------------------------------`);
        console.log(`📊 Summary: ${totalInjected} Missing Alerts Injected | ${totalDuplicates} Duplicates Safely Ignored.`);
        
        // Save the new state
        if (newHighestMs > highestMsProcessed) {
            await updateSyncState(newHighestMs);
            console.log(`💾 Synced high-watermark. Next poll will start after: ${new Date(newHighestMs).toISOString()}`);
        }

    } catch (e) {
        console.error("Critical error during email fetch:", e);
    }
}

// Check run arguments
const isWatchMode = process.argv.includes('--watch');

if (isWatchMode) {
    console.log("👀 Starting email rehydrator in WATCH mode. Polling every 5 minutes...");
    fetchEmails(); // run immediately once
    setInterval(fetchEmails, 5 * 60 * 1000);
} else {
    console.log("🚀 Starting single-pass fetch...");
    fetchEmails().then(() => {
        console.log("✅ Finished execution.");
        process.exit(0);
    });
}
