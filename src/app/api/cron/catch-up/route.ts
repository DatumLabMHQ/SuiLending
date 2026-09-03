/**
 * Self-healing catch-up cron.
 *
 * Scheduled: 03:00 UTC daily (vercel.json), one hour after the main
 * collect-pools / backfill-defillama crons finish. Scans for data gaps
 * in the last 14 days and tries to fill them. Idempotent — if everything
 * is current it's effectively a no-op.
 *
 * The dashboard has multiple cron paths that can silently fail (Vercel
 * cron retries are limited, DefiLlama can rate-limit, an adapter can
 * error one day and recover the next). Without this catch-up, gaps
 * persist forever. With it, anything missed within 14 days self-repairs
 * the next morning.
 *
 * What it does, in order:
 *   1. DefillamaTvl — for each protocol, find gap days in the last 14
 *      and re-run the backfill (which is itself idempotent).
 *   2. PoolSnapshot freshness — check each protocol has a row in the
 *      last 36 hours. If not, trigger that protocol's collect-pools
 *      handler directly (rather than waiting another 24h).
 *
 * Auth: CRON_SECRET via Authorization: Bearer header.
 */

import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { backfillAll, PROTOCOL_LLAMA_SLUG } from '@/lib/defillama-backfill';
import { getProtocol } from '@/protocols/registry';
import type { PrismaClient } from '@prisma/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface CatchUpReport {
  defillama: { gapsDetected: number; backfillRan: boolean; inserted: number };
  collectPools: Array<{ protocol: string; ageHours: number | null; reran: boolean; error?: string }>;
}

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!cronAuthorized(authHeader)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    console.error('[cron/catch-up] no database configured');
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  const report: CatchUpReport = {
    defillama: { gapsDetected: 0, backfillRan: false, inserted: 0 },
    collectPools: [],
  };

  // ── 1. DefillamaTvl gap check ──────────────────────────────────────
  // For each of the last 14 days, count how many protocols have a row.
  // Any day missing a row for any protocol = gap. If we find any, just
  // re-run backfillAll with sinceDays=14 (idempotent upsert).
  try {
    const expectedRows = 5 * 14; // 5 protocols × 14 days
    const presentRows = (await db.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n FROM "DefillamaTvl"
      WHERE date >= (CURRENT_DATE - INTERVAL '14 days')::date
    `)) as Array<{ n: number }>;
    const present = presentRows[0]?.n ?? 0;
    const gaps = Math.max(0, expectedRows - present);
    report.defillama.gapsDetected = gaps;
    if (gaps > 0) {
      const results = await backfillAll(db, 14);
      report.defillama.backfillRan = true;
      report.defillama.inserted = results.reduce((s, r) => s + r.inserted, 0);
      const errored = results.filter((r) => r.error);
      for (const r of errored) {
        console.error(`[cron/catch-up] defillama backfill ${r.protocol} error: ${r.error}`);
      }
    }
  } catch (e) {
    console.error(`[cron/catch-up] defillama gap check failed: ${e instanceof Error ? e.message : e}`);
  }

  // ── 2. PoolSnapshot freshness check ────────────────────────────────
  // For each protocol, find the latest snapshot. If older than 36h, try
  // to call its collect-pools cron handler in-process. Failure isolated
  // per protocol — one slow adapter doesn't take the whole job down.
  try {
    const latestRows = (await db.$queryRawUnsafe(`
      SELECT protocol, MAX(timestamp) AS last FROM "PoolSnapshot" GROUP BY protocol
    `)) as Array<{ protocol: string; last: Date }>;
    for (const slug of Object.keys(PROTOCOL_LLAMA_SLUG)) {
      const row = latestRows.find((r) => r.protocol === slug);
      const ageHours = row?.last ? (Date.now() - new Date(row.last).getTime()) / 3_600_000 : null;
      const stale = ageHours == null || ageHours > 36;
      const item: CatchUpReport['collectPools'][number] = { protocol: slug, ageHours, reran: false };
      if (stale) {
        try {
          await rerunCollectPools(db, slug);
          item.reran = true;
        } catch (e) {
          item.error = e instanceof Error ? e.message : String(e);
          console.error(`[cron/catch-up] collect-pools re-run failed for ${slug}: ${item.error}`);
        }
      }
      report.collectPools.push(item);
    }
  } catch (e) {
    console.error(`[cron/catch-up] pool freshness check failed: ${e instanceof Error ? e.message : e}`);
  }

  console.log(
    `[cron/catch-up] defillama gaps=${report.defillama.gapsDetected} inserted=${report.defillama.inserted} · ` +
    `pools stale=${report.collectPools.filter((p) => p.reran).length} errored=${report.collectPools.filter((p) => p.error).length}`,
  );

  return NextResponse.json({ ok: true, report });
}

/**
 * Mirror what /api/[protocol]/cron/collect-pools does, but in-process so
 * the catch-up doesn't have to make an HTTP self-call. Keep this tight —
 * the source of truth for cron writes is still the dedicated route, this
 * is just the disaster-recovery path.
 */
async function rerunCollectPools(db: PrismaClient, slug: string): Promise<void> {
  const entry = getProtocol(slug);
  if (!entry) throw new Error(`unknown protocol: ${slug}`);
  const pools = await entry.adapter.fetchPools();
  if (pools.length === 0) {
    console.warn(`[cron/catch-up] ${slug} fetchPools returned 0 — skip`);
    return;
  }
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const snapshots = pools.map((pool) => ({
    protocol: slug,
    symbol: pool.symbol,
    totalSupply: num(pool.totalSupply),
    totalSupplyUsd: num(pool.totalSupplyUsd),
    totalBorrows: num(pool.totalBorrows),
    totalBorrowsUsd: num(pool.totalBorrowsUsd),
    availableLiquidity: num(pool.availableLiquidity),
    availableLiquidityUsd: num(pool.availableLiquidityUsd),
    supplyApy: num(pool.supplyApy),
    borrowApy: num(pool.borrowApy),
    utilization: num(pool.utilization),
    price: num(pool.price),
    ltv: num(pool.ltv),
    liquidationThreshold: num(pool.liquidationThreshold),
  }));
  await db.poolSnapshot.createMany({ data: snapshots });

  // Upsert RateModelParams with the same > 0 protection as the main cron.
  for (const pool of pools) {
    const ltv = num(pool.ltv);
    const liquidationThreshold = num(pool.liquidationThreshold);
    const irm = pool.irm;
    try {
      await db.rateModelParams.upsert({
        where: { protocol_symbol: { protocol: slug, symbol: pool.symbol } },
        update: {
          ...(irm ? {
            baseRate: num(irm.baseRate), multiplier: num(irm.multiplier),
            jumpMultiplier: num(irm.jumpMultiplier), kink: num(irm.kink),
            reserveFactor: num(irm.reserveFactor),
          } : {}),
          ...(ltv > 0 ? { ltv } : {}),
          ...(liquidationThreshold > 0 ? { liquidationThreshold } : {}),
          updatedAt: new Date(),
        },
        create: {
          protocol: slug, symbol: pool.symbol,
          baseRate: num(irm?.baseRate), multiplier: num(irm?.multiplier),
          jumpMultiplier: num(irm?.jumpMultiplier), kink: num(irm?.kink),
          reserveFactor: num(irm?.reserveFactor),
          ltv, liquidationThreshold,
        },
      });
    } catch (e) {
      console.warn(`[cron/catch-up] ${slug}/${pool.symbol} rmp upsert: ${e instanceof Error ? e.message : e}`);
    }
  }
}
