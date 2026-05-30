# strategy-lab — Architecture (read this first)

> **Audience:** future-me, or any AI assistant picking this up with no prior context.
> **One-sentence summary:** a portable, read-only consumer of the live trading DB
> that archives soon-to-be-pruned data and backtests strategies, completely
> isolated from the live system.

---

## 0. The 30-second mental model

```
  LIVE SYSTEM (the parent project)                 strategy-lab (this folder)
  ────────────────────────────────                 ──────────────────────────
  scanners → dashboard_v3.db  ──(READ ONLY)──▶      ArchiveService
     │  (prunes Stream D to ~8h)                        │ copies rows before prune
     ▼                                                  ▼
  live dashboards                                  data/analytics_archive.db
                                                        │
                                                        ▼
                                                   backtest engine → metrics
                                                        │ (later)
                                                        ▼
                                                   Hermes self-learning loop
```

The lab **never writes** to `dashboard_v3.db`. It only reads. Everything it
produces lands in its own `data/analytics_archive.db`. Delete this folder and the
live system is unaffected.

---

## 1. Why this exists (the problem)

The live project records market state across four data streams (A/B/C/D — see the
parent `CLAUDE.md`). The richest per-coin technical stream, **Stream D**
(`coin_metric_history`: EMA-distance, RSI, ATR, RVOL per timeframe), is **pruned to
~8 hours** by the live writer (`DELETE` of rows older than 8h on every insert).

To backtest a strategy you need *weeks/months* of that data, not 8 hours. So the
lab's first job is to **copy Stream D out before it's deleted**, into a durable
archive. The longer archiving is delayed, the more history is gone forever.

---

## 2. The hardest sub-problem: intermittent machines

Data is only generated (and only pruned) **while the live app is running.** That
creates a specific risk on a laptop that is shut down at random:

- While the laptop is OFF: no new data, no pruning — nothing is lost.
- When the laptop BOOTS: the live backend starts, scanners resume, and pruning
  resumes. If the previous session's data is now older than 8h, it gets **pruned on
  the first writes** — possibly before a human remembers to back up.

**Mitigations (all implemented):**

1. **Run archiving automatically, not manually** (Windows Task Scheduler / Linux
   systemd timer / Docker). See `docs/AUTOMATION.md`.
2. **Trigger at boot/logon**, so the archiver grabs the prior session's data the
   instant the machine wakes — see the `-AtStartup`/`OnBootSec` triggers.
3. **Run it on the always-on machine** (VM1, where the live DB lives) as the
   authoritative archiver. The laptop is best-effort secondary.
4. **Health/gap report** (`npm run health`) surfaces any timeline gap bigger than
   the live retention, so silent loss becomes visible.

> **Rule of thumb:** archiving must live next to the live DB on whatever machine is
> generating data, and ideally that machine is always-on. The laptop can archive
> too, but treat it as a bonus, not the system of record.

---

## 3. Components

| Path | Role |
|---|---|
| `src/db/connections.js` | **Safety chokepoint.** Opens live DB `readonly:true, fileMustExist:true`; opens archive read-write. The single place that guarantees no live writes. |
| `src/util/config.js` | Resolves config: env (`.env`) > `config/default.json` > built-ins. All paths resolved against the folder root, so the folder is portable. |
| `src/archive/ArchiveService.js` | Generic, schema-agnostic copier. Reads each table's `CREATE` SQL from live, recreates it in archive, copies rows. Two modes: incremental (high-water on `id`) and snapshot (full `INSERT OR REPLACE`). |
| `src/archive/runArchiver.js` | CLI. `--once` = one pass; no flag = loop. Refuses to run unless `ARCHIVE_ENABLED=true`. |
| `src/backtest/engine.js` | Phase-1 skeleton. `backtest(cfg, ctx) → metrics`. Currently signal-counting only (P&L pending price archival). |
| `src/backtest/runBacktest.js` | CLI to run a strategy JSON against the archive. |
| `src/doctor.js` | Setup check: live reachable, table depths, archive writable. |
| `src/health.js` | Coverage + gap report; flags permanent data loss. |
| `strategies/*.json` | Strategy configs = the tunable "knobs". |
| `deploy/**` | Automation for Windows, Linux, Docker. |

---

## 4. How the archiver works (incremental + catch-up)

- **Incremental tables** (`coin_metric_history`, `market_context_logs`): the archive
  remembers the highest `id` it has stored (`SELECT MAX(id)`), then copies only live
  rows with a greater `id`. `INSERT OR IGNORE` dedupes. **This is what makes
  intermittent running safe**: whenever it runs, it grabs *everything currently in
  live that it doesn't already have*. The only unrecoverable loss is data the live
  DB pruned during downtime.
- **Snapshot tables** (`validation_trials`, `validation_state_log`,
  `pattern_statistics`): small and mutable (states change), so copied in full each
  pass via `INSERT OR REPLACE`.
- Every pass records per-table counts into `_archive_runs` (audit trail + freshness).

Schema-agnostic by design: column names are read from `PRAGMA table_info`, so live
schema migrations don't break archiving.

---

## 5. Data shape notes (important for backtesting)

- `coin_metric_history` stores **`dist_*` (% distance to EMA200), not raw price or
  raw EMA values.** True EMA-cascade = EMA-value stacking across TFs. The current
  engine approximates direction from `dist` sign-alignment — good enough to wire the
  pipeline, **not** P&L-accurate.
- **Phase 1.5 (next real work):** also archive **price** (from `master_coin_store`)
  so the engine can compute entry/exit P&L and reconstruct true EMA values.
- **Key levels** for "price at a level" entries come from Stream C
  (`smart_level_events.smart_levels`) — not yet joined.
- Use the parent project's `/api/stream-sync` to identify DIVERGED/STALE cycles and
  **exclude them from training** so we never learn from broken data.

---

## 6. Deployment topology (current → future)

| Machine | Runs | Notes |
|---|---|---|
| **Laptop** (now: dev + live data) | Task Scheduler archiver + manual backtests | Best-effort archiving; where you build & test. |
| **VM1** (always-on, live source later) | systemd timer archiver (authoritative) | The durable system of record for history. |
| **VM2** (future: Coolify + Docker) | Docker archiver loop + backtests + Hermes loop | Heavy/AI compute; reads an archive snapshot, never live VM1. |

Moving the archive between machines = copy `data/analytics_archive.db` (or sync it).
Because incremental copy is high-water based, two archivers pointed at the same live
DB converge to the same set without conflict.

---

## 7. Safety guarantees (why this can't hurt the live system)

1. Live DB opened `readonly:true, fileMustExist:true` — writes are impossible.
2. All output → separate `data/analytics_archive.db`.
3. `ARCHIVE_ENABLED` kill-switch; off by default.
4. Not in any server/request path — standalone CLIs / containers.
5. No imports from the parent project; no shared `node_modules`.
6. Fully reversible: delete the folder (+ archive) and there's no trace.
7. In Docker, the live DB is bind-mounted `:ro`.

---

## 8. Roadmap pointer

Phased plan (archive → backtest → param sweep → optimization → Hermes loop) lives in
the parent repo: `../docs/HERMES_STRATEGY_ROADMAP.md`. This folder currently
implements **Phase 0 (archive)** and a **Phase 1 skeleton (signal backtest)**.

---

## 9. If you're an AI continuing this work — start here

1. Read this file, then `../docs/HERMES_STRATEGY_ROADMAP.md`.
2. Run `npm run doctor` then `npm run health` to see live + archive state.
3. The next concrete task is **Phase 1.5**: archive price from `master_coin_store`
   and extend `engine.js` to compute real entry/exit P&L (replace the `null`
   `winRate`/`expectancy`/`maxDrawdownPct` placeholders).
4. Keep the contract `backtest(cfg, ctx) → metrics` stable — later phases (param
   sweep, optimizer, Hermes) all depend on it.
5. Never add a write path to the live DB. If you need more live data, archive it.
