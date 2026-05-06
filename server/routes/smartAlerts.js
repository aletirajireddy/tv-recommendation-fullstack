// HTTP CRUD for Smart Alerts. Mounted at /api/smart-alerts in server/index.js.

const express = require('express');
const service = require('../services/smartAlerts/service');

const router = express.Router();

// POST /api/smart-alerts  — create alert
router.post('/', (req, res) => {
    try {
        const alert = service.createAlert(req.body || {});
        res.json({ ok: true, alert });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// GET /api/smart-alerts?state=active|qualified|expired|disabled|all&limit=200
router.get('/', (req, res) => {
    try {
        const state = req.query.state || 'all';
        const limit = parseInt(req.query.limit) || 200;
        const alerts = service.list({ state, limit });
        const counts = service.list({ state: 'all', limit: 500 }).reduce((acc, a) => {
            acc[a.state] = (acc[a.state] || 0) + 1; return acc;
        }, {});
        res.json({ alerts, counts, unread: service.unreadQualifiedCount() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/smart-alerts/unread-count  — header-bell badge
router.get('/unread-count', (req, res) => {
    try { res.json({ unread: service.unreadQualifiedCount() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/smart-alerts/:id/events  — full state-transition history
router.get('/:id/events', (req, res) => {
    try {
        const alert  = service.getById(req.params.id);
        if (!alert) return res.status(404).json({ error: 'not found' });
        const events = service.getEvents(req.params.id, parseInt(req.query.limit) || 100);
        res.json({ alert, events });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/smart-alerts/:id  — toggle enabled / mark read
router.patch('/:id', (req, res) => {
    try {
        const { enabled, mark_read } = req.body || {};
        let alert = service.getById(req.params.id);
        if (!alert) return res.status(404).json({ error: 'not found' });
        if (enabled !== undefined) alert = service.setEnabled(req.params.id, !!enabled);
        if (mark_read)             alert = service.markRead(req.params.id);
        res.json({ ok: true, alert });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// DELETE /api/smart-alerts/:id  — soft delete
router.delete('/:id', (req, res) => {
    try {
        const ok = service.softDelete(req.params.id);
        res.json({ ok });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/smart-alerts/mark-all-read
router.post('/mark-all-read', (req, res) => {
    try { res.json(service.markAllRead()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/smart-alerts/bulk-delete  body { scope: 'expired'|'qualified'|'all'|... }
router.post('/bulk-delete', (req, res) => {
    try { res.json(service.bulkDelete(req.body?.scope || 'expired')); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
