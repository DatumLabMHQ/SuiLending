import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/constants';
import { isValidProtocol } from '@/protocols/registry';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Aggregate collateral<->borrow pairs from wallet positions.
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

  if (!isValidProtocol(slug)) {
    return NextResponse.json({ error: `Unknown protocol: ${slug}` }, { status: 404 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  try {
    const wallets = await db.walletPosition.findMany({
      where: { protocol: slug, borrowUsd: { gt: 0 } },
    });

    const pairs = new Map<string, {
      collateralAsset: string;
      borrowAsset: string;
      count: number;
      totalCollateralUsd: number;
      totalBorrowUsd: number;
    }>();

    // Older wallet rows stored `collateralAssets` / `borrowAssets` as rich
    // objects `{symbol, amount, valueUsd}`; newer rows store bare symbol
    // strings. Normalize both to a deduped `string[]` of symbols.
    const parseSymbols = (json: string): string[] => {
      try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        const syms = parsed
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object' && 'symbol' in entry)
              return String((entry as { symbol: unknown }).symbol);
            return null;
          })
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
        return Array.from(new Set(syms));
      } catch {
        return [];
      }
    };

    for (const wallet of wallets) {
      const collateralAssets = parseSymbols(wallet.collateralAssets);
      const borrowAssets = parseSymbols(wallet.borrowAssets);
      if (collateralAssets.length === 0 || borrowAssets.length === 0) continue;

      for (const coll of collateralAssets) {
        for (const borrow of borrowAssets) {
          const key = `${coll}:${borrow}`;
          const existing = pairs.get(key);
          if (existing) {
            existing.count++;
            existing.totalCollateralUsd += wallet.collateralUsd / collateralAssets.length;
            existing.totalBorrowUsd += wallet.borrowUsd / borrowAssets.length;
          } else {
            pairs.set(key, {
              collateralAsset: coll,
              borrowAsset: borrow,
              count: 1,
              totalCollateralUsd: wallet.collateralUsd / collateralAssets.length,
              totalBorrowUsd: wallet.borrowUsd / borrowAssets.length,
            });
          }
        }
      }
    }

    let upserted = 0;
    for (const pair of pairs.values()) {
      await db.collateralBorrowPair.upsert({
        where: {
          protocol_collateralAsset_borrowAsset: {
            protocol: slug,
            collateralAsset: pair.collateralAsset,
            borrowAsset: pair.borrowAsset,
          },
        },
        create: { ...pair, protocol: slug, updatedAt: new Date() },
        update: {
          count: pair.count,
          totalCollateralUsd: pair.totalCollateralUsd,
          totalBorrowUsd: pair.totalBorrowUsd,
          updatedAt: new Date(),
        },
      });
      upserted++;
    }

    return NextResponse.json({
      success: true,
      protocol: slug,
      pairsUpserted: upserted,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`aggregate-pairs[${slug}] error:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
