// HTTP CRUD for the Telegram "Coins of Interest" watchlist. Mounted at
// /api/telegram/watchlist in server/index.js.

const express = require('express');
const db = require('../database');
const { normaliseTicker } = require('../utils/tickerNormalize');

const router = express.Router();

const TOGGLE_COLS = ['breakout', 'institutional', 'volume_spike'];

// GET /api/telegram/watchlist — list all watched coins
router.get('/', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM telegram_watchlist ORDER BY added_at DESC').all();
        res.json({ coins: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/telegram/watchlist  body { ticker }
router.post('/', (req, res) => {
    try {
        const ticker = normaliseTicker(req.body?.ticker);
        if (!ticker) return res.status(400).json({ error: 'Ticker required' });

        db.prepare(`
            INSERT INTO telegram_watchlist (ticker) VALUES (?)
            ON CONFLICT(ticker) DO NOTHING
        `).run(ticker);

        const coin = db.prepare('SELECT * FROM telegram_watchlist WHERE ticker = ?').get(ticker);
        res.json({ ok: true, coin });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// PATCH /api/telegram/watchlist/:ticker  body { breakout?, institutional?, volume_spike? }
router.patch('/:ticker', (req, res) => {
    try {
        const ticker = normaliseTicker(req.params.ticker);
        const existing = db.prepare('SELECT * FROM telegram_watchlist WHERE ticker = ?').get(ticker);
        if (!existing) return res.status(404).json({ error: 'not found' });

        for (const col of TOGGLE_COLS) {
            if (req.body?.[col] !== undefined) {
                db.prepare(`UPDATE telegram_watchlist SET ${col} = ? WHERE ticker = ?`)
                  .run(req.body[col] ? 1 : 0, ticker);
            }
        }

        const coin = db.prepare('SELECT * FROM telegram_watchlist WHERE ticker = ?').get(ticker);
        res.json({ ok: true, coin });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// DELETE /api/telegram/watchlist/:ticker
router.delete('/:ticker', (req, res) => {
    try {
        const ticker = normaliseTicker(req.params.ticker);
        const result = db.prepare('DELETE FROM telegram_watchlist WHERE ticker = ?').run(ticker);
        res.json({ ok: true, deleted: result.changes > 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
