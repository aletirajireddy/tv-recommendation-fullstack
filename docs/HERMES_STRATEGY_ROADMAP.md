# Strategy Self-Test & Parallel Self-Learning System — Roadmap

> **Status:** Planning. No code yet. This document is the thinking-out-loud plan.
> **Guiding principle:** Everything here is a *side, parallel system*. It only ever
> **reads** from the data you already collect. It never writes to live tables, never
> changes the scanners, never sits in the request path. If we deleted the whole
> thing tomorrow, your current dashboard would not notice.

---

## 1. What we're actually trying to build (in plain words)

You have a machine that, every few minutes, records the state of the market across
4 data streams. Today that data drives *live dashboards*. The idea is to also use
that same data to answer a different question:

> "If I had traded with **rule set X** over the last N weeks, would I have made money?
> And can a computer keep tweaking rule set X on its own until it finds something good?"

That breaks into two capabilities:

1. **Backtesting** — replay history, apply a rule, score the result. (Pure math, no AI.)
2. **Self-learning** — something proposes the *next* rule to try, learns from the
   score, and repeats. (This is where an AI agent like "Hermes" eventually fits.)

We build #1 first. #2 is meaningless without #1.

---

## 2. "Self-learning" demystified — what actually happens under the hood

People imagine a robot that "learns to trade." Reality is calmer and more useful.
There are **three different levels**, and they are NOT the same thing:

### Level A — Parameter search (no AI at all)
You define a rule with knobs: *"Buy when 1h+15m EMA cascade is bullish AND RSI(15m)
pulls back to 50 AND price is within 0.5% of a key level."* The knobs are the numbers
(`50`, `0.5%`, which timeframes). A program tries thousands of combinations of those
knobs against history and ranks them by profit. **This alone is 80% of the value.**

### Level B — Guided search / optimization (smart, still not "AI magic")
Instead of brute-forcing every combo, a smarter searcher (e.g. **Optuna**, a Bayesian
optimizer) notices "higher RSI thresholds keep losing" and stops wasting time there.
It converges on good knobs far faster. Still deterministic, explainable, cheap.

### Level C — Agent in the loop (this is where Hermes lives)
A large language model (LLM) — Hermes is one such open model — sits *above* the
optimizer. Its job is not number-crunching; it's **hypothesis generation and reasoning**:

- It reads a summary: "Top strategies all use 1h+15m cascade; they fail in high-ATR
  regimes; RSI pullback entries beat breakout entries 2:1."
- It proposes the *next experiment in words*: "Try adding an ATR ceiling filter, and
  test whether requiring price at a daily key level improves the bad-regime cases."
- That proposal is turned into knob ranges, the optimizer (Level B) runs them, results
  come back, Hermes reasons again. **A loop with memory.**

So "self-learning" here = **a closed loop: propose → backtest → score → learn → propose
again.** The "memory" is just a results table. Nothing mystical. The LLM is the part
that's good at saying *what to try next and why*, which is exactly the part humans get
bored doing.

> **Beginner takeaway:** You can get huge value at Level A/B with zero AI. Hermes (Level C)
> is an accelerant you add *later*, once the backtest harness is trustworthy. Don't start
> at C.

### What "Hermes" is, concretely
"Hermes" (NousResearch Hermes) is an **open-weight LLM** — a model file you can download
and run yourself, instead of calling a paid API. You'd run it in **Docker** via a server
like **Ollama** (easiest) or **vLLM** (faster, heavier). On VM2 it becomes a local
"reasoning service" your loop can call for free, privately, as much as you want. It is
*one option*; the architecture treats "the reasoning model" as swappable (could be Hermes,
could be any local or API model). We don't commit to it now.

---

## 3. Your current architecture — what we have to build on

This is the foundation. The self-learning system is a **consumer** of these, never a modifier.

### Data streams (the raw material)
| Stream | What it captures | Stored in | Backtest value |
|---|---|---|---|
| **A** macro scan | momentum/breakout/bias across all coins | `scans`, `scan_results` | regime context |
| **B** watchlist | the curated coin list + breadth | `market_context_logs` | universe per point in time |
| **C** alerts | per-coin webhook events, today's change/vol | `smart_level_events`, `institutional_interest_events` | event triggers, **key levels** |
| **D** technicals | EMA200/ATR/RSI/RVOL per coin per TF | `coin_metric_history` | **the core signal data** |

### Derived / labeled assets (gold for backtesting)
- **`validation_trials` + `validation_state_log`** (3rd Umpire) — you ALREADY run
  forward-looking trials with verdicts. This is *labeled outcome data*: "signal fired,
  here's what happened next." A backtest can replay these directly.
- **`pattern_statistics`** — pre-computed win rates by pattern.
- **`master_coin_store`** — 501k rows, unified event store (deep history).
- **`/api/stream-sync`** (just built) — tells us which historical cycles were clean vs
  DIVERGED/STALE. **Critical:** we must NOT train on garbage cycles. This widget becomes
  the data-quality gate for the backtester.

### The streams that matter for YOUR strategy idea
Your lean: **"EMA/RSI cascade signals + price at key levels while RSI/EMA in force."**
That maps cleanly onto existing data:
- **EMA cascade** → `coin_metric_history` dist_* + the `checkCascade` logic you already have.
- **RSI cascade / pullback** → `coin_metric_history` rsi_m5/m15/m30/h1 + RSI Grid Wall logic.
- **Key levels** → Stream C `smart_levels` (daily/hourly support/resist, mega spot).
- **"in force"** → cascade state must persist N buckets, not just flicker.

**You already have every input your strategy needs.** The only thing missing is *history*.

---

## 4. The one real blocker: data retention

Measured today against your live DB:

| Table | Span available |
|---|---|
| `scans` (Stream A) | ~1 month ✓ |
| `market_context_logs` (Stream B) | ~1 month ✓ |
| `master_coin_store` | deep ✓ |
| **`coin_metric_history` (Stream D)** | **~8 hours only** ⚠️ |

Stream D — the EMA/RSI/ATR data your strategy is built on — is **pruned to 8 hours**
by the live writer. You cannot backtest a cascade strategy on 8 hours of data.

**Therefore the first physical step, before any strategy code, is to start keeping
Stream D history in a separate place.** This is cheap, safe, and the longer we wait
the more irreplaceable data is lost. Everything else can be built later; this clock
is ticking now.

---

## 5. Defining "a strategy" for your idea

A strategy = a **config object** (just knobs). Example shape for your cascade+levels idea:

```jsonc
{
  "name": "cascade-pullback-at-level",
  "entry": {
    "emaCascade":   { "tfs": ["h1","m15"], "dir": "bull", "holdBuckets": 3 },
    "rsiPullback":  { "tf": "m15", "zone": [45, 55] },        // pullback into mid
    "atLevel":      { "source": "daily", "maxDistPct": 0.5 }, // price near key level
    "atrCeiling":   { "tf": "m15", "maxPct": 2.5 }            // avoid chaos regimes
  },
  "exit": {
    "takeProfitPct": 1.5,
    "stopLossPct":   0.8,
    "cascadeFlip":   true,        // exit if cascade breaks
    "maxHoldMin":    240
  }
}
```

The backtester reads this, walks history, and reports `{winRate, expectancy, maxDD,
trades, avgHoldMin}`. **The knobs in this object are exactly what the self-learning
loop will later tune.** Phase 1 builds the engine that scores one such object; Phase 2+
makes something search over many of them.

---

## 6. Phased roadmap (each phase is independently useful & reversible)

> Mapped to your workflow: **build on laptop → validate → deploy archival to VM1 →
> heavy compute on VM2.** No phase requires the next to exist.

### Phase 0 — Archiver  ← **DO THIS FIRST**
- **Goal:** stop losing Stream D history.
- **What:** a small service that copies new `coin_metric_history` (and B/validation rows)
  into a **separate** `analytics_archive.db` before the 8h prune deletes them.
- **Where:** laptop now (to test), then VM1 when you resume it (for real accumulation).
- **Risk:** ~zero. Reads live tables, writes a different file. **Env-flag gated, OFF by
  default.** Can't touch prod.
- **Deliverable:** `server/services/ArchiveService.js` + one env flag.

### Phase 1 — Backtest harness (laptop, offline)
- **Goal:** score ONE strategy config against archived history.
- **What:** pure function `backtest(config, data) → metrics`. Start by replaying
  `validation_trials` (instant ground truth) before simulating fresh cascade entries.
- **Risk:** zero — separate script, reads a DB copy.
- **Deliverable:** `tools/backtest/` (standalone, not wired into the server).

### Phase 2 — Parameter sweep (Level A)
- **Goal:** run hundreds of configs, rank them.
- **What:** grid/random search → `backtest_runs` table in the archive DB.
- **Deliverable:** a CLI: `node tools/backtest/sweep.js strategy.json`.

### Phase 3 — Guided optimization (Level B)
- **Goal:** find good knobs 10–100× faster than brute force.
- **What:** Optuna (Python) or a JS Bayesian optimizer drives the sweep.
- **Where:** still fine on laptop; this is when a Python sidecar may appear.

### Phase 4 — Hermes in the loop (Level C, VM2)
- **Goal:** agent proposes next experiments with reasoning.
- **What:** Coolify on new Oracle VM2 → Docker → Ollama + Hermes model. A loop service
  summarizes results, asks the model "what next?", converts the answer to knob ranges,
  runs Phase 2/3, repeats. Reads an archive **snapshot**, never live VM1.
- **Risk:** fully isolated (separate VM, separate DB copy, Docker sandbox).

### Phase 5 — (Optional, much later) Distill / fine-tune
- Once you have thousands of scored runs, optionally train a small model to predict
  good configs directly. Only worth it if Phases 1–4 prove the edge is real.

---

## 7. How it maps to your three machines

```
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────────────────────┐
│ LAPTOP (dev/test)   │     │ VM1 (live, main)     │     │ VM2 (future: Coolify)     │
│ • build harness     │     │ • collects streams   │     │ • Docker + Ollama/Hermes  │
│ • run on DB *copy*  │     │ • runs ArchiveService│ ──▶ │ • optimization loop       │
│ • Phases 1–3        │     │   (Phase 0, gated)   │snap │ • reads archive snapshot  │
└─────────────────────┘     │ • UNCHANGED live flow│shot │ • Phases 3–5 heavy compute │
                            └──────────────────────┘     └───────────────────────────┘
        copy DB ↔ test                 nightly export of analytics_archive.db ──▶ VM2
```

- **Laptop:** where you invent and sanity-check. Always against a copy.
- **VM1:** keeps doing exactly what it does today + quietly banks history. The ONLY
  addition is the archiver, and it's optional/off until you flip the flag.
- **VM2:** the "lab." Heavy, isolated, talks only to a copy of the archive. If it
  crashes, melts, or hallucinates, VM1 and your trading data are untouched.

---

## 8. The self-learning loop, concretely (what Phase 4 actually does)

```
   ┌──────────────────────────────────────────────────────────────┐
   │ 1. Results table holds every config tried + its score         │
   │ 2. Summarizer builds a short report (top/bottom configs,       │
   │    which knobs correlate with wins, which regimes fail)        │
   │ 3. Hermes (LLM) reads report → proposes next hypothesis in     │
   │    plain language + suggested knob ranges                      │
   │ 4. Loop turns that into a sweep spec                           │
   │ 5. Backtester (Phase 2/3) runs it → new scores                 │
   │ 6. Append to results table → back to step 2                    │
   └──────────────────────────────────────────────────────────────┘
        The "learning" = the results table growing + the model
        conditioning each proposal on everything tried so far.
```

You can run this unattended overnight. In the morning you read Hermes' reasoning trail
and the leaderboard. **You stay the decision-maker;** the system does the grunt search.

---

## 9. Guardrails — how we guarantee "no disturbance to current flow"

1. **Read-only on live tables.** The archiver does `SELECT`; it writes a *different file*.
2. **Separate database file** (`analytics_archive.db`) for all archive + backtest data.
3. **Off by default.** Every new piece is behind an env flag; prod behaves identically
   until you opt in.
4. **Out of the request path.** Nothing here runs inside `/api/*` handlers or scanners.
5. **Separate folders/branch.** `tools/backtest/`, `server/services/ArchiveService.js`,
   a `feat/strategy-lab` branch — never tangled with widget code.
6. **VM2 isolation.** Different VM, Docker sandbox, works on a *snapshot*, not live VM1.
7. **Data-quality gate.** Use `/api/stream-sync` to exclude DIVERGED/STALE cycles so we
   never learn from broken data.
8. **Fully reversible.** Delete the archive file + the folder = system gone, no trace.

---

## 10. Recommended sequence (what to actually do, in order)

1. ✅ **Agree this roadmap** (you're here).
2. **Phase 0 archiver** — start banking Stream D history. (Highest urgency: data clock.)
3. Let history accumulate a week+ while we **design the strategy config** precisely
   (your cascade + RSI pullback + key-level idea → exact rules).
4. **Phase 1 harness** on the laptop, validated against `validation_trials`.
5. **Phase 2 sweep** → first leaderboard of cascade-at-level variants.
6. Stand up **VM2 + Hermes** only once Phases 1–2 show a real, stable edge worth
   searching harder for.

---

## 11. Glossary (for the new-to-this bits)

- **Backtest** — replay past data, apply a rule, measure hypothetical P&L.
- **Param / knob** — a number in your rule (RSI threshold, % distance, which TFs).
- **Param sweep** — trying many knob combinations automatically.
- **Optuna / Bayesian optimization** — a smart way to search knobs without brute force.
- **LLM** — large language model (text-reasoning AI). Hermes is an open one.
- **Ollama** — easiest way to run an open LLM locally/in Docker.
- **Coolify** — self-hosted platform (like a personal Heroku) to deploy Docker apps on a VM.
- **Expectancy** — average profit per trade; the headline backtest metric.
- **Max drawdown (maxDD)** — worst peak-to-trough loss; the headline risk metric.
- **Regime** — the market "mood" (trending/choppy/high-vol); strategies live or die by it.

---

## 12. Open questions to resolve before Phase 1 (not blocking Phase 0)

1. **Exit rules** — fixed TP/SL %, or signal-based (cascade flip), or both? (affects metrics)
2. **Ground truth** — replay `validation_trials` first (fast), then simulate forward
   returns from `coin_metric_history` price/dist? (Recommended: both, in that order.)
3. **Universe** — backtest only Stream B watchlist coins at each point in time, or all
   coins ever seen? (Watchlist = realistic; all = more data.)
4. **Reasoning model** — Hermes vs another local model vs a cheap API for the loop. Decide
   at Phase 4, not now.

---

*Next concrete deliverable when you say go: the Phase 0 archiver (separate DB, env-gated,
off by default). It changes nothing about the live system and starts saving the one
resource we can't get back — Stream D history.*
