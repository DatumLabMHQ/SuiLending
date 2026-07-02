/**
 * DefiLlama TVL backfill — shared between the manual CLI script
 * (scripts/backfill-defillama.ts) and the daily cron
 * (/api/cron/backfill-defillama).
 *
 * Why this exists as a lib: the live dashboard's TVL-by-Protocol chart and
 * Daily Flows fall back to DefillamaTvl whenever per-day PoolDaily is sparse.
 * Without this table staying current the chart shows a stale right edge.
 *
 * DefiLlama's `/protocol/<slug>` endpoint returns `tvl: [{date, totalLiquidityUSD}]`
 * going back 1-3 years. We upsert one row per (protocol, date).
 */

import type { PrismaClient } from '@prisma/client';

// Map our internal protocol slug → DefiLlama protocol slug.
export const PROTOCOL_LLAMA_SLUG: Record<string, string> = {
  navi:      'navi-protocol',
  suilend:   'suilend',
  scallop:   'scallop',
  alphalend: 'alphalend',
  bucket:    'bucket-protocol',
};

interface LlamaTvlPoint { date: number; totalLiquidityUSD: number }

export interface BackfillResult {
  protocol: string;
  inserted: number;
  failed: number;
  first: string;
  last: string;
  /** Set when the whole call bailed (HTTP error, empty payload, fetch threw). */
  error?: string;
}

/**
 * Fetch DefiLlama TVL history for one protocol and upsert every point.
 *
 * Never throws — captures errors per protocol so one failing doesn't kill
 * the rest of the batch when called from a cron. Failures land in
 * `result.error` and Vercel surfaces structured console.error logs.
 *
 * Optional `sinceDays`: only upsert rows from the last N days. Default is
 * unlimited (full history). The daily cron passes `60` so it's idempotent
 * and cheap — covers any gap up to 2 months without rewriting the full
 * 1-3 year history every day.
 */
export async function backfillOne(
  db: PrismaClient,
  protocol: string,
  slug: string,
  sinceDays?: number,
): Promise<BackfillResult> {
  const result: BackfillResult = { protocol, inserted: 0, failed: 0, first: '', last: '' };
  let res: Response;
  try {
    res = await fetch(`https://api.llama.fi/protocol/${slug}`, {
      // Tighter timeout than browser default so a hung DefiLlama doesn't hold
      // the whole cron invocation up to its 60s Vercel limit. AbortSignal.timeout
      // is a standard fetch option since Node 18.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    result.error = `fetch threw: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[defillama-backfill] ${protocol}/${slug} ${result.error}`);
    return result;
  }
  if (!res.ok) {
    result.error = `HTTP ${res.status}`;
    console.error(`[defillama-backfill] ${protocol}/${slug} ${result.error}`);
    return result;
  }
  let data: { tvl?: LlamaTvlPoint[] };
  try {
    data = await res.json();
  } catch (e) {
    result.error = `bad JSON: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[defillama-backfill] ${protocol}/${slug} ${result.error}`);
    return result;
  }
  const history = data.tvl ?? [];
  if (history.length === 0) {
    result.error = 'no tvl history from DefiLlama';
    console.warn(`[defillama-backfill] ${protocol}/${slug} ${result.error}`);
    return result;
  }

  const cutoffSec = sinceDays
    ? Math.floor((Date.now() - sinceDays * 86400 * 1000) / 1000)
    : 0;

  for (const entry of history) {
    if (typeof entry?.totalLiquidityUSD !== 'number' || !Number.isFinite(entry.totalLiquidityUSD)) continue;
    // Guard: DefiLlama sometimes drops a protocol's listing and reports 0 for it
    // (AlphaLend did exactly this from Jun 2026). A live protocol is never truly
    // $0, so writing it would clobber a good historical value — skip zero reads.
    if (entry.totalLiquidityUSD <= 0) continue;
    if (entry.date < cutoffSec) continue;
    const date = new Date(entry.date * 1000);
    date.setUTCHours(0, 0, 0, 0);
    const dStr = date.toISOString().slice(0, 10);
    if (!result.first) result.first = dStr;
    result.last = dStr;
    try {
      await db.defillamaTvl.upsert({
        where: { protocol_date: { protocol, date } },
        create: { protocol, date, tvlUsd: entry.totalLiquidityUSD },
        update: { tvlUsd: entry.totalLiquidityUSD },
      });
      result.inserted++;
    } catch (err) {
      result.failed++;
      if (result.failed <= 3) {
        console.warn(`[defillama-backfill] ${protocol} skip ${dStr}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return result;
}

/**
 * Backfill every protocol. Per-protocol failures are isolated — one
 * protocol's HTTP error or DB error doesn't stop the rest. Returns all
 * results so callers can decide how to surface failures.
 */
export async function backfillAll(db: PrismaClient, sinceDays?: number): Promise<BackfillResult[]> {
  const results: BackfillResult[] = [];
  for (const [protocol, slug] of Object.entries(PROTOCOL_LLAMA_SLUG)) {
    results.push(await backfillOne(db, protocol, slug, sinceDays));
  }
  return results;
}
