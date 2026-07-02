/**
 * Generic liquidation indexer cron.
 *
 * Routes any /api/<slug>/cron/index-liquidations call to the protocol's
 * adapter.fetchLiquidations() method. Adapters handle their own event
 * parsing, pagination, and asset resolution — this route is a thin shell
 * that handles auth, "where to start" (latest indexed event id), and the
 * batched DB write.
 *
 * Each protocol's events have different field shapes (NAVI uses pool ids;
 * Suilend uses obligation ids; Scallop has its own event types) so
 * normalization happens inside each adapter, not here.
 */

import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@/lib/constants';
import { getProtocol } from '@/protocols/registry';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ protocol: string }> }
) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { protocol: slug } = await params;
  const entry = getProtocol(slug);
  if (!entry) {
    return NextResponse.json({ error: `Unknown protocol: ${slug}` }, { status: 404 });
  }
  if (!entry.adapter.fetchLiquidations) {
    return NextResponse.json({
      message: `Liquidation indexing not implemented for ${slug}`,
    });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  try {
    // Find the latest already-indexed event so the adapter can stop early.
    const latest = await db.liquidationEvent.findFirst({
      where: { protocol: slug },
      orderBy: { timestamp: 'desc' },
      select: { id: true },
    });

    const events = await entry.adapter.fetchLiquidations({
      untilEventId: latest?.id,
      maxPages: 4,
    });

    if (events.length === 0) {
      return NextResponse.json({
        success: true,
        protocol: slug,
        indexed: 0,
        message: 'No new events',
        timestamp: new Date().toISOString(),
      });
    }

    // Map to DB rows — extra defensive on numeric coercion since some
    // adapters parse strings out of GraphQL responses that may carry
    // unexpected types.
    const num = (v: unknown) => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    // Guard: a corrupted oracle read can record an absurd price (e.g. a $60,481
    // "wUSDT" on 2026-06-24 inflated one dust liquidation to $402M seized).
    // Cross-check each asset's price against the latest indexed pool price; if
    // the event price is off by >10x either way, treat it as corrupt and
    // recompute USD from the known price. Corrective only — never drops an event.
    const assets = Array.from(
      new Set(events.flatMap((e) => [e.collateralAsset, e.debtAsset]).filter(Boolean)),
    );
    const priceRows = (assets.length
      ? await db.poolSnapshot.findMany({
          where: {
            protocol: slug,
            symbol: { in: assets },
            timestamp: { gte: new Date(Date.now() - 3 * 86400 * 1000) },
          },
          orderBy: [{ symbol: 'asc' }, { timestamp: 'desc' }],
          distinct: ['symbol'],
          select: { symbol: true, price: true },
        })
      : []) as Array<{ symbol: string; price: number }>;
    const knownPrice = new Map<string, number>(
      priceRows.map((r) => [r.symbol, r.price] as [string, number]),
    );
    const OUTLIER = 10;
    const saneUsd = (asset: string, price: number, amount: number, usd: number) => {
      const ref = knownPrice.get(asset);
      if (ref && ref > 0 && price > 0 && (price / ref > OUTLIER || ref / price > OUTLIER)) {
        return { price: ref, usd: amount * ref, repaired: true };
      }
      return { price, usd, repaired: false };
    };

    let repaired = 0;
    const rows = events.map((e) => {
      const cAmt = num(e.collateralAmount);
      const dAmt = num(e.debtAmount);
      const c = saneUsd(e.collateralAsset, num(e.collateralPrice), cAmt, num(e.collateralUsd));
      const d = saneUsd(e.debtAsset, num(e.debtPrice), dAmt, num(e.debtUsd));
      if (c.repaired || d.repaired) repaired++;
      return {
        id: e.id,
        protocol: slug,
        txDigest: e.txDigest,
        timestamp: e.timestamp,
        liquidator: e.liquidator.slice(0, 66),
        borrower: e.borrower.slice(0, 66),
        collateralAsset: e.collateralAsset.slice(0, 24),
        collateralAmount: cAmt,
        collateralPrice: c.price,
        collateralUsd: c.usd,
        debtAsset: e.debtAsset.slice(0, 24),
        debtAmount: dAmt,
        debtPrice: d.price,
        debtUsd: d.usd,
        treasuryAmount: num(e.treasuryAmount),
        gasUsedMist: e.gasUsedMist ?? null,
        gasUsd: e.gasUsd ?? null,
      };
    });
    if (repaired > 0) {
      console.warn(`[index-liquidations/${slug}] repaired ${repaired} event(s) with outlier prices`);
    }

    const result = await db.liquidationEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });

    return NextResponse.json({
      success: true,
      protocol: slug,
      indexed: result.count,
      attempted: rows.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`index-liquidations[${slug}] error:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
