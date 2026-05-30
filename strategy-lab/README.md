# strategy-lab

A **self-contained, plug-and-play** lab for backtesting trading strategies and
(eventually) letting an AI agent self-tune them — built on top of the data your
live dashboard already collects.

> **This folder is an island.** It reads your live database **read-only** and
> writes only to its own `data/analytics_archive.db`. It does not import, modify,
> or depend on any file in the parent project. Zip it, move it, drop it on another
> machine — it runs anywhere Node 18+ is installed.

---

## Why it exists

Your live DB prunes **Stream D** (`coin_metric_history` — EMA/RSI/ATR/RVOL) to
~8 hours. That's the exact data a cascade/RSI strategy needs. This lab's first job
(**Phase 0**) is to *archive that data before it's deleted*, so history accumulates
for backtesting. See `../docs/HERMES_STRATEGY_ROADMAP.md` for the full plan.

---

## Quick start

```bash
cd strategy-lab
npm install                 # builds better-sqlite3 (native)
cp .env.example .env        # (Windows: copy .env.example .env)
# edit .env → set LIVE_DB_PATH if needed, then ARCHIVE_ENABLED=true
npm run doctor              # verify it can see your live db + tables
npm run archive:once        # one archival pass into data/analytics_archive.db
npm run backtest            # run the example strategy on archived data
```

To keep banking history continuously:

```bash
npm run archive:loop        # every ARCHIVE_INTERVAL_SEC (default 120s)
npm run health              # coverage %, gaps, last-run freshness
```

## Don't rely on remembering — automate it

The archiver should run by itself wherever your live data is generated, surviving
shutdowns and reboots. One-time setup per machine:

| Machine | Command |
|---|---|
| Windows laptop | `powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1` |
| Linux VM (always-on) | `sudo bash deploy/linux/install-systemd.sh` |
| Docker / Coolify (VM2) | `docker compose -f deploy/docker/docker-compose.yml up -d --build` |

Full per-platform guide + how catch-up-after-downtime works: **`docs/AUTOMATION.md`**.

> **Why automation matters:** Stream D is pruned to ~8h *while the live app runs*.
> After a long shutdown, the previous session's data can be pruned on boot before
> you back it up. The schedulers trigger at startup to grab it immediately — and for
> guaranteed history, run the archiver on the always-on VM1, not just the laptop.

---

## Safety model (how it can't hurt your live system)

| Guard | Mechanism |
|---|---|
| No writes to live | Live db opened with `readonly: true, fileMustExist: true` (`src/db/connections.js`) |
| Separate storage | All output goes to `data/analytics_archive.db` |
| Off by default | Archiver refuses to run unless `ARCHIVE_ENABLED=true` |
| Not in request path | Plain CLI scripts; nothing hooks your server or scanners |
| Reversible | Delete this folder (and the archive file) → gone without trace |
| Portable | Point `LIVE_DB_PATH` at a **copy** of the db for total isolation |

---

## Layout

```
strategy-lab/
├─ package.json            own deps (better-sqlite3, dotenv)
├─ .env.example            config template (copy → .env)
├─ config/default.json     fallback config (env overrides this)
├─ strategies/             strategy configs (the "knobs")
│  └─ cascade-pullback-at-level.json
├─ data/                   analytics_archive.db lives here (gitignored)
├─ deploy/                 automation: windows (Task Scheduler), linux (systemd/cron), docker
├─ docs/                   ARCHITECTURE.md + AUTOMATION.md
└─ src/
   ├─ util/                config loader + logger
   ├─ db/connections.js    read-only live + read-write archive (the safety chokepoint)
   ├─ archive/             Phase 0: ArchiveService + runArchiver CLI
   ├─ backtest/            Phase 1: engine skeleton + runBacktest CLI
   ├─ doctor.js            setup check
   └─ health.js            coverage + gap report
```

## Documentation

- **`docs/ARCHITECTURE.md`** — full architecture, the intermittent-machine problem,
  data-shape notes, deployment topology, and a "start here if you're an AI" section.
- **`docs/AUTOMATION.md`** — per-platform automated setup + verification.
- **`../docs/HERMES_STRATEGY_ROADMAP.md`** — the phased plan (archive → backtest →
  sweep → optimize → Hermes self-learning loop).

---

## Commands

| Command | What it does |
|---|---|
| `npm run doctor` | Verify live db reachable, show table depth, confirm archive writable |
| `npm run health` | Archive coverage %, timeline gaps, last-run freshness |
| `npm run archive:once` | Single archival pass (needs `ARCHIVE_ENABLED=true`) |
| `npm run archive:loop` | Continuous archival every interval |
| `npm run backtest [strategy.json] [windowMin]` | Run the Phase-1 signal backtest |

---

## Roadmap (where this is going)

- **Phase 0 — Archive** ✅ scaffolded (this folder). Stop losing Stream D history.
- **Phase 1 — Backtest harness** 🚧 skeleton present (`src/backtest/engine.js`).
  Currently counts cascade+RSI signals; P&L metrics need archived **price** (Phase 1.5).
- **Phase 2 — Param sweep** — run many strategy configs, rank them.
- **Phase 3 — Guided optimization** — Optuna/Bayesian search.
- **Phase 4 — Hermes in the loop** — local LLM (Ollama, Docker on VM2) proposes the
  next experiment; the loop runs it and learns.

Full reasoning + glossary: `../docs/HERMES_STRATEGY_ROADMAP.md`.

---

## Known gaps (honest status)

1. `coin_metric_history` has `dist_*` (% to EMA200), not raw price/EMA. The engine
   approximates cascade from dist sign-alignment. Real EMA-stacking + P&L needs
   price archived from `master_coin_store` (Phase 1.5).
2. Key-level proximity (Stream C `smart_levels`) not joined yet.
3. Backtest metrics (winRate/expectancy/maxDD) are placeholders until #1 lands.

These are deliberate — Phase 0 (don't lose data) is the urgent part; the engine
is wired end-to-end so later phases only fill in logic behind a stable contract.
