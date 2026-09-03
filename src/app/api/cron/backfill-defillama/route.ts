/**
 * Daily DefiLlama TVL backfill cron.
 *
 * Scheduled: 02:00 UTC daily (vercel.json). Hits DefiLlama for all 5
 * protocols, upserts the last 60 days of TVL into DefillamaTvl. The 60-day
 * window keeps the cron cheap (idempotent — same upserts each run) and
 * covers any cron-failure gap up to 2 months without rewriting the full
 * 1-3 year history every day.
 *
 * Why this exists: pre-2026-06-12 the backfill was a MANUAL script
 * (scripts/backfill-defillama.ts). The dashboard ran 15 days stale because
 * no one re-ran it. Many people rely on this dashboard — anything we don't
 * automate is a data-outage waiting to happen.
 *
 * Per-protocol failure isolation: one protocol failing (DefiLlama down,
 * slug renamed, rate limit) does NOT stop the others. Returns 200 with
 * per-protocol status when at least one succeeded; 503 only when ALL
 * fail (the actual outage).
 *
 * Auth: CRON_SECRET via Authorization: Bearer header. Vercel cron jobs
 * carry this automatically when configured via vercel.json + Vercel env.
 */

import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { backfillAll } from '@/lib/defillama-backfill';

export const dynamic = 'force-dynamic';
// Allow up to 60s on Vercel (5 protocols × ~10s each in the worst case).
export const maxDuration = 60;

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!cronAuthorized(authHeader)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    console.error('[cron/backfill-defillama] no database configured');
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  const started = Date.now();
  const results = await backfillAll(db, 60); // last 60 days
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  const errored = results.filter((r) => r.error);
  const ok = results.filter((r) => !r.error && r.inserted > 0);

  // Structured log line — Vercel logs are the alerting layer. A daily run
  // that doesn't show up at all (or shows totalInserted=0) tells you the
  // cron is broken; per-protocol error lines tell you which one.
  console.log(
    `[cron/backfill-defillama] ${ok.length}/${results.length} protocols ok · ` +
      `inserted=${totalInserted} failed=${totalFailed} ms=${Date.now() - started}`,
  );
  for (const r of errored) {
    console.error(`[cron/backfill-defillama] ${r.protocol} ERROR: ${r.error}`);
  }

  // Return 503 ONLY when every protocol failed — partial failure still
  // means the dashboard's most-fresh days were updated for the protocols
  // that worked. External monitors poll /api/data-health for richer
  // breakdowns; this endpoint just answers "did the cron run successfully".
  const allFailed = ok.length === 0;
  return NextResponse.json(
    {
      success: !allFailed,
      ms: Date.now() - started,
      totalInserted,
      totalFailed,
      perProtocol: results,
    },
    { status: allFailed ? 503 : 200 },
  );
}
