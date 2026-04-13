const Database = require('better-sqlite3');
const path = require('path');

// Connect to the shared V3 database
const dbPath = path.resolve(__dirname, '..', 'dashboard_v3.db');
// Open in readonly mode to prevent any locking or interference with the main server ingest
const db = new Database(dbPath, { readonly: true });

console.log(`🔌 MCP Server connected in Read-Only mode to V3 Database: ${dbPath}`);

module.exports = db;
