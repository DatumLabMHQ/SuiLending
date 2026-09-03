import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/constants';
import { getProtocol } from '@/protocols/registry';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Daily aggregation cron.
 * Aggregates yesterday's PoolSnapshot rows into PoolDaily averages.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ protocol: string }> }
) {
  const authHeader = req.headers.get('authorization');
  if (!cronAuthorized(authHeader)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { protocol: slug } = await params;
  const entry = getProtocol(slug);

  if (!entry) {
    return NextResponse.json({ error: `Unknown protocol: ${slug}` }, { status: 404 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  try {
    // Accept ?day=today | yesterday | YYYY-MM-DD. Default is yesterday,
    // matching the nightly cron's contract. Useful for backfilling today's
    // rollup on-demand without waiting 24h.
    const { searchParams } = new URL(req.url);
    const dayParam = searchParams.get('day') ?? 'yesterday';

    const yesterday = new Date();
    if (dayParam === 'today') {
      // keep today's date
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      const [y, m, d] = dayParam.split('-').map(Number);
      yesterday.setFullYear(y, m - 1, d);
    } else {
      yesterday.setDate(yesterday.getDate() - 1);
    }
    yesterday.setHours(0, 0, 0, 0);
    const endOfDay = new Date(yesterday);
    endOfDay.setHours(23, 59, 59, 999);

    let aggregated = 0;
    // Derive the symbol list from the snapshots that actually exist for
    // yesterday — this keeps the rollup in sync with live pool discovery
    // instead of the (smaller) hardcoded config.assets list.
    const symbolRows = await db.poolSnapshot.findMany({
      where: {
        protocol: slug,
        timestamp: { gte: yesterday, lte: endOfDay },
      },
      distinct: ['symbol'],
      select: { symbol: true },
    });
    const symbols = symbolRows.map((r: { symbol: string }) => r.symbol);

    for (const symbol of symbols) {
      const snapshots = await db.poolSnapshot.findMany({
        where: {
          protocol: slug,
          symbol,
          timestamp: { gte: yesterday, lte: endOfDay },
        },
        orderBy: { timestamp: 'asc' },
      });

      if (snapshots.length === 0) continue;

      const avg = (arr: number[]) => arr.reduce((a: number, b: number) => a + b, 0) / arr.length;
      const last = snapshots[snapshots.length - 1];

      await db.poolDaily.upsert({
        where: { protocol_symbol_date: { protocol: slug, symbol, date: yesterday } },
        create: {
          protocol: slug,
          symbol,
          date: yesterday,
          avgSupplyApy: avg(snapshots.map((s: { supplyApy: number }) => s.supplyApy)),
          avgBorrowApy: avg(snapshots.map((s: { borrowApy: number }) => s.borrowApy)),
          avgUtilization: avg(snapshots.map((s: { utilization: number }) => s.utilization)),
          closeTotalSupplyUsd: last.totalSupplyUsd,
          closeTotalBorrowsUsd: last.totalBorrowsUsd,
          closeLiquidityUsd: last.availableLiquidityUsd,
          closePrice: last.price,
        },
        update: {
          avgSupplyApy: avg(snapshots.map((s: { supplyApy: number }) => s.supplyApy)),
          avgBorrowApy: avg(snapshots.map((s: { borrowApy: number }) => s.borrowApy)),
          avgUtilization: avg(snapshots.map((s: { utilization: number }) => s.utilization)),
          closeTotalSupplyUsd: last.totalSupplyUsd,
          closeTotalBorrowsUsd: last.totalBorrowsUsd,
          closeLiquidityUsd: last.availableLiquidityUsd,
          closePrice: last.price,
        },
      });
      aggregated++;
    }

    return NextResponse.json({
      success: true,
      protocol: slug,
      assetsAggregated: aggregated,
      date: yesterday.toISOString().split('T')[0],
    });
  } catch (error) {
    console.error(`aggregate-daily[${slug}] error:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
