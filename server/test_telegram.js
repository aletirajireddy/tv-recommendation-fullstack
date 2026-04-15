/**
 * 🛠️ TELEGRAM CONNECTIVITY DIAGNOSTIC
 * 
 * Run this on your Cloud VM to verify if the server can talk to api.telegram.org
 * usage: node test_telegram.js
 */
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const env = process.env.APP_ENV || 'unknown-cloud';

console.log('--- 🔍 Telegram Diagnostic ---');
console.log(`Environment: ${env}`);
console.log(`Token Found: ${token ? '✅ Yes' : '❌ No'}`);
console.log(`Chat ID Found: ${chatId ? '✅ Yes' : '❌ No'}`);

if (!token || !chatId) {
    console.error('\n❌ ERROR: Missing credentials in .env file.');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

console.log('\n📡 Attempting to send test message...');

bot.sendMessage(chatId, `🧪 **DIAGNOSTIC TEST**\n\nOrigin: ${env}\nStatus: Outbound connectivity confirmed.\nTime: ${new Date().toISOString()}`, { parse_mode: 'Markdown' })
    .then(() => {
        console.log('✅ SUCCESS: Telegram message delivered!');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n❌ FAILED: Could not reach Telegram.');
        console.error('Reason:', err.message);
        if (err.code === 'EFATAL') {
            console.error('Hint: This is often a network/firewall issue on the VM.');
        } else if (err.code === 'ETELEGRAM') {
            console.error('Hint: Check if your Token or Chat ID is correct.');
        }
        process.exit(1);
    });
