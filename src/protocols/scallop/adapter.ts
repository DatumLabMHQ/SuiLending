/**
 * Scallop Protocol adapter.
 *
 * Uses Scallop's hosted indexer at https://sui.apis.scallop.io (via
 * a direct HTTP read of Scallop's indexer, see ./indexer.ts). The indexer is HTTP-only —
 * no on-chain decoding, no Sui RPC calls — which makes this adapter the
 * fastest of the bunch.
 *
 * Why ScallopIndexer over ScallopQuery: Query does on-chain devInspect calls
 * which take ~5s each and can hit RPC limits. The indexer is pre-aggregated
 * and returns the same MarketPool shape with computed APYs, utilization, etc.
 *
 * Joining pools with collaterals: Scallop separates "pools" (assets you can
 * borrow) from "collaterals" (assets you can post). LTV / liquidationThreshold
 * live on collaterals. We merge them by coinType so each NormalizedPool gets
 * its risk params if the asset is also a collateral.
 */

import { fetchScallopMarket, type ScallopMarketPool, type ScallopMarketCollateral } from './indexer';

import type { ProtocolAdapter, NormalizedPool, NormalizedLiquidation } from '../types';
import { SCALLOP_INDEXER_URL, SCALLOP_EVENT_TYPES } from './config';
import { queryEvents, type EventCursor } from '@/lib/rpc';

// ─── Reserve filter ─────────────────────────────────────────────────────────
//
// Two-tier filter mirrors the Suilend approach:
//   1. Whitelist by coinType — gets canonical symbols
//   2. Dust threshold — surfaces real markets we haven't curated
const SCALLOP_WHITELIST_COINTYPES = new Set<string>([
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN', // wUSDC
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN', // wUSDT
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN', // WETH
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN', // WBTC
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT', // vSUI
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI',
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI',
  '0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
]);
const SCALLOP_MIN_TVL_USD = 250_000;

// CoinType → canonical symbol — same convention as Suilend adapter so the
// dashboard joins cleanly across protocols.
const CANONICAL_BY_COINTYPE: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 'SUI',
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'USDC',
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 'USDT',
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 'wUSDC',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 'wUSDT',
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 'WBTC',
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 'WETH',
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS': 'CETUS',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 'haSUI',
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 'afSUI',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 'vSUI',
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 'sSUI',
  '0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA': 'SCA',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 'DEEP',
};


const scallopAdapter: ProtocolAdapter = {
  async fetchPools(): Promise<NormalizedPool[]> {
    try {
      const market = await fetchScallopMarket();
      const pools = (Object.values(market.pools ?? {}) as ScallopMarketPool[]).filter((p): p is ScallopMarketPool => !!p);
      const collaterals = Object.values(market.collaterals ?? {}) as ScallopMarketCollateral[];

      // Build coinType → collateral lookup for the LTV merge
      const collateralByCoinType: Record<string, ScallopMarketCollateral> = {};
      for (const c of collaterals) {
        if (c?.coinType) collateralByCoinType[c.coinType] = c;
      }

      const filtered = pools.filter((p) => {
        if (SCALLOP_WHITELIST_COINTYPES.has(p.coinType)) return true;
        // Use supplyCoin (human-readable), NOT supplyAmount (raw 10^decimal)
        const supplyUsd = (p.supplyCoin || 0) * (p.coinPrice || 0);
        return supplyUsd >= SCALLOP_MIN_TVL_USD;
      });

      return filtered.map((pool) => toNormalized(pool, collateralByCoinType[pool.coinType]));
    } catch (error) {
      console.error('[scallop.fetchPools]', error);
      return [];
    }
  },

  async fetchPool(symbol: string): Promise<NormalizedPool | null> {
    const all = await this.fetchPools();
    return all.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  },

  /**
   * Scallop liquidation indexer.
   *
   * Event fields (verified on-chain via `scripts/find-liq-via-objects.mts`):
   *   collateral_type: { name: "<hex>::module::TYPE" }
   *   debt_type:       { name: "<hex>::module::TYPE" }
   *   liq_amount:      raw collateral seized (×10^collateralDecimals)
   *   liquidator:      address
   *   obligation:      borrower's obligation object id (proxy for borrower)
   *   repay_on_behalf: raw debt repaid (×10^debtDecimals)
   *   repay_revenue:   raw protocol fee
   *   collateral_price.value: scaled price (precision varies — Pyth-style 8d)
   *   debt_price.value:       scaled price
   *   timestamp:       seconds
   */
  async fetchLiquidations({ untilEventId, maxPages = 4 } = {}): Promise<NormalizedLiquidation[]> {
    const out: NormalizedLiquidation[] = [];
    let cursor: EventCursor | null = null;
    let pages = 0;

    while (pages < maxPages) {
      const page = await queryEvents(SCALLOP_EVENT_TYPES.LIQUIDATE, cursor, 50, 'descending');

      let stop = false;
      for (const evt of page.data) {
        const eventId = `${evt.id.txDigest}:${evt.id.eventSeq}`;
        if (untilEventId && eventId === untilEventId) { stop = true; break; }

        const j = evt.parsedJson as {
          collateral_type?: { name?: string };
          debt_type?: { name?: string };
          liq_amount?: string;
          liquidator?: string;
          obligation?: string;
          repay_on_behalf?: string;
          collateral_price?: { value?: string };
          debt_price?: { value?: string };
        };

        const cTypeRaw = j.collateral_type?.name ?? '';
        const dTypeRaw = j.debt_type?.name ?? '';
        if (!cTypeRaw || !dTypeRaw) continue;
        const cCoinType = '0x' + cTypeRaw;
        const dCoinType = '0x' + dTypeRaw;

        const cDec = SCALLOP_DECIMALS[cCoinType] ?? 9;
        const dDec = SCALLOP_DECIMALS[dCoinType] ?? 9;

        const collateralAmount = Number(j.liq_amount       ?? '0') / 10 ** cDec;
        const debtAmount       = Number(j.repay_on_behalf  ?? '0') / 10 ** dDec;

        // Scallop's price.value is a fixed-point integer at Pyth's typical
        // 1e-(price_decimals) scale. The SDK normalizes this to USD; without
        // it, divide by 1e-decimals heuristically. For SCA at 0.0708…, the
        // raw value 70849136 implies divide by 1e9 → $0.0708. Use that.
        const collateralPrice = Number(j.collateral_price?.value ?? '0') / 1e9;
        const debtPrice       = Number(j.debt_price?.value       ?? '0') / 1e9;

        out.push({
          id: eventId,
          txDigest: evt.id.txDigest,
          timestamp: new Date(Number(evt.timestampMs)),
          liquidator: (j.liquidator ?? '').slice(0, 66),
          borrower:   (j.obligation ?? '').slice(0, 66),
          collateralAsset: (CANONICAL_BY_COINTYPE[cCoinType] ?? cCoinType.split('::').pop()?.toUpperCase() ?? '').slice(0, 24),
          collateralAmount,
          collateralPrice,
          collateralUsd: collateralAmount * collateralPrice,
          debtAsset: (CANONICAL_BY_COINTYPE[dCoinType] ?? dCoinType.split('::').pop()?.toUpperCase() ?? '').slice(0, 24),
          debtAmount,
          debtPrice,
          debtUsd: debtAmount * debtPrice,
          treasuryAmount: 0,
        });
      }

      if (stop || !page.hasNextPage) break;
      cursor = page.nextCursor;
      pages += 1;
    }

    return out;
  },
};

const SCALLOP_DECIMALS: Record<string, number> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 9,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 6,
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 6,
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 6,
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 6,
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 8,
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 8,
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 9,
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 9,
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 9,
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 9,
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS': 9,
  '0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA': 9,
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 6,
};

export default scallopAdapter;

// ─── Helpers ────────────────────────────────────────────────────────────────


/**
 * Resolve a symbol from Scallop's pool record. Prefers the canonical map
 * (wUSDC vs USDC vs sbUSDT — same trailing struct, different protocols), then
 * falls back to Scallop's `coinName` (e.g. "sbusdt" → "SBUSDT") which uniquely
 * identifies each reserve. Final fallback is the trailing struct name.
 */
function symbolFromPool(coinType: string, coinName: string | undefined): string {
  const known = CANONICAL_BY_COINTYPE[coinType];
  if (known) return known;
  if (coinName) {
    const cleaned = coinName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (cleaned) return cleaned.slice(0, 24);
  }
  const tail = (coinType.split('::').pop() ?? coinType).toUpperCase();
  return tail.slice(0, 24);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNormalized(p: ScallopMarketPool, collat?: ScallopMarketCollateral): NormalizedPool {
  const symbol = symbolFromPool(p.coinType, p.coinName);

  // Scallop's naming is reversed from intuition:
  //   `supplyAmount` / `borrowAmount` are RAW on-chain units (×10^decimals)
  //   `supplyCoin`   / `borrowCoin`   are SCALED human-readable coin amounts
  // Use the *Coin variants for token totals.
  const totalSupply        = num(p.supplyCoin);
  const totalBorrows       = num(p.borrowCoin);
  const availableLiquidity = totalSupply - totalBorrows;
  const price              = num(p.coinPrice);

  const totalSupplyUsd        = totalSupply * price;
  const totalBorrowsUsd       = totalBorrows * price;
  const availableLiquidityUsd = availableLiquidity * price;

  // Scallop's utilizationRate is already 0-100 in the indexer response — but
  // double-check by recomputing from amounts to be safe.
  const utilization = totalSupply > 0 ? (totalBorrows / totalSupply) * 100 : 0;

  // APYs are pre-computed by the indexer (decimals like 0.0421 = 4.21%)
  const supplyApy = num(p.supplyApy) * 100;
  const borrowApy = num(p.borrowApy) * 100;

  // Risk params: come from the matching collateral entry (if any). Pools that
  // are borrow-only (isolated assets) won't have a collateral — we leave LTV
  // and liquidation threshold at 0 in that case.
  const ltv                  = collat ? num((collat as { collateralFactor?: number }).collateralFactor) : 0;
  const liquidationThreshold = collat ? num((collat as { liquidationFactor?: number }).liquidationFactor) : 0;

  // Scallop has a TWO-KINK piecewise model. We collapse it to our 5-knob
  // shape using midKink as the canonical "kink", with the slope from
  // baseBorrowApy → borrowApyOnMidKink as the multiplier and from
  // borrowApyOnMidKink → borrowApyOnHighKink as the jumpMultiplier.
  // Indexer's APY fields are decimals (0.0421 = 4.21%), convert to %.
  const baseBApy   = num(p.baseBorrowApy) * 100;
  const midKinkApy = num(p.borrowApyOnMidKink) * 100;
  const hiKinkApy  = num(p.borrowApyOnHighKink) * 100;
  const irm: NormalizedPool['irm'] = {
    baseRate:       baseBApy,
    multiplier:     Math.max(0, midKinkApy - baseBApy),
    jumpMultiplier: Math.max(0, hiKinkApy - midKinkApy),
    kink:           num(p.midKink),
    reserveFactor:  num(p.reserveFactor),
  };

  return {
    symbol,
    coinType: p.coinType,
    decimals: num(p.coinDecimal),
    totalSupply,
    totalSupplyUsd,
    totalBorrows,
    totalBorrowsUsd,
    availableLiquidity,
    availableLiquidityUsd,
    supplyApy,
    borrowApy,
    utilization,
    ltv,
    liquidationThreshold,
    supplyCapCeiling: num(p.maxSupplyCoin),
    borrowCapCeiling: num(p.maxBorrowCoin),
    optimalUtilization: num(p.midKink),
    irm,
    price,
  };
}
