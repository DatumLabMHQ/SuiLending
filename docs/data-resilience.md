# Data resilience — keeping the dashboard from going stale

The dashboard is a public surface that many people rely on. Anything we don't
automate is a data-outage waiting to happen. This document is the operator
runbook for keeping every data source live.

## What's automated

| Source | Cron path | Schedule (UTC) | Window | Notes |
|---|---|---|---|---|
| PoolSnapshot (NAVI/Suilend/Scallop/AlphaLend/Bucket) | `/api/<protocol>/cron/collect-pools` | 00:00, 00:10, 00:20, 00:30, 00:40 | live | Pool TVL, APYs, util — feeds dashboard headlines |
| LiquidationEvent (4 pool protocols) | `/api/<protocol>/cron/index-liquidations` | 00:15, 00:25, 00:35, 00:45 | live | Bucket excluded (CDPs don't liquidate, they redeem) |
| PoolDaily aggregates (5 protocols) | `/api/<protocol>/cron/aggregate-daily` | 01:05, 01:15, 01:25, 01:35, 01:45 | yesterday's roll-up | Per-day per-symbol history |
| **DefillamaTvl backfill (RES-1)** | `/api/cron/backfill-defillama` | **02:00** | last 60 days | Fills the TVL-by-Protocol chart and Daily Flows |
| **Self-heal catch-up (RES-3)** | `/api/cron/catch-up` | **03:00** | last 14 days | Detects gaps in DefillamaTvl + stale PoolSnapshot, re-runs |
| Wallet index (NAVI only) | `/api/navi/cron/index-wallets` | Sunday 00:30 | weekly | NAVI is the only wallet-indexed protocol today |

## Monitoring — `/api/data-health`

Public endpoint, no auth. External monitor should poll every 5-10 minutes.

Statuses:
- **200 + body `status: "ok"`** — all green
- **200 + body `status: "stale"`** — at least one source is late but rendering still works
- **503 + body `status: "broken"`** — at least one source has no fresh write within 3× its expected cadence

Body shape:
```json
{
  "status": "ok" | "stale" | "broken",
  "summary": "12 ok · 0 stale · 0 broken",
  "checkedAt": "2026-06-12T17:45:00Z",
  "brokenSources": ["DefillamaTvl/scallop"],   // empty when all healthy
  "checks": [
    {
      "source": "DefillamaTvl/navi",
      "status": "ok",
      "latest": "2026-06-12",
      "ageHours": 13.4,
      "expectedHours": 36,
      "detail": "Last 2026-06-12"
    }
  ]
}
```

Recommended monitor setup (UptimeRobot or Better Uptime):
1. Add HTTP check on `https://suilending.datumlabs.workers.dev/api/data-health`
2. Alert condition: HTTP status ≠ 200 OR response body contains `"status":"broken"`
3. Alert channel: Slack / email / on-call

## Failure modes and how the system self-heals

| Failure | Detection | Self-heal |
|---|---|---|
| DefiLlama API rate-limited one day | `/api/data-health` flips a `DefillamaTvl/<protocol>` to `stale` | Next-day catch-up cron re-runs that protocol via `backfillOne` (idempotent upsert) |
| Vercel cron silently doesn't fire | `/api/data-health` flips affected sources to `stale` then `broken` after 3× window | Catch-up at 03:00 UTC scans for gaps and re-runs collect-pools in-process |
| Adapter SDK throws on one protocol | per-protocol failure isolation — others continue | Next-day re-run; persistent failures alert via monitor |
| Sui RPC down | LiquidationEvent index fails for that day | Next-day cron re-indexes from `untilEventId` cursor, no data lost |
| One field stops being written (the NAVI `ltv` regression) | `/api/data-health` flips `RateModelParams/<protocol>` to `broken` when LT=0 for all markets | Manual fix; the architecture from P0-ROOT-V2 (RateModelParams holds, PoolSnapshot transient) means previous good values persist |
| Total DB outage | `/api/data-health` returns 503 | External monitor pages; manual recovery |

## Manual escape hatches

When something's wrong and you need to fix it without waiting for the next cron:

```bash
# Re-run DefiLlama backfill (covers up to 3 years of history per protocol)
set -a && source .env.local && set +a
npx tsx scripts/backfill-defillama.ts

# Re-run NAVI risk-param repair (the P0-ROOT-V2 architecture)
npx tsx scripts/repair-risk-params-v2.ts

# Audit data coverage end-to-end
npx tsx scripts/may-to-now-coverage.ts

# Health check (the same one the monitor polls)
curl https://suilending.datumlabs.workers.dev/api/data-health | jq
```

## Vercel cron budget

Total cron invocations / day: **21** (was 18 before RES-1 + RES-3).
Vercel Hobby plan limit: 40/day. Pro: unlimited. Well within budget either way.

## Recovery runbook (operator quick-ref)

**Symptom: dashboard shows "BROKEN" badge**
1. Hit `/api/data-health` → see which `source` is in `brokenSources`
2. Vercel dashboard → Crons tab → find the matching cron path → check last run + logs
3. If the cron logged a structured error (`[cron/<name>] ... ERROR: ...`), the message tells you what failed
4. Manual repair: run the matching script from the manual escape hatches above, OR re-invoke the cron URL with `curl -H "Authorization: Bearer $CRON_SECRET"`
5. After repair, hit `/api/data-health` again → should be `ok` within 5 min (Vercel edge cache)

**Symptom: TVL chart's right edge is stale**
1. Hit `/api/data-health` — does `DefillamaTvl/<protocol>` show `stale` or `broken`?
2. If broken, re-run the backfill script manually
3. The catch-up cron at 03:00 UTC the next day will fix it automatically; you can also hit `/api/cron/catch-up` with the bearer token if you want it now

**Symptom: liquidations page shows 0 events**
1. Hit `/api/data-health` — check `LiquidationEvent/<protocol>` sources
2. If all four are broken on the same day, it's likely the Sui RPC. Wait 30 min and check `/api/data-health` again
3. If only one protocol is broken, that protocol's `index-liquidations` cron failed; check Vercel logs
