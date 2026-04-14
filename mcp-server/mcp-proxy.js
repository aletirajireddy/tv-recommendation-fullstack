#!/usr/bin/env node

const { EventSource } = require('eventsource');
const fetch = require('node-fetch');
const readline = require('readline');

// This script bridges Claude Desktop's local Stdio requirements to your Remote SSE Server!
const sseUrl = process.argv[2];

if (!sseUrl) {
    console.error("Usage: node mcp-proxy.js <sse-endpoint-url>");
    process.exit(1);
}

let messageUrl = null;
const messageQueue = [];

// 1. Connect to the Remote Tailscale SSE Endpoint
console.error(`[Proxy] Connecting to Remote SSE: ${sseUrl}...`);
const es = new EventSource(sseUrl);

async function forwardMessage(line) {
    try {
        await fetch(messageUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: line
        });
    } catch (e) {
        console.error("[Proxy Error] Failed to send message to server:", e);
    }
}

es.addEventListener('endpoint', async (event) => {
    // The server tells us where to POST responses via the 'endpoint' event
    messageUrl = new URL(event.data, sseUrl).toString();
    console.error(`[Proxy] Handshake Successful. Message Endpoint: ${messageUrl}`);
    
    // Flush any messages Claude sent before the connection was ready
    while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        await forwardMessage(msg);
    }
});

es.onmessage = (event) => {
    // 2. When the server sends a message, forward it to Claude Desktop's standard output
    if (event.data) {
        console.log(event.data);
    }
};

es.onerror = (err) => {
    console.error("[Proxy Error] SSE Connection Lost or Failed:", err);
};

// 3. Listen to Claude Desktop's standard input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    if (!messageUrl) {
        // Queue messages if Claude is impatient
        messageQueue.push(line);
        return;
    }
    
    // 4. When Claude Desktop asks a question, forward it as a POST request to your Tailscale server
    await forwardMessage(line);
});
