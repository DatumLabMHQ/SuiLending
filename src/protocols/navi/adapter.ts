/**
 * NAVI Protocol adapter.
 *
 * Pool data: NAVI's open API at open-api.naviprotocol.io.
 * Liquidations: on-chain `LiquidationEvent` filtered via Sui RPC.
 */

import BigNumber from 'bignumber.js';
import type { ProtocolAdapter, NormalizedPool, NormalizedLiquidation } from '../types';
import { fetchAllPools, fetchSinglePool } from '@/lib/sdk';
import { NAVI_EVENT_TYPES } from './config';
import { getNaviPoolRegistry } from './poolRegistry';
import { parseLiquidationEvent } from './events';
import { queryEvents, rpc, type EventCursor } from '@/lib/rpc';

const MIST_PER_SUI = BigInt(1_000_000_000);

interface TxBlockEffects {
  effects?: {
    gasUsed?: { computationCost: string; storageCost: string; storageRebate: string };
  };
}

async function fetchGasMist(digest: string): Promise<bigint | null> {
  try {
    const tx = await rpc<TxBlockEffects>('sui_getTransactionBlock', [
      digest,
      { showEffects: true },
    ]);
    const g = tx.effects?.gasUsed;
    if (!g) return null;
    return (
      BigInt(g.computationCost ?? '0') +
      BigInt(g.storageCost ?? '0') -
      BigInt(g.storageRebate ?? '0')
    );
  } catch {
    return null;
  }
}

let cachedSuiPrice: { price: number; at: number } | null = null;
async function getCurrentSuiPrice(): Promise<number> {
  if (cachedSuiPrice && Date.now() - cachedSuiPrice.at < 5 * 60 * 1000) return cachedSuiPrice.price;
  try {
    const res = await fetch('https://open-api.naviprotocol.io/api/navi/pools');
    const json = await res.json();
    const sui = json.data.find((p: { token: { symbol: string } }) => p.token.symbol === 'SUI');
    const price = Number(sui?.token?.price ?? 0) || 0;
    cachedSuiPrice = { price, at: Date.now() };
    return price;
  } catch {
    return 0;
  }
}

const naviAdapter: ProtocolAdapter = {
  async fetchPools(): Promise<NormalizedPool[]> {
    const pools = await fetchAllPools();
    return pools.map(toNormalized);
  },

  async fetchPool(symbol: string): Promise<NormalizedPool | null> {
    const pool = await fetchSinglePool(symbol);
    return pool ? toNormalized(pool) : null;
  },

  async fetchLiquidations({ untilEventId, maxPages = 4 } = {}): Promise<NormalizedLiquidation[]> {
    const registry = await getNaviPoolRegistry();
    const out: NormalizedLiquidation[] = [];

    let cursor: EventCursor | null = null;
    let pages = 0;

    while (pages < maxPages) {
      const page = await queryEvents(NAVI_EVENT_TYPES.LIQUIDATION, cursor, 50, 'descending');

      let stop = false;
      for (const evt of page.data) {
        const eventId = `${evt.id.txDigest}:${evt.id.eventSeq}`;
        if (untilEventId && eventId === untilEventId) { stop = true; break; }

        let p;
        try { p = parseLiquidationEvent(evt.parsedJson); }
        catch { continue; }

        const collateralPool = registry[p.collateral_asset];
        const debtPool       = registry[p.debt_asset];
        if (!collateralPool || !debtPool) continue;

        const cScale = new BigNumber(10).pow(collateralPool.decimals);
        const dScale = new BigNumber(10).pow(debtPool.decimals);
        const collateralAmount = new BigNumber(p.collateral_amount).dividedBy(cScale).toNumber();
        const debtAmount       = new BigNumber(p.debt_amount).dividedBy(dScale).toNumber();
        const collateralPrice  = new BigNumber(p.collateral_price).dividedBy(cScale).toNumber();
        const debtPrice        = new BigNumber(p.debt_price).dividedBy(dScale).toNumber();
        const treasuryAmount   = new BigNumber(p.treasury).dividedBy(cScale).toNumber();

        const gasMist = await fetchGasMist(evt.id.txDigest);
        let gasUsd: number | null = null;
        if (gasMist !== null) {
          const suiPrice = await getCurrentSuiPrice();
          gasUsd = suiPrice > 0 ? (Number(gasMist) / Number(MIST_PER_SUI)) * suiPrice : 0;
        }

        out.push({
          id: eventId,
          txDigest: evt.id.txDigest,
          timestamp: new Date(Number(evt.timestampMs)),
          liquidator: p.sender,
          borrower: p.user,
          collateralAsset: collateralPool.symbol,
          collateralAmount,
          collateralPrice,
          collateralUsd: collateralAmount * collateralPrice,
          debtAsset: debtPool.symbol,
          debtAmount,
          debtPrice,
          debtUsd: debtAmount * debtPrice,
          treasuryAmount,
          gasUsedMist: gasMist,
          gasUsd,
        });
      }

      if (stop || !page.hasNextPage) break;
      cursor = page.nextCursor;
      pages += 1;
    }

    return out;
  },
};

export default naviAdapter;

// ─── Helper ─────────────────────────────────────────────────────────────────

function toNormalized(pool: Awaited<ReturnType<typeof fetchAllPools>>[number]): NormalizedPool {
  return {
    symbol: pool.symbol,
    poolId: pool.poolId,
    coinType: pool.coinType,
    decimals: pool.decimals,
    totalSupply: pool.totalSupply,
    totalSupplyUsd: pool.totalSupplyUsd,
    totalBorrows: pool.totalBorrows,
    totalBorrowsUsd: pool.totalBorrowsUsd,
    availableLiquidity: pool.availableLiquidity,
    availableLiquidityUsd: pool.availableLiquidityUsd,
    supplyApy: pool.supplyApy,
    borrowApy: pool.borrowApy,
    boostedSupplyApy: pool.boostedSupplyApy,
    boostedBorrowApy: pool.boostedBorrowApy,
    utilization: pool.utilization,
    ltv: pool.ltv,
    liquidationThreshold: pool.liquidationThreshold,
    supplyCapCeiling: pool.supplyCapCeiling,
    borrowCapCeiling: pool.borrowCapCeiling,
    optimalUtilization: pool.optimalUtilization,
    irm: pool.irm,
    price: pool.price,
  };
}
