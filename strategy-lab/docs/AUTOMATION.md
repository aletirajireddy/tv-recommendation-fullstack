# Automation — set it and forget it

Goal: the archiver runs **automatically** wherever your live data is generated, so
you never have to remember to back up. Pick the row that matches the machine.

| Machine | Method | One-time setup |
|---|---|---|
| Windows laptop | Task Scheduler | `deploy/windows/install-task.ps1` |
| Linux VM (always-on) | systemd timer | `deploy/linux/install-systemd.sh` |
| Any (VM2 / Coolify) | Docker | `deploy/docker/docker-compose.yml` |
| Linux (simple) | cron | `deploy/linux/cron.example` |

All methods run `node src/archive/runArchiver.js --once` every ~2 minutes. The
archiver is incremental, so each run just grabs whatever is new.

**Prerequisite for every method:** a `.env` file in the strategy-lab root with
`ARCHIVE_ENABLED=true` and a correct `LIVE_DB_PATH`. Without it the archiver no-ops.

---

## Windows (laptop) — Task Scheduler

Captures the previous session's data at logon/startup (before the live app prunes
it) and repeats every 2 minutes while the machine is on.

```powershell
cd <path>\strategy-lab
copy .env.example .env        # then edit: ARCHIVE_ENABLED=true
# Admin PowerShell:
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
npm run health                # verify rows are landing
```

Remove: `powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-task.ps1`

> Note: Task Scheduler runs only while the machine is on. That's fine — no data is
> generated while it's off anyway. The risk is a long-off laptop losing the prior
> session on boot; the startup trigger minimizes it, but for guaranteed history run
> the archiver on the always-on VM1 too.

---

## Linux VM (always-on) — systemd timer  ← recommended for durability

`Persistent=true` makes it catch up one run immediately after any downtime.

```bash
cd /opt/strategy-lab
cp .env.example .env          # then edit: ARCHIVE_ENABLED=true, LIVE_DB_PATH=...
sudo bash deploy/linux/install-systemd.sh
npm run health
journalctl -u strategy-lab-archiver.service -f   # watch it run
```

Uninstall:
```bash
sudo systemctl disable --now strategy-lab-archiver.timer
sudo rm /etc/systemd/system/strategy-lab-archiver.{service,timer}
sudo systemctl daemon-reload
```

---

## Docker / Coolify (VM2)

Runs a continuous loop in an isolated container; live DB mounted read-only.

```bash
cd strategy-lab
LIVE_DB=/abs/path/to/dashboard_v3.db \
  docker compose -f deploy/docker/docker-compose.yml up -d --build
docker compose -f deploy/docker/docker-compose.yml logs -f
```

In Coolify: add a Compose resource pointing at `deploy/docker/docker-compose.yml`,
set the `LIVE_DB` bind path and the `ARCHIVE_*` env vars. The archive persists in
the `strategy_lab_data` named volume.

---

## cron (simple Linux alternative)

```bash
crontab -e
# paste (edit paths):
*/2 * * * * cd /opt/strategy-lab && /usr/bin/node src/archive/runArchiver.js --once >> /var/log/strategy-lab-archiver.log 2>&1
```

cron does **not** catch up missed runs after downtime (systemd does) — fine for an
always-on box.

---

## Verifying it's working

Run anytime:

```bash
npm run health
```

It reports archived row counts, **timeline coverage %**, the **largest gap**, and
**how long since the last run**. Watch for:

- `coverage` well below 100% → the archiver isn't running often enough.
- `largest gap exceeds live ~8h retention` → permanent loss happened during
  downtime; move archiving to the always-on machine.
- `archiver hasn't run in >15m` → the scheduler/timer/container is down.
