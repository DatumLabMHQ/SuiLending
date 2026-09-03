/**
 * Bucket Protocol adapter.
 *
 * CDP — collateralized debt position. Each vault locks one collateral asset
 * and issues USDB against it. The SDK exposes vault state via
 * BucketClient.getAllVaultObjects() which returns one VaultInfo per
 * collateral type.
 *
 * Bucket SDK uses gRPC (`@mysten/sui/grpc`) instead of JSON-RPC. The default
 * gRPC fullnode is used unless BLOCKVISION_SUI_GRPC_WEB is set.
 */

import { BucketClient } from '@bucket-protocol/sdk';
import { getSuiClient } from '@/lib/sui-client';

import type { ProtocolAdapter, NormalizedPool, NormalizedLiquidation } from '../types';
import {
  BUCKET_SUI_GRPC_URL, BUCKET_V1_PROTOCOL_ID, SUI_GRAPHQL_URL_FOR_BUCKET,
  BUCKET_EVENT_TYPES,
} from './config';
import { fetchSuiCoinPrices, fetchScallopSCoinPrices } from '@/lib/prices';
import { tryFetchLiquidations } from '../_shared/liquidations';
import { queryEvents, rpc, type EventCursor } from '@/lib/rpc';
import { fetchBucketExtraTvl } from './extra-tvl';

// ─── CoinType → canonical symbol ────────────────────────────────────────────
const CANONICAL_BY_COINTYPE: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 'SUI',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 'haSUI',
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 'afSUI',
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 'sSUI',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 'vSUI',
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 'WETH',
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 'WBTC',
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'USDC',
};

const BUCKET_MIN_TVL_USD = 100_000;
const USDB_DECIMALS = 6;

// ─── Adapter ────────────────────────────────────────────────────────────────

let _bucketClient: BucketClient | null = null;
async function getBucketClient(): Promise<BucketClient> {
  if (_bucketClient) return _bucketClient;
  // BUCKET_SUI_GRPC_URL is the gRPC-Web endpoint (e.g. BlockVision's). When
  // unset, the SDK uses the default public gRPC fullnode. We pass `network`
  // and let the SDK construct its own SuiGrpcClient.
  // Share the app-wide gRPC client so Bucket reads use the same provider,
  // auth and fallback as everything else (SUI_GRPC_URL et al.).
  _bucketClient = await BucketClient.initialize({
    network: 'mainnet',
    suiClient: getSuiClient(),
  });
  return _bucketClient;
}

const bucketAdapter: ProtocolAdapter = {
  async fetchPools(): Promise<NormalizedPool[]> {
    try {
      const client = await getBucketClient();

      // Walk V1 protocol's dynamic fields once. Returns both V1 Buckets
      // (CDPs, BUCK-issuing) and V1 Reservoirs (PSM swap pools — these hold
      // the bulk of legacy TVL).
      const v1WalkResult = await fetchBucketV1Fields().catch((e) => {
        console.warn('[bucket.fetchPools] V1 walk failed:', e instanceof Error ? e.message : e);
        return { buckets: [] as V1BucketRaw[], reservoirs: [] as V1ReservoirRaw[] };
      });

      // Fetch V2 product surfaces in parallel
      const [vaults, psmPools, savingPools] = await Promise.all([
        client.getAllVaultObjects(),
        client.getAllPsmPoolObjects().catch(() => ({})),
        client.getAllSavingPoolObjects().catch(() => ({})),
      ]);

      // Collect all asset coinTypes that need USD pricing
      const coinTypes = [
        ...Object.values(vaults).map((v) => v.collateralType),
        ...Object.values(psmPools).map((p) => p.coinType),
        ...v1WalkResult.buckets.map((b) => b.coinType),
        ...v1WalkResult.reservoirs.map((r) => r.coinType),
      ];
      // Fetch DefiLlama prices and Scallop sCoin prices in parallel. DefiLlama
      // covers canonical assets (SUI/USDC/WETH/...). sCoins are Scallop's
      // interest-bearing receipt tokens (SCALLOP_USDC, SCALLOP_DEEP, etc.) —
      // DefiLlama doesn't index them, but the Scallop indexer exposes the
      // underlying price + conversion rate so we can compute their USD value.
      // We merge sCoin entries on top so a coinType's price always resolves
      // through whichever source covers it.
      const [llamaPrices, scoinPrices] = await Promise.all([
        fetchSuiCoinPrices(coinTypes),
        fetchScallopSCoinPrices(),
      ]);
      // LP-collateral unit prices for V1 CDP types (BUCKETUS, BLUEFIN_STABLE_LP,
      // CETABLE, STAPEARL). These don't have oracle prices but Bucket's UI
      // values them with hardcoded 50/50 splits. Without this layer, V1 CDPs
      // holding $1.94M BUCKETUS / 282K BLUEFIN_STABLE_LP / etc. price at zero
      // and the protocol TVL is materially understated. See computeLpUnitPrices
      // for the formulas (mirrors DefiLlama's bucket-protocol adapter exactly).
      const lpUnitPrices = computeLpUnitPrices(
        v1WalkResult.buckets.map((b) => ({ coinType: b.coinType, decimals: b.decimals })),
        llamaPrices,
      );
      const prices = { ...llamaPrices, ...scoinPrices, ...lpUnitPrices };

      // V2 vault rows (CDP collateral, USDB-issuing)
      const vaultRows = Object.values(vaults).map((v) => toNormalized(v, prices));

      // V2 PSM rows (1:1 collateral ↔ USDB swap pools)
      const psmRows = Object.values(psmPools).map((p) => toPsmNormalized(p, prices));

      // V2 Saving pool rows (USDB deposited earning yield)
      const savingRows = Object.values(savingPools).map((s) => toSavingNormalized(s));

      // V1 rows: BUCK CDPs + V1 Reservoir PSM pools
      const v1BucketRows    = v1WalkResult.buckets.map((b) => toV1BucketNormalized(b, prices));
      const v1ReservoirRows = v1WalkResult.reservoirs.map((r) => toV1ReservoirNormalized(r, prices));

      // Extra-TVL surfaces that the SDK doesn't enumerate (Fountain savings,
      // Aftermath/Kriya BUCK pools, AF AFSUI/SUI CDP, the LP-tokenized PSMs).
      // Direct mirror of DefiLlama's bucket-protocol/index.js — see
      // src/protocols/bucket/extra-tvl.ts for the per-surface walk and the
      // exact object IDs we're reading.
      const extraRows = await fetchBucketExtraTvl(prices).catch((e) => {
        console.warn('[bucket.fetchPools] extra-tvl walk failed:', e instanceof Error ? e.message : e);
        return [] as NormalizedPool[];
      });

      const all = [...vaultRows, ...psmRows, ...savingRows, ...v1BucketRows, ...v1ReservoirRows, ...extraRows];

      // Filter dust — canonical coinTypes always pass; named-prefix product
      // surfaces (PSM/SAVING/V1/V1PSM/BKT-extra) always pass so the
      // dashboard sees every surface even when individual rows are tiny.
      return all.filter((p) => {
        if (CANONICAL_BY_COINTYPE[p.coinType ?? '']) return true;
        if (/^(PSM|SAVING|V1|V1PSM|BKT-)/.test(p.symbol)) return true;
        return p.totalSupplyUsd >= BUCKET_MIN_TVL_USD;
      });
    } catch (error) {
      console.error('[bucket.fetchPools]', error);
      return [];
    }
  },

  async fetchPool(symbol: string): Promise<NormalizedPool | null> {
    const all = await this.fetchPools();
    return all.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  },

  /**
   * Liquidation indexer for both Bucket V2 (CDP::LiquidateEvent) and Bucket
   * V1 (liquidate::DebtorInfo). V2 carries the standard {debt, collateral,
   * debtor, liquidator, ...} shape that the shared parser handles. V1's
   * shape is sparser — `{collateral: TypeName, debt: u64, debtor: address,
   * precision: u64, price: u64}` — so it gets a custom parser below.
   *
   * BUCK is the V1 stablecoin (always the debt asset, $1 each). The event
   * doesn't expose `collateral_amount` so we surface the BUCK debt repaid
   * and let `price` populate `collateralPrice` for downstream analytics.
   */
  async fetchLiquidations({ untilEventId, maxPages = 4 } = {}): Promise<NormalizedLiquidation[]> {
    const [v2, v1] = await Promise.all([
      tryFetchLiquidations(BUCKET_EVENT_TYPES.V2_LIQUIDATE, {
        untilEventId, maxPages,
        decimals: BUCKET_DECIMALS,
        symbols: CANONICAL_BY_COINTYPE,
      }).catch((e) => {
        console.warn('[bucket.fetchLiquidations V2]', e instanceof Error ? e.message : e);
        return [] as NormalizedLiquidation[];
      }),
      fetchBucketV1Liquidations({ untilEventId, maxPages }).catch((e) => {
        console.warn('[bucket.fetchLiquidations V1]', e instanceof Error ? e.message : e);
        return [] as NormalizedLiquidation[];
      }),
    ]);
    return [...v2, ...v1];
  },
};

// ─── Bucket V1 liquidation parser ──────────────────────────────────────────
//
// Verified event shape (from live RPC sample):
//   collateral: u64   — raw amount of collateral seized
//   debt:       u64   — raw BUCK debt repaid
//   debtor:     address  — position owner
//   precision:  u64   — denominator for `price` (e.g. 1e6)
//   price:      u64   — collateral price as integer, scaled by `precision`
//
// Critically, the event does NOT carry the collateral coinType. V1's design
// emits a generic `DebtorInfo` from the central `liquidate::` module
// regardless of which Bucket<T> got liquidated. Without an additional source
// (the surrounding tx's other events, or position lookup), we can't label
// the collateral asset. We surface the row anyway with `collateralAsset='V1'`
// so downstream analytics get totals (debt repaid USD, debtor count) even
// without per-asset breakdown.
//
// BUCK = 9 decimals (V1 stablecoin, $1-pegged). For collateral decimals we
// also assume 9 (most V1 collaterals are SUI / LSTs / LP tokens at 9d). This
// makes `collateralAmount` an approximation when WETH/WBTC vaults liquidate;
// `collateralUsd` is correct anyway since it's `amount × price`.
async function fetchBucketV1Liquidations(
  { untilEventId, maxPages = 4 }: { untilEventId?: string; maxPages?: number },
): Promise<NormalizedLiquidation[]> {
  const out: NormalizedLiquidation[] = [];
  let cursor: EventCursor | null = null;
  let pages = 0;

  while (pages < maxPages) {
    let page;
    try {
      page = await queryEvents(BUCKET_EVENT_TYPES.V1_LIQUIDATE, cursor, 50, 'descending');
    } catch (e) {
      console.warn('[bucket V1] queryEvents failed:', e instanceof Error ? e.message : e);
      break;
    }

    let stop = false;
    for (const evt of page.data) {
      const eventId = `${evt.id.txDigest}:${evt.id.eventSeq}`;
      if (untilEventId && eventId === untilEventId) { stop = true; break; }

      const j = evt.parsedJson as {
        collateral?: string | number;
        debt?: string | number;
        debtor?: string;
        precision?: string | number;
        price?: string | number;
      };

      const collateralRaw = Number(j.collateral ?? '0');
      const debtRaw = Number(j.debt ?? '0');
      if (!debtRaw && !collateralRaw) continue;

      // Default decimals for unknown collateral. See header comment.
      const cDec = 9;
      const collateralAmount = collateralRaw / 10 ** cDec;
      const debtAmount = debtRaw / 10 ** BUCK_DECIMALS_FOR_LIQ;

      const precision = Number(j.precision ?? '1') || 1;
      const collateralPrice = Number(j.price ?? '0') / precision;
      const collateralUsd = collateralAmount * collateralPrice;

      // Liquidator: V1 event doesn't carry it — fall back to tx sender.
      let liquidator = '';
      try {
        const tx = await rpc<{ transaction?: { data?: { sender?: string } } }>(
          'sui_getTransactionBlock', [evt.id.txDigest, { showInput: true }],
        );
        liquidator = tx.transaction?.data?.sender ?? '';
      } catch { /* best-effort */ }

      out.push({
        id: eventId,
        txDigest: evt.id.txDigest,
        timestamp: new Date(Number(evt.timestampMs)),
        liquidator: liquidator.slice(0, 66),
        borrower: (j.debtor ?? '').slice(0, 66),
        // V1 event doesn't carry coinType — use a stable label so dashboard
        // can group all V1 liquidations together without false per-asset rows.
        collateralAsset: 'V1',
        collateralAmount,
        collateralPrice,
        collateralUsd,
        debtAsset: 'BUCK',
        debtAmount,
        debtPrice: 1, // BUCK is $1-pegged
        debtUsd: debtAmount,
        treasuryAmount: 0,
      });
    }

    if (stop || !page.hasNextPage) break;
    cursor = page.nextCursor;
    pages += 1;
  }

  return out;
}

const BUCK_DECIMALS_FOR_LIQ = 9;

// Decimals map for Bucket vault collateral assets. USDB is 6.
const BUCKET_DECIMALS: Record<string, number> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 9,
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 9,
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 9,
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 9,
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 9,
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 8,
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 8,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 6,
};

export default bucketAdapter;

// ─── Helpers ────────────────────────────────────────────────────────────────

type VaultInfo = Awaited<ReturnType<BucketClient['getAllVaultObjects']>>[string];
type PsmInfo   = Awaited<ReturnType<BucketClient['getAllPsmPoolObjects']>>[string];
type SavingInfo= Awaited<ReturnType<BucketClient['getAllSavingPoolObjects']>>[string];

function symbolFromCoinType(coinType: string): string {
  const known = CANONICAL_BY_COINTYPE[coinType];
  if (known) return known;
  const tail = (coinType.split('::').pop() ?? coinType).toUpperCase();
  return tail.slice(0, 24);
}

function bigToHuman(b: bigint, decimals: number): number {
  if (!b) return 0;
  // Avoid 2^53 overflow: split into integer and fractional parts via BigInt math.
  // Construct BigInt(10) ** BigInt(decimals) instead of `10n` literals so the
  // file compiles under target=ES2017.
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = Number(b / divisor);
  const frac = Number(b % divisor) / Number(divisor);
  return whole + frac;
}

function toNormalized(v: VaultInfo, prices: Record<string, number>): NormalizedPool {
  const coinType = v.collateralType;
  const symbol   = symbolFromCoinType(coinType);
  const decimals = v.collateralDecimal;
  const price    = prices[coinType] ?? 0;

  // CDP shape mapping (see config.ts header):
  //   totalSupply / totalSupplyUsd  → collateral locked
  //   totalBorrows / totalBorrowsUsd → USDB issued (≈ $1 per token)
  //   utilization                    → debt-cap utilization
  //   ltv                            → 1 / minCollateralRatio
  const collateralBalance = bigToHuman(v.collateralBalance, decimals);
  const totalSupplyUsd    = collateralBalance * price;
  // USDB has 6 decimals — verified by reverse-engineering CR from on-chain
  // values (e.g. SUI vault: 51K SUI collat at $0.91 ≈ $46K, against
  // raw usdbSupply 28,697,662,836; only USDB=6 yields a sensible 160% CR).
  const usdbSupply        = bigToHuman(v.usdbSupply, USDB_DECIMALS);
  const totalBorrowsUsd   = usdbSupply; // USDB ≈ $1
  const maxUsdb           = bigToHuman(v.maxUsdbSupply, USDB_DECIMALS);

  const utilization = maxUsdb > 0 ? Math.min(100, (usdbSupply / maxUsdb) * 100) : 0;

  // minCollateralRatio comes as a percent like 110 (i.e. 110%). Max LTV =
  // 1 / (minCR / 100) → 0.909 for 110%.
  const ltv = v.minCollateralRatio > 0 ? 100 / v.minCollateralRatio : 0;

  // borrowApy is the per-vault interest rate. SDK exposes a decimal — convert
  // to percent. supplyApy is N/A for CDP — set 0.
  const borrowApy = (v.interestRate || 0) * 100;
  const supplyApy = 0;

  // Bucket V2 has a flat per-vault interest rate (no kink). The IRM shape is
  // degenerate: baseRate = the flat rate, multiplier = jumpMultiplier = 0.
  const irm: NormalizedPool['irm'] = {
    baseRate:       borrowApy,
    multiplier:     0,
    jumpMultiplier: 0,
    kink:           0,
    reserveFactor:  0,
  };

  return {
    symbol,
    coinType,
    decimals,
    totalSupply: collateralBalance,
    totalSupplyUsd,
    totalBorrows: usdbSupply,
    totalBorrowsUsd,
    availableLiquidity: Math.max(0, maxUsdb - usdbSupply), // remaining USDB cap
    availableLiquidityUsd: Math.max(0, maxUsdb - usdbSupply), // ≈ $1 each
    supplyApy,
    borrowApy,
    utilization,
    ltv,
    liquidationThreshold: ltv, // CDPs liquidate at min CR; use same value
    supplyCapCeiling: 0,        // CDP doesn't cap collateral deposit
    borrowCapCeiling: maxUsdb,  // cap on USDB issuance per vault
    optimalUtilization: 0,
    irm,
    price,
  };
}

/**
 * PSM pool normalizer. PSM pools hold collateral (USDC, etc.) and mint USDB
 * 1:1 against it (with small swap fees). The "TVL" of a PSM is the asset
 * balance × asset price, which approximately equals usdbSupply (since PSM
 * is supposed to peg).
 *
 * Symbol convention: `PSM-<asset>` so the dashboard can distinguish PSM from
 * CDP rows in the same protocol bucket.
 */
function toPsmNormalized(p: PsmInfo, prices: Record<string, number>): NormalizedPool {
  const coinType = p.coinType;
  const baseSymbol = symbolFromCoinType(coinType);
  const symbol = `PSM-${baseSymbol}`.slice(0, 24);
  const decimals = p.decimal;
  const price = prices[coinType] ?? 1; // PSM is for stables; default to $1 if no feed

  const balance     = bigToHuman(p.balance, decimals);
  const usdbIssued  = bigToHuman(p.usdbSupply, USDB_DECIMALS);

  // Real PSM swap fee. The SDK exposes feeRate.{swapIn,swapOut} as decimals
  // (e.g. 0.005 = 0.5%). swapIn = fee to deposit the asset and mint USDB,
  // swapOut = fee to redeem USDB back to the asset. We surface the larger of
  // the two as the headline "PSM fee" (the worst-case a user pays) in whole
  // percent. This replaces the old hardcoded 0.1% placeholder.
  //
  // Sentinel guard: a DISABLED PSM carries an absurd fee (observed PSM-USDT
  // at raw 300 → 30000%) to effectively turn the pool off. Any raw fee above
  // 1.0 (100%) is not a real fee — treat it as disabled and surface null so
  // the UI renders "—" rather than "30000%".
  const swapIn  = p.feeRate?.swapIn  ?? 0;
  const swapOut = p.feeRate?.swapOut ?? 0;
  const rawFee  = Math.max(swapIn, swapOut);
  const psmFee  = rawFee > 1 ? null : rawFee * 100;

  return {
    symbol,
    coinType,
    decimals,
    totalSupply: balance,
    totalSupplyUsd: balance * price,
    // For PSM, "borrow" is the USDB minted against the asset balance
    totalBorrows: usdbIssued,
    totalBorrowsUsd: usdbIssued,
    availableLiquidity: balance,
    availableLiquidityUsd: balance * price,
    supplyApy: 0,
    borrowApy: 0,
    utilization: 0,
    ltv: 1,                        // PSM is 1:1
    liquidationThreshold: 1,
    supplyCapCeiling: 0,
    borrowCapCeiling: 0,
    optimalUtilization: 0,
    psmFee,                        // real swap fee, whole percent
    price,
  };
}

/**
 * Saving pool normalizer. USDB deposited into a saving pool earns the
 * `savingRate`. We treat this as a savings-product row so the Bucket TVL
 * picture matches what DefiLlama shows.
 *
 * Symbol convention: `SAVING-USDB`.
 */
function toSavingNormalized(s: SavingInfo): NormalizedPool {
  const usdbBalance = bigToHuman(s.usdbBalance, USDB_DECIMALS);
  const cap = s.usdbDepositCap == null ? 0 : bigToHuman(s.usdbDepositCap, USDB_DECIMALS);

  return {
    symbol: 'SAVING-USDB',
    coinType: s.lpType,
    decimals: USDB_DECIMALS,
    totalSupply: usdbBalance,
    totalSupplyUsd: usdbBalance,        // ≈ $1 each
    totalBorrows: 0,
    totalBorrowsUsd: 0,
    availableLiquidity: usdbBalance,
    availableLiquidityUsd: usdbBalance,
    supplyApy: (s.savingRate || 0) * 100,
    borrowApy: 0,
    utilization: cap > 0 ? Math.min(100, (usdbBalance / cap) * 100) : 0,
    ltv: 0,
    liquidationThreshold: 0,
    supplyCapCeiling: cap,
    borrowCapCeiling: 0,
    optimalUtilization: 0,
    price: 1,
  };
}

// ─── Bucket V1 (legacy BUCK-issuing CDP) ────────────────────────────────────
//
// V1 stores active CDPs as dynamic fields under a single protocol object. Each
// dynamic field's VALUE has type `Bucket<CoinType>` with field
// `collateral_vault: u64` (raw amount of locked collateral). We walk these via
// Sui GraphQL — same approach as DefiLlama's bucket-protocol adapter.

interface V1BucketRaw {
  coinType: string;       // canonical 0x-prefixed coin type
  collateralRaw: string;  // raw collateral_vault value
  decimals: number;       // from on-chain `collateral_decimal` field
  buckMintedRaw: string;  // raw `minted_buck_amount`
}

interface V1ReservoirRaw {
  coinType: string;       // pegged stablecoin / LP coin type that backs BUCK
  poolRaw: string;        // raw `pool` value (collateral held)
  buckMintedRaw: string;  // raw `buck_minted_amount` (BUCK issued through this PSM)
  // Reservoirs don't expose decimals on-chain — we infer from coinType via
  // BUCKET_DECIMALS_FOR_V1 (falls back to 9). Most V1 reservoir collaterals
  // are LP tokens (9 decimals) or stablecoins (6 decimals).
}

interface BucketFields {
  collateral_vault?: string | number;
  collateral_decimal?: string | number;
  minted_buck_amount?: string | number;
}

interface ReservoirFields {
  pool?: string | number;
  buck_minted_amount?: string | number;
  conversion_rate?: string | number;
}

interface DfNode {
  value?: {
    __typename?: string;
    json?: BucketFields & ReservoirFields;
    type?: { repr?: string };
    contents?: { type?: { repr?: string }; json?: BucketFields & ReservoirFields };
  };
}

/**
 * Extract the inner type from a generic Move type string after a given marker.
 * Handles nested generics like `Bucket<...::StakedHouseCoin<...::SUI>>`
 * (where the naive `[^>]+` match would break at the inner `>`).
 */
function extractGenericInner(repr: string, marker: string): string | null {
  const open = repr.indexOf(marker);
  if (open < 0) return null;
  let depth = 0;
  const start = open + marker.length;
  for (let i = start; i < repr.length; i++) {
    const c = repr[i];
    if (c === '<') depth += 1;
    else if (c === '>') {
      if (depth === 0) return repr.slice(start, i).trim();
      depth -= 1;
    }
  }
  return null;
}

async function fetchBucketV1Fields(): Promise<{ buckets: V1BucketRaw[]; reservoirs: V1ReservoirRaw[] }> {
  const query = `
    query($parent: SuiAddress!, $cursor: String) {
      address(address: $parent) {
        dynamicFields(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            value {
              __typename
              ... on MoveValue  { type { repr } json }
              ... on MoveObject { contents { type { repr } json } }
            }
          }
        }
      }
    }
  `;

  const buckets: V1BucketRaw[] = [];
  const reservoirs: V1ReservoirRaw[] = [];
  let cursor: string | null = null;

  // V1 protocol has ~170 dynamic fields across Buckets, Reservoirs, Ponds,
  // and other types. Pages of 50 → up to ~4 pages.
  for (let pages = 0; pages < 8; pages++) {
    const res = await fetch(SUI_GRAPHQL_URL_FOR_BUCKET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { parent: BUCKET_V1_PROTOCOL_ID, cursor },
      }),
    });
    if (!res.ok) throw new Error(`Bucket V1 GraphQL ${res.status}`);
    const json = await res.json() as {
      data?: { address?: { dynamicFields?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: DfNode[];
      } } };
    };
    const dfs = json?.data?.address?.dynamicFields;
    if (!dfs) break;

    for (const node of dfs.nodes) {
      const isMoveObject = node.value?.__typename === 'MoveObject';
      const repr =
        (isMoveObject ? node.value?.contents?.type?.repr : node.value?.type?.repr) ?? '';
      const fields = (isMoveObject ? node.value?.contents?.json : node.value?.json) ?? {};

      // Bucket<CoinType> — V1 CDP positions
      if (/::bucket::Bucket</.test(repr)) {
        const innerType = extractGenericInner(repr, 'Bucket<');
        if (!innerType) continue;
        const coinType = innerType.startsWith('0x') ? innerType : '0x' + innerType;
        const collateralRaw = String(fields.collateral_vault ?? '0');
        if (collateralRaw === '0') continue;
        buckets.push({
          coinType,
          collateralRaw,
          decimals: Number(fields.collateral_decimal ?? 9),
          buckMintedRaw: String(fields.minted_buck_amount ?? '0'),
        });
        continue;
      }

      // Reservoir<CoinType> — V1 PSM swap pools (mint BUCK by depositing
      // pegged collateral). Holds the bulk of legacy V1 TVL.
      if (/::reservoir::Reservoir</.test(repr)) {
        const innerType = extractGenericInner(repr, 'Reservoir<');
        if (!innerType) continue;
        const coinType = innerType.startsWith('0x') ? innerType : '0x' + innerType;
        const poolRaw = String(fields.pool ?? '0');
        if (poolRaw === '0') continue;
        reservoirs.push({
          coinType,
          poolRaw,
          buckMintedRaw: String(fields.buck_minted_amount ?? '0'),
        });
        continue;
      }
    }

    if (!dfs.pageInfo.hasNextPage || !dfs.pageInfo.endCursor) break;
    cursor = dfs.pageInfo.endCursor;
  }

  return { buckets, reservoirs };
}

/** V1 Bucket (CDP) row normalizer. Symbol prefix `V1-`. */
function toV1BucketNormalized(b: V1BucketRaw, prices: Record<string, number>): NormalizedPool {
  // Decimals come straight from the on-chain `collateral_decimal` field —
  // no static map needed since V1 has 40+ collateral types including LP
  // tokens and Scallop sCoins we wouldn't have hardcoded.
  const decimals = b.decimals;
  const price = prices[b.coinType] ?? 0;

  // BigInt division to avoid 2^53 overflow on large u64 raw amounts.
  const collatRaw = BigInt(b.collateralRaw);
  const divisor = BigInt(10) ** BigInt(decimals);
  const collat = Number(collatRaw / divisor) + Number(collatRaw % divisor) / Number(divisor);
  const collatUsd = collat * price;

  // BUCK has 9 decimals (matches the V1 stablecoin module). minted_buck_amount
  // is the total BUCK issued against this collateral type.
  const buckRaw = BigInt(b.buckMintedRaw);
  const buckScale = BigInt(10) ** BigInt(BUCK_DECIMALS);
  const buckMinted = Number(buckRaw / buckScale) + Number(buckRaw % buckScale) / Number(buckScale);
  // BUCK is a USD stablecoin → $1 each
  const buckUsd = buckMinted;

  // Build a friendly symbol from the canonical map if we know it; else from
  // the trailing struct name (skipping nested-generic noise). Always prefixed.
  const trailing = (b.coinType.split('::').pop() ?? '').replace(/[<>]/g, '').toUpperCase();
  const baseSym = CANONICAL_BY_COINTYPE[b.coinType] ?? trailing;
  const symbol = `V1-${baseSym}`.slice(0, 24);

  return {
    symbol,
    coinType: b.coinType,
    decimals,
    totalSupply: collat,
    totalSupplyUsd: collatUsd,
    totalBorrows: buckMinted,
    totalBorrowsUsd: buckUsd,
    availableLiquidity: Math.max(0, collat - buckMinted / Math.max(1, price)),
    availableLiquidityUsd: Math.max(0, collatUsd - buckUsd),
    supplyApy: 0,
    borrowApy: 0,
    utilization: collatUsd > 0 ? Math.min(100, (buckUsd / collatUsd) * 100) : 0,
    ltv: 0,
    liquidationThreshold: 0,
    supplyCapCeiling: 0,
    borrowCapCeiling: 0,
    optimalUtilization: 0,
    price,
  };
}

const BUCK_DECIMALS = 9;

// ─── LP-collateral unit pricing (option A from Bucket TVL gap analysis) ─────
//
// Bucket V1 CDPs accept a long tail of LP-tokenized collateral types that
// don't have oracle prices: BUCKETUS (Cetus BUCK/USDC LP), BLUEFIN_STABLE_LP
// (Bluefin BUCK/USDC LP), CETABLE / STAPEARL (Curve-style stable LPs).
// Bucket's UI prices these client-side using hardcoded 50/50 split formulas
// matching what DefiLlama's bucket-protocol adapter does (see
// projects/bucket-protocol/index.js, lines ~309-333 for the canonical
// formulas this mirrors). Without this layer those collateral types price at
// zero in our V1 walk and the protocol TVL is understated by ~$1-2M.
//
// Formula:
//   BUCKETUS / BLUEFIN_STABLE_LP: 1 LP raw → 1/(2×1000) USDC raw
//     (the /1000 absorbs the BUCK→USDC decimals delta, since 50% is BUCK
//     and we skip BUCK to avoid double-counting Bucket's own stablecoin)
//   CETABLE / STAPEARL: 1 LP raw → 0.5 USDC raw + 0.5 USDT raw
//
// Returns Record<coinType, unitPriceUsdPerHumanUnit>. Caller merges this
// into the prices map so toV1BucketNormalized's existing price * collat
// math Just Works for these collateral types.
const USDC_TYPE_FOR_LP = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const USDT_TYPE_FOR_LP = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT';

function computeLpUnitPrices(
  collats: Array<{ coinType: string; decimals: number }>,
  prices: Record<string, number>,
): Record<string, number> {
  const usdcPrice = prices[USDC_TYPE_FOR_LP] ?? 1;
  const usdtPrice = prices[USDT_TYPE_FOR_LP] ?? 1;
  const out: Record<string, number> = {};

  // De-dup by coinType; we only need one unit price per LP coin even if
  // multiple V1 CDPs hold it.
  const seen = new Set<string>();
  for (const c of collats) {
    if (seen.has(c.coinType)) continue;
    seen.add(c.coinType);
    const ct = c.coinType;
    const dec = c.decimals;

    // BUCKETUS / BLUEFIN_STABLE_LP: half-USDC formula with /1000 BUCK-decimal
    // correction. Unit price (per LP human unit) = 10^dec / (2*1000*1e6) × USDC.
    if (ct.includes('::bucketus::') || ct.includes('::bluefin_stable_lp::')) {
      out[ct] = Math.pow(10, dec) / (2 * 1000 * 1e6) * usdcPrice;
      continue;
    }

    // CETABLE / STAPEARL: 50/50 USDC + USDT, both 6-decimal stables.
    // Unit price = 10^dec / (2 * 1e6) × USDC_price + same × USDT_price.
    if (ct.includes('::cetable::') || ct.includes('::stapearl::')) {
      const half = Math.pow(10, dec) / 2 / 1e6;
      out[ct] = half * usdcPrice + half * usdtPrice;
      continue;
    }
  }
  return out;
}

/**
 * V1 Reservoir (PSM swap pool) row normalizer.
 *
 * Reservoirs let users mint BUCK by depositing pegged collateral 1:1. Their
 * `pool` field holds the deposited collateral; `buck_minted_amount` is the
 * BUCK issued. Symbol prefix `V1PSM-` distinguishes from V2 PSM and V1 CDP.
 *
 * Unlike Buckets, Reservoirs don't expose `collateral_decimal` on-chain. We
 * fall back to 9 (Sui default) — most Reservoir collaterals are LP tokens
 * with 9 decimals. Stable Reservoirs may be off by 10^3 but they get
 * captured anyway since they're whitelisted by symbol prefix.
 */
function toV1ReservoirNormalized(r: V1ReservoirRaw, prices: Record<string, number>): NormalizedPool {
  const decimals = 9; // see comment above
  const price = prices[r.coinType] ?? 1; // Reservoir collateral is usually $1-pegged stables/LPs

  const poolRaw = BigInt(r.poolRaw);
  const divisor = BigInt(10) ** BigInt(decimals);
  const pool = Number(poolRaw / divisor) + Number(poolRaw % divisor) / Number(divisor);

  const buckRaw = BigInt(r.buckMintedRaw);
  const buckScale = BigInt(10) ** BigInt(BUCK_DECIMALS);
  const buckMinted = Number(buckRaw / buckScale) + Number(buckRaw % buckScale) / Number(buckScale);

  // For PSM-pegged collateral, treat the pool's value as 1:1 with BUCK
  // (since that's the swap rate). When the price feed disagrees, prefer the
  // BUCK-minted value as the authoritative TVL signal.
  const collatUsd = Math.max(pool * price, buckMinted);

  const trailing = (r.coinType.split('::').pop() ?? '').replace(/[<>]/g, '').toUpperCase();
  const baseSym = CANONICAL_BY_COINTYPE[r.coinType] ?? trailing;
  const symbol = `V1PSM-${baseSym}`.slice(0, 24);

  return {
    symbol,
    coinType: r.coinType,
    decimals,
    totalSupply: pool,
    totalSupplyUsd: collatUsd,
    totalBorrows: buckMinted,
    totalBorrowsUsd: buckMinted, // BUCK is $1
    availableLiquidity: pool,
    availableLiquidityUsd: collatUsd,
    supplyApy: 0,
    borrowApy: 0,
    utilization: 0,
    ltv: 1,
    liquidationThreshold: 1,
    supplyCapCeiling: 0,
    borrowCapCeiling: 0,
    optimalUtilization: 0,
    price,
  };
}
