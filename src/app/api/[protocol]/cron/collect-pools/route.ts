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

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  try {
    const pools = await entry.adapter.fetchPools();

    if (pools.length === 0) {
      return NextResponse.json({ warning: 'No pool data returned' });
    }

    // NAVI's open API occasionally returns numeric fields as strings
    // (e.g. "price": "0.999788"). Prisma's Float columns reject strings,
    // so coerce at the write boundary.
    const num = (v: unknown) => {
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
      // ltv / liquidationThreshold moved to RateModelParams (governance
      // state, not transient pool state). See history note on
      // RateModelParams in schema.prisma. We still write to the legacy
      // PoolSnapshot columns so older builds reading from there keep
      // showing real values — but the route handler now prefers
      // RateModelParams as the source of truth.
      ltv: num(pool.ltv),
      liquidationThreshold: num(pool.liquidationThreshold),
    }));

    await db.poolSnapshot.createMany({ data: snapshots });

    // Upsert RateModelParams for EVERY pool (not just ones with `irm`) so
    // the table reliably carries ltv/lt for every market the adapter sees.
    // IRM bundle is optional; if missing we still upsert ltv/lt and zero
    // the IRM fields (preserving existing IRM via the update path so we
    // don't accidentally overwrite a good value with zero).
    let rmpWritten = 0;
    for (const pool of pools) {
      let ltv = num(pool.ltv);
      let liquidationThreshold = num(pool.liquidationThreshold);
      // Guard: ltv/lt are fractions in [0,1]. Some adapters can emit a percent
      // by mistake (e.g. Bucket, whose SDK returns minCollateralRatio as a ratio
      // like 1.1 → 100/1.1 = 90.9 instead of 0.909). Any value >1 is a percent;
      // normalize it so the display (which multiplies by 100) can't show 9091%.
      if (ltv > 1) ltv = ltv / 100;
      if (liquidationThreshold > 1) liquidationThreshold = liquidationThreshold / 100;
      const irm = pool.irm;
      // Bucket-only fee params. psmFee is real (read from the SDK swap fee);
      // redemptionFee is reserved (V2 redemption is dynamic/protocol-level,
      // adapter leaves it undefined).
      //
      // Three-state logic: `undefined` = not a PSM/Bucket row, leave the
      // column alone. `null` = a PSM row whose fee is a disabled sentinel,
      // WRITE null to clear any stale value. A number = a real fee, write it.
      // We must distinguish undefined from null so a disabled PSM clears
      // properly instead of keeping a stale 30000% from a prior run.
      const psmProvided = pool.psmFee !== undefined;
      const psmFee = pool.psmFee == null ? null : num(pool.psmFee);
      const redemptionProvided = pool.redemptionFee !== undefined;
      const redemptionFee = pool.redemptionFee == null ? null : num(pool.redemptionFee);
      try {
        await db.rateModelParams.upsert({
          where: { protocol_symbol: { protocol: slug, symbol: pool.symbol } },
          update: {
            // IRM fields only update when the adapter provided a fresh value;
            // we DON'T want a momentary fetch failure to clear the kink to 0.
            ...(irm
              ? {
                  baseRate:       num(irm.baseRate),
                  multiplier:     num(irm.multiplier),
                  jumpMultiplier: num(irm.jumpMultiplier),
                  kink:           num(irm.kink),
                  reserveFactor:  num(irm.reserveFactor),
                }
              : {}),
            // Same protection on ltv/lt — only overwrite when the new value
            // is greater than zero. Stale governance state beats clearing
            // to zero on a transient adapter hiccup.
            ...(ltv > 0 ? { ltv } : {}),
            ...(liquidationThreshold > 0 ? { liquidationThreshold } : {}),
            // Write the fee (incl. null) whenever the adapter provided one,
            // so a disabled PSM clears a stale value.
            ...(psmProvided ? { psmFee } : {}),
            ...(redemptionProvided ? { redemptionFee } : {}),
            updatedAt: new Date(),
          },
          create: {
            protocol: slug,
            symbol: pool.symbol,
            baseRate:       num(irm?.baseRate),
            multiplier:     num(irm?.multiplier),
            jumpMultiplier: num(irm?.jumpMultiplier),
            kink:           num(irm?.kink),
            reserveFactor:  num(irm?.reserveFactor),
            ltv,
            liquidationThreshold,
            psmFee,
            redemptionFee,
          },
        });
        rmpWritten += 1;
      } catch (e) {
        // One pool's upsert failing shouldn't break the whole batch.
        console.warn(`[collect-pools/${slug}] rmp upsert ${pool.symbol}:`, e instanceof Error ? e.message : e);
      }
    }
    const irmWritten = rmpWritten;

    return NextResponse.json({
      success: true,
      protocol: slug,
      poolsCollected: pools.length,
      irmWritten,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`collect-pools[${slug}] error:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
