/**
 * Public data-health endpoint.
 *
 * Returns the freshness state of every data source the dashboard depends on,
 * with explicit ok / stale / broken status per source. External monitors
 * (UptimeRobot, Better Uptime, etc.) should poll this:
 *
 *   - HTTP 200 → all sources ok
 *   - HTTP 200 + body status='stale' → late but not broken (still rendering)
 *   - HTTP 503 → at least one source is broken (no fresh write within 3×
 *     its expected cadence)
 *
 * Configure your monitor to alert on 503 and on response-body
 * `status === 'broken'`. Hit interval: every 5-10 minutes is plenty —
 * crons here are daily.
 *
 * No auth — this is purely status info, no sensitive data.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataSource, platformQuery } from '@/lib/data-source';

export const dynamic = 'force-dynamic';

type SourceStatus = 'ok' | 'stale' | 'broken';
interface SourceCheck {
  source: string;
  status: SourceStatus;
  latest: string | null;
  ageHours: number | null;
  /** Expected freshness in hours (warn beyond, fail at 3×). */
  expectedHours: number;
  detail: string;
}

const ALL_PROTOCOLS = ['navi', 'suilend', 'scallop', 'alphalend', 'bucket'];

function classify(latestMs: number | null, expectedHours: number): { status: SourceStatus; ageHours: number | null } {
  if (latestMs == null) return { status: 'broken', ageHours: null };
  const ageHours = (Date.now() - latestMs) / 3_600_000;
  if (ageHours <= expectedHours) return { status: 'ok', ageHours };
  if (ageHours <= expectedHours * 3) return { status: 'stale', ageHours };
  return { status: 'broken', ageHours };
}

/**
 * Platform path (DATA_SOURCE=platform, since the 2026-09-11 cut-over): freshness comes from the Datum
 * data platform, not this app's legacy scanner tables. Three families of check per protocol:
 *   - the platform's own source-freshness row (each upstream the hourly build read, expected cadence
 *     recorded by the platform itself),
 *   - the pool mart (one row per protocol per day; expected within 36h),
 *   - the liquidation indexer's last successful run (a run that wrote zero rows is healthy: a protocol
 *     with no liquidations is not a broken source).
 */
async function platformHealth() {
  const checks: SourceCheck[] = [];
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : null);
  try {
    const fresh = await platformQuery<{ source_id: string; expected_hours: string; last_seen_at: Date; last_status: string }>(
      `SELECT source_id, expected_hours, last_seen_at, last_status FROM ops.source_freshness WHERE product = 'sui' ORDER BY source_id`,
    );
    for (const r of fresh) {
      const exp = Number(r.expected_hours) || 36;
      const c = classify(r.last_seen_at ? new Date(r.last_seen_at).getTime() : null, exp);
      const status: SourceStatus = r.last_status !== 'ok' && c.status === 'ok' ? 'stale' : c.status;
      checks.push({ source: `platform/${r.source_id}`, status, latest: iso(r.last_seen_at), ageHours: c.ageHours, expectedHours: exp,
        detail: status === 'ok' ? `Last read ${iso(r.last_seen_at)} (${r.last_status})` : `Platform last read this source ${iso(r.last_seen_at) ?? 'never'}, status ${r.last_status}` });
    }
    const pools = await platformQuery<{ protocol: string; last: Date }>(`SELECT protocol, MAX(day) AS last FROM sui.fct_sui_pool_daily GROUP BY protocol`);
    for (const p of ALL_PROTOCOLS) {
      const row = pools.find((r) => r.protocol === p);
      // A day row covers the whole day: age it from the end of that day.
      const latest = row?.last ? new Date(row.last).getTime() + 24 * 3_600_000 : null;
      const c = classify(latest, 36);
      checks.push({ source: `sui.fct_sui_pool_daily/${p}`, status: c.status, latest: row?.last ? new Date(row.last).toISOString().slice(0, 10) : null, ageHours: c.ageHours, expectedHours: 36,
        detail: c.status === 'ok' ? `Last day ${new Date(row!.last).toISOString().slice(0, 10)}` : `No pool rows for ${p} since ${row?.last ? new Date(row.last).toISOString().slice(0, 10) : 'ever'}` });
    }
    const runs = await platformQuery<{ job: string; last: Date }>(
      `SELECT job, MAX(finished_at) AS last FROM ops.sync_runs WHERE job LIKE 'sui.index_liquidations.%' AND status = 'ok' GROUP BY job`,
    );
    for (const p of ALL_PROTOCOLS) {
      const row = runs.find((r) => r.job === `sui.index_liquidations.${p}`);
      const c = classify(row?.last ? new Date(row.last).getTime() : null, 48);
      checks.push({ source: `sui.index_liquidations/${p}`, status: c.status, latest: iso(row?.last), ageHours: c.ageHours, expectedHours: 48,
        detail: c.status === 'ok' ? `Indexer last succeeded ${iso(row?.last)}` : `No successful liquidation index run for ${p} since ${iso(row?.last) ?? 'ever'}` });
    }
  } catch (e) {
    checks.push({ source: 'platform', status: 'broken', latest: null, ageHours: null, expectedHours: 36, detail: `Platform query failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  return finish(checks, 'platform');
}

function finish(checks: SourceCheck[], source: 'legacy' | 'platform') {
  const broken = checks.filter((c) => c.status === 'broken').length;
  const stale = checks.filter((c) => c.status === 'stale').length;
  const ok = checks.length - broken - stale;
  const status: SourceStatus = broken > 0 ? 'broken' : stale > 0 ? 'stale' : 'ok';
  return NextResponse.json(
    { status, dataSource: source, summary: `${ok} ok · ${stale} stale · ${broken} broken`, checkedAt: new Date().toISOString(), checks, brokenSources: checks.filter((c) => c.status === 'broken').map((c) => c.source) },
    { status: broken > 0 ? 503 : 200, headers: { 'Cache-Control': 'no-store, max-age=0', 'Access-Control-Allow-Origin': '*' } },
  );
}

export async function GET() {
  if (dataSource() === 'platform') return platformHealth();
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { status: 'broken', error: 'No database configured', sources: [] },
      { status: 503 },
    );
  }

  const checks: SourceCheck[] = [];

  // 1. DefillamaTvl — once daily backfill cron, expected within 36h of being
  //    written. Beyond 72h = broken.
  try {
    const rows = (await db.$queryRawUnsafe(`
      SELECT protocol, MAX(date) AS last FROM "DefillamaTvl" GROUP BY protocol
    `)) as Array<{ protocol: string; last: Date }>;
    for (const p of ALL_PROTOCOLS) {
      const row = rows.find((r) => r.protocol === p);
      const latest = row?.last ? new Date(row.last).getTime() : null;
      const c = classify(latest, 36);
      checks.push({
        source: `DefillamaTvl/${p}`,
        status: c.status,
        latest: row?.last ? row.last.toISOString().slice(0, 10) : null,
        ageHours: c.ageHours,
        expectedHours: 36,
        detail: c.status === 'broken'
          ? `No DefillamaTvl writes for ${p} in 72h — backfill cron may have failed`
          : `Last ${row?.last ? row.last.toISOString().slice(0, 10) : 'never'}`,
      });
    }
  } catch (e) {
    checks.push({
      source: 'DefillamaTvl',
      status: 'broken',
      latest: null, ageHours: null, expectedHours: 36,
      detail: `Query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 2. PoolSnapshot per protocol — daily collect-pools cron, expect within 36h.
  try {
    const rows = (await db.$queryRawUnsafe(`
      SELECT protocol, MAX(timestamp) AS last FROM "PoolSnapshot" GROUP BY protocol
    `)) as Array<{ protocol: string; last: Date }>;
    for (const p of ALL_PROTOCOLS) {
      const row = rows.find((r) => r.protocol === p);
      const latest = row?.last ? new Date(row.last).getTime() : null;
      const c = classify(latest, 36);
      checks.push({
        source: `PoolSnapshot/${p}`,
        status: c.status,
        latest: row?.last ? row.last.toISOString().slice(0, 16) : null,
        ageHours: c.ageHours,
        expectedHours: 36,
        detail: c.status === 'broken'
          ? `No PoolSnapshot writes for ${p} in 108h — collect-pools cron may have failed`
          : `Last ${row?.last ? row.last.toISOString().slice(0, 16) : 'never'} UTC`,
      });
    }
  } catch (e) {
    checks.push({
      source: 'PoolSnapshot',
      status: 'broken',
      latest: null, ageHours: null, expectedHours: 36,
      detail: `Query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 3. LiquidationEvent per protocol — once-daily index, expected within 48h
  //    (events are bursty; a real quiet 24-hour window is fine).
  //    Bucket skipped — Bucket doesn't liquidate, it redeems.
  try {
    const rows = (await db.$queryRawUnsafe(`
      SELECT protocol, MAX(timestamp) AS last FROM "LiquidationEvent" GROUP BY protocol
    `)) as Array<{ protocol: string; last: Date }>;
    for (const p of ALL_PROTOCOLS) {
      if (p === 'bucket') continue;
      const row = rows.find((r) => r.protocol === p);
      const latest = row?.last ? new Date(row.last).getTime() : null;
      const c = classify(latest, 48);
      checks.push({
        source: `LiquidationEvent/${p}`,
        status: c.status,
        latest: row?.last ? row.last.toISOString().slice(0, 16) : null,
        ageHours: c.ageHours,
        expectedHours: 48,
        detail: c.status === 'broken'
          ? `No liquidation events for ${p} in 144h — index-liquidations cron may have failed`
          : `Last event ${row?.last ? row.last.toISOString().slice(0, 16) : 'never'} UTC`,
      });
    }
  } catch (e) {
    checks.push({
      source: 'LiquidationEvent',
      status: 'broken',
      latest: null, ageHours: null, expectedHours: 48,
      detail: `Query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 4. RateModelParams — should have non-zero ltv/lt for the 4 pool protocols.
  //    Bucket's RateModelParams is sparse by design (CDP).
  try {
    const rows = (await db.$queryRawUnsafe(`
      SELECT protocol,
             COUNT(*) FILTER (WHERE ltv > 0)::int AS with_ltv,
             COUNT(*) FILTER (WHERE "liquidationThreshold" > 0)::int AS with_lt,
             COUNT(*)::int AS total,
             MAX("updatedAt") AS last
      FROM "RateModelParams" GROUP BY protocol
    `)) as Array<{ protocol: string; with_ltv: number; with_lt: number; total: number; last: Date }>;
    for (const p of ALL_PROTOCOLS) {
      if (p === 'bucket') continue; // CDP — risk params shaped differently
      const row = rows.find((r) => r.protocol === p);
      if (!row || row.total === 0) {
        checks.push({
          source: `RateModelParams/${p}`,
          status: 'broken',
          latest: null, ageHours: null, expectedHours: 24,
          detail: `No RateModelParams rows for ${p}`,
        });
        continue;
      }
      const latest = row.last ? new Date(row.last).getTime() : null;
      const ageHours = latest ? (Date.now() - latest) / 3_600_000 : null;
      // Risk params should be touched every collect-pools run (each market).
      // Beyond 36h means the upsert path isn't running.
      const status: SourceStatus = row.with_lt === 0 ? 'broken'
        : ageHours == null || ageHours > 108 ? 'broken'
        : ageHours > 36 ? 'stale' : 'ok';
      checks.push({
        source: `RateModelParams/${p}`,
        status,
        latest: row.last ? row.last.toISOString().slice(0, 16) : null,
        ageHours,
        expectedHours: 36,
        detail: `${row.with_lt}/${row.total} markets have LT > 0 · last updated ${row.last ? row.last.toISOString().slice(0, 16) : 'never'} UTC`,
      });
    }
  } catch (e) {
    checks.push({
      source: 'RateModelParams',
      status: 'broken',
      latest: null, ageHours: null, expectedHours: 36,
      detail: `Query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Overall verdict
  const broken = checks.filter((c) => c.status === 'broken');
  const stale = checks.filter((c) => c.status === 'stale');
  const overall: SourceStatus = broken.length > 0 ? 'broken' : stale.length > 0 ? 'stale' : 'ok';
  const summary = `${checks.filter((c) => c.status === 'ok').length} ok · ${stale.length} stale · ${broken.length} broken`;

  return NextResponse.json(
    {
      status: overall,
      summary,
      checkedAt: new Date().toISOString(),
      checks,
      // Quick list of just the broken ones — easy for monitor alert text.
      brokenSources: broken.map((c) => c.source),
    },
    {
      status: overall === 'broken' ? 503 : 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        // Allow monitors from anywhere to read this.
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
