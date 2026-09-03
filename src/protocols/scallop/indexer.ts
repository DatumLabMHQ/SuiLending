/**
 * Scallop market indexer, read directly over HTTP.
 *
 * We used to go through `ScallopIndexer` from @scallop-io/sui-scallop-sdk,
 * but that class was dropped in SDK 5.x and the SDK pulled in an old
 * @mysten/sui peer. The indexer is a plain REST endpoint, so this is the
 * whole integration: GET {SCALLOP_INDEXER_URL}/api/market.
 *
 * The live response (checked 2026-09-03) has `pools` and `collaterals` as
 * arrays; older SDK versions re-keyed them by coin name. Callers use
 * Object.values(), which works for both, so the shape is passed through.
 */

export interface ScallopMarketPool {
  coinName?: string;
  symbol?: string;
  coinType: string;
  sCoinType?: string;
  marketCoinType?: string;
  coinDecimal?: number;
  coinPrice?: number;
  borrowApr?: number;
  borrowApy?: number;
  supplyApr?: number;
  supplyApy?: number;
  supplyCoin?: number;
  borrowCoin?: number;
  reserveCoin?: number;
  utilizationRate?: number;
  highKink?: number;
  midKink?: number;
  reserveFactor?: number;
  borrowWeight?: number;
  borrowFee?: number;
  conversionRate?: number;
  baseBorrowApr?: number;
  baseBorrowApy?: number;
  borrowAprOnHighKink?: number;
  borrowApyOnHighKink?: number;
  borrowAprOnMidKink?: number;
  borrowApyOnMidKink?: number;
  maxBorrowApr?: number;
  maxBorrowApy?: number;
  [key: string]: unknown;
}

export interface ScallopMarketCollateral {
  coinName?: string;
  symbol?: string;
  coinType: string;
  coinDecimal?: number;
  coinPrice?: number;
  collateralFactor?: number;
  liquidationFactor?: number;
  liquidationDiscount?: number;
  liquidationPanelty?: number;
  liquidationPenalty?: number;
  liquidationReserveFactor?: number;
  maxCollateralAmount?: number;
  totalCollateralAmount?: number;
  totalCollateralCoin?: number;
  [key: string]: unknown;
}

export interface ScallopMarket {
  tvl?: number;
  updatedAt?: string;
  pools: ScallopMarketPool[] | Record<string, ScallopMarketPool>;
  collaterals: ScallopMarketCollateral[] | Record<string, ScallopMarketCollateral>;
}

export const SCALLOP_INDEXER_URL =
  process.env.SCALLOP_INDEXER_URL ?? 'https://sdk.api.scallop.io';

let _cache: { at: number; market: ScallopMarket } | null = null;
const CACHE_MS = 60_000;

export async function fetchScallopMarket(): Promise<ScallopMarket> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.market;
  const res = await fetch(`${SCALLOP_INDEXER_URL.replace(/\/+$/, '')}/api/market`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Scallop indexer HTTP ${res.status}`);
  const market = (await res.json()) as ScallopMarket;
  if (!market || typeof market !== 'object') throw new Error('Scallop indexer: empty response');
  _cache = { at: Date.now(), market };
  return market;
}
