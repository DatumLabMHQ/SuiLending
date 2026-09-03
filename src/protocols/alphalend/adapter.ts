/**
 * AlphaLend Protocol adapter.
 *
 * Bypasses @alphafi/alphalend-sdk (incompatible with @mysten/sui v2 — it
 * imports `@mysten/sui/graphql/schemas/latest` which only exists in v1) and
 * queries Sui's public GraphQL endpoint directly, paginating dynamic fields
 * under MARKETS_TABLE_ID. Each dynamic field is a Field<u64, Market>; the
 * Market struct fields are flattened into `value.json` in GraphQL output.
 *
 * Math model derived from inspecting on-chain values:
 *   underlying_supply_raw = xtoken_supply × (xtoken_ratio / 1e18)
 *   underlying_borrow_raw = borrowed_amount   (already in underlying-raw scale)
 *   token_decimals        = log10(decimal_digit) − 18
 *   human_amount          = raw / 10^token_decimals
 *
 * Verified against AlphaLend's app for SUI: ~16M deposited × ~$0.91 ≈ $14.5M.
 */

import type { ProtocolAdapter, NormalizedPool, NormalizedLiquidation } from '../types';
import { ALPHALEND_MARKETS_TABLE_ID, SUI_GRAPHQL_URL, ALPHALEND_EVENT_TYPES } from './config';
import { fetchSuiCoinPrices } from '@/lib/prices';
import { queryEvents, rpc, type EventCursor } from '@/lib/rpc';

// ─── CoinType → canonical symbol ────────────────────────────────────────────
const CANONICAL_BY_COINTYPE: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 'SUI',
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'USDC',
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 'USDT',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 'wUSDT',
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 'wUSDC',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 'haSUI',
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 'afSUI',
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 'sSUI',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 'vSUI',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 'DEEP',
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': 'WAL',
};

const ALPHALEND_MIN_TVL_USD = 250_000;

// ─── On-chain shape (subset we use) ─────────────────────────────────────────
interface MarketGqlValue {
  market_id: string;
  coin_type: string;
  xtoken_supply: string;
  xtoken_ratio: { value: string };           // scaled by 1e18
  borrowed_amount: string;
  decimal_digit: { value: string };          // 10^(decimal + 18)
  config: {
    active: boolean;
    isolated: boolean;
    deposit_limit: string;
    borrow_limit: string;
    liquidation_threshold: number;            // already a percent (0-100)
    safe_collateral_ratio: number;            // ratio (e.g. 75 means 75% — i.e. LTV)
    interest_rates: string[];                 // BPS strings; 1bp = 0.01%
    interest_rate_kinks: string | number[];   // base64 vector<u8> or array of utilization percent
    spread_fee_bps: string;
  };
}

interface DynamicFieldNode {
  name: { json: string };
  value: { __typename: 'MoveValue'; json: MarketGqlValue } | null;
}

// ─── Adapter ────────────────────────────────────────────────────────────────
const alphalendAdapter: ProtocolAdapter = {
  async fetchPools(): Promise<NormalizedPool[]> {
    try {
      const markets = await fetchAllMarkets();
      const active = markets.filter((m) => m.config?.active);

      // Get USD prices for all coinTypes via DefiLlama
      const coinTypes = active.map((m) => normalizeCoinType(m.coin_type));
      const prices = await fetchSuiCoinPrices(coinTypes);

      const normalized = active.map((m) => toNormalized(m, prices));

      // Apply dust threshold filter (canonical coinTypes always pass)
      return normalized.filter((p) => {
        if (CANONICAL_BY_COINTYPE[p.coinType ?? '']) return true;
        return p.totalSupplyUsd >= ALPHALEND_MIN_TVL_USD;
      });
    } catch (error) {
      console.error('[alphalend.fetchPools]', error);
      return [];
    }
  },

  async fetchPool(symbol: string): Promise<NormalizedPool | null> {
    const all = await this.fetchPools();
    return all.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  },

  /**
   * AlphaLend liquidation indexer. Events are wrapped in `events::Event<T>`
   * (Sui's typed-event envelope), so `parsedJson` looks like:
   *   { event: { repay_type, withdraw_type, repay_amount, withdraw_amount,
   *              repay_value, withdraw_value, position_id, ... } }
   *
   * Both `LiquidationEvent` (single-asset collateral) and `LpLiquidationEvent`
   * (LP-token collateral) get indexed. LP shape adds `coin_a_amount` /
   * `coin_b_amount` / `pool_id` which we surface as collateral side via the
   * primary leg (`coin_a_*`); a future pass could split into two rows.
   *
   * `*_value` fields are the on-chain USD values scaled by 1e9 (AlphaLend's
   * standard precision constant). Using these means we don't need a separate
   * price lookup — collateralUsd / debtUsd come straight from the event.
   */
  async fetchLiquidations({ untilEventId, maxPages = 4 } = {}): Promise<NormalizedLiquidation[]> {
    const [single, lp] = await Promise.all([
      fetchAlphalendLiquidations(ALPHALEND_EVENT_TYPES.LIQUIDATE, false, untilEventId, maxPages)
        .catch((e) => { console.warn('[alphalend.LIQUIDATE]', e instanceof Error ? e.message : e); return []; }),
      fetchAlphalendLiquidations(ALPHALEND_EVENT_TYPES.LIQUIDATE_LP, true, untilEventId, maxPages)
        .catch((e) => { console.warn('[alphalend.LIQUIDATE_LP]', e instanceof Error ? e.message : e); return []; }),
    ]);
    return [...single, ...lp];
  },
};

// AlphaLend coinType → decimals. Matches the canonical-symbol map above.
const ALPHALEND_DECIMALS: Record<string, number> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 9,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 6,
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 6,
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 6,
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 6,
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 9,
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 9,
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 9,
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 9,
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 6,
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': 9,
};

// AlphaLend's `*_value` fields use a fixed 1e9 USD-scale precision constant
// (verified from `alpha_lending` module source at AlphaFiTech/alphalend-
// contracts-interfaces). Same scale applies across LiquidationEvent and
// LpLiquidationEvent.
const ALPHALEND_VALUE_PRECISION = 1e9;

interface AlphalendLiqInner {
  repay_type?: { name?: string };
  withdraw_type?: { name?: string };
  position_id?: string;
  liquidator?: string;          // not actually emitted; tx sender is fallback
  repay_amount?: string;
  repay_value?: string;
  withdraw_amount?: string;
  withdraw_value?: string;
  // LP variant
  coin_a_amount?: string;
  coin_b_amount?: string;
  lp_position_id?: string;
  pool_id?: string;
}

async function fetchAlphalendLiquidations(
  eventType: string,
  isLpVariant: boolean,
  untilEventId: string | undefined,
  maxPages: number,
): Promise<NormalizedLiquidation[]> {
  const out: NormalizedLiquidation[] = [];
  let cursor: EventCursor | null = null;
  let pages = 0;

  while (pages < maxPages) {
    const page = await queryEvents(eventType, cursor, 50, 'descending');
    let stop = false;
    for (const evt of page.data) {
      const eventId = `${evt.id.txDigest}:${evt.id.eventSeq}`;
      if (untilEventId && eventId === untilEventId) { stop = true; break; }

      // Sui un-wraps `events::Event<T>` automatically: parsedJson is
      // either { event: { ...inner } } (some node implementations) or the
      // inner fields flattened (others). Handle both.
      const raw = evt.parsedJson as { event?: AlphalendLiqInner } & AlphalendLiqInner;
      const j: AlphalendLiqInner = raw.event ?? raw;

      const cTypeRaw = j.withdraw_type?.name;
      const dTypeRaw = j.repay_type?.name;
      if (!cTypeRaw || !dTypeRaw) continue;
      const cCoinType = cTypeRaw.startsWith('0x') ? cTypeRaw : '0x' + cTypeRaw;
      const dCoinType = dTypeRaw.startsWith('0x') ? dTypeRaw : '0x' + dTypeRaw;

      const cDec = ALPHALEND_DECIMALS[cCoinType] ?? 9;
      const dDec = ALPHALEND_DECIMALS[dCoinType] ?? 9;

      // For LP variant, withdraw_amount represents LP units; coin_a_amount
      // is the larger leg of the underlying pair. We still use withdraw_value
      // (USD-denominated) as the authoritative collateral USD.
      const collateralAmount =
        isLpVariant && j.coin_a_amount
          ? Number(j.coin_a_amount) / 10 ** cDec
          : Number(j.withdraw_amount ?? '0') / 10 ** cDec;
      const debtAmount = Number(j.repay_amount ?? '0') / 10 ** dDec;
      const collateralUsd = Number(j.withdraw_value ?? '0') / ALPHALEND_VALUE_PRECISION;
      const debtUsd       = Number(j.repay_value    ?? '0') / ALPHALEND_VALUE_PRECISION;

      // Liquidator is not emitted on the event — fall back to tx sender.
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
        // position_id is the borrower-equivalent (NFT cap holding position state)
        borrower: (j.position_id ?? j.lp_position_id ?? '').slice(0, 66),
        collateralAsset: (CANONICAL_BY_COINTYPE[cCoinType] ?? cCoinType.split('::').pop()?.toUpperCase() ?? '').slice(0, 24),
        collateralAmount,
        collateralPrice: collateralAmount > 0 ? collateralUsd / collateralAmount : 0,
        collateralUsd,
        debtAsset: (CANONICAL_BY_COINTYPE[dCoinType] ?? dCoinType.split('::').pop()?.toUpperCase() ?? '').slice(0, 24),
        debtAmount,
        debtPrice: debtAmount > 0 ? debtUsd / debtAmount : 0,
        debtUsd,
        treasuryAmount: 0,
      });
    }

    if (stop || !page.hasNextPage) break;
    cursor = page.nextCursor;
    pages += 1;
  }

  return out;
}

export default alphalendAdapter;

// ─── GraphQL fetch ──────────────────────────────────────────────────────────

async function fetchAllMarkets(): Promise<MarketGqlValue[]> {
  const query = `
    query($parent: SuiAddress!, $cursor: String) {
      address(address: $parent) {
        dynamicFields(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name { json }
            value {
              __typename
              ... on MoveValue { json }
            }
          }
        }
      }
    }
  `;

  interface GqlResponse {
    data?: {
      address?: {
        dynamicFields?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: DynamicFieldNode[];
        };
      };
    };
  }

  const out: MarketGqlValue[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 10; pages++) {
    const res: Response = await fetch(SUI_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { parent: ALPHALEND_MARKETS_TABLE_ID, cursor },
      }),
    });
    if (!res.ok) throw new Error(`Sui GraphQL ${res.status}`);
    const json = (await res.json()) as GqlResponse;
    const dfs = json?.data?.address?.dynamicFields;
    if (!dfs) break;
    for (const node of dfs.nodes) {
      const v = node?.value?.json;
      if (v) out.push(v);
    }
    if (!dfs.pageInfo?.hasNextPage || !dfs.pageInfo?.endCursor) break;
    cursor = dfs.pageInfo.endCursor;
  }
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Add `0x` prefix to bare-hex coin type addresses. */
function normalizeCoinType(coinType: string): string {
  if (coinType.endsWith('2::sui::SUI')) return '0x2::sui::SUI';
  return coinType
    .split('<')
    .map((s) => (s.length > 0 && !s.startsWith('0x') ? '0x' + s : s))
    .join('<');
}

/** Trailing struct name capitalized + 24-char cap, used as fallback symbol. */
function symbolFromCoinType(coinType: string): string {
  const known = CANONICAL_BY_COINTYPE[coinType];
  if (known) return known;
  const tail = (coinType.split('::').pop() ?? coinType).toUpperCase();
  return tail.slice(0, 24);
}

/**
 * Recover the underlying coin's decimal count from on-chain `decimal_digit`.
 * AlphaLend stores 10^(decimal + 18). Counting digits in the BigInt string
 * works regardless of the value (BigInt parse is unreliable beyond 2^53).
 */
function decimalsFromDigit(decimalDigitStr: string | undefined): number {
  if (!decimalDigitStr) return 9;
  // "10000...0" — number of digits minus 1 = log10
  const digits = decimalDigitStr.length - 1;
  return Math.max(0, digits - 18);
}

/**
 * Big-string × small-number / power-of-10 helper. Returns a JS number,
 * accepting some precision loss (acceptable for USD totals; we never write
 * BigInt values to the DB).
 */
function rawToHuman(rawStr: string, decimals: number, scaleNumerator = 1, scaleDenom = 1): number {
  if (!rawStr) return 0;
  // Convert via BigInt for the integer part to avoid 2^53 overflow.
  try {
    const big = BigInt(rawStr);
    // Apply scale: × scaleNumerator / scaleDenom while keeping precision.
    // For our use-case (xtoken_ratio / 1e18), the ratio is ~1.0-1.1, so doing
    // the multiply in floats after dividing by 10^decimals is safe enough.
    const divisor = 10 ** decimals;
    return (Number(big) / divisor) * (scaleNumerator / scaleDenom);
  } catch {
    return 0;
  }
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Decode AlphaLend's piecewise interest-rate kinks. The on-chain value is a
 * `vector<u8>` which Sui GraphQL returns as a base64 string. JSON-RPC would
 * have returned a number array. Either form lands here.
 */
function decodeKinks(kinks: string | number[] | undefined): number[] {
  if (!kinks) return [];
  if (Array.isArray(kinks)) return kinks.map(Number);
  try {
    const buf = Buffer.from(kinks, 'base64');
    return Array.from(buf);
  } catch {
    return [];
  }
}

/**
 * Estimate borrow APR at a given utilization using the piecewise-linear
 * model. Rates are in BPS (1bp = 0.01%); kinks are utilization percents.
 * Above the last kink, we hold rate at the last rate (conservative).
 */
function estimateBorrowAprPercent(util: number, rates: string[], kinks: number[]): number {
  if (rates.length === 0 || kinks.length === 0) return 0;
  const utilPct = Math.min(100, Math.max(0, util));
  // Find segment
  for (let i = 0; i < kinks.length - 1; i++) {
    const k0 = kinks[i];
    const k1 = kinks[i + 1];
    if (utilPct >= k0 && utilPct <= k1) {
      const r0 = num(rates[i]);
      const r1 = num(rates[i + 1]) || r0;
      const t = k1 === k0 ? 0 : (utilPct - k0) / (k1 - k0);
      const bps = r0 + t * (r1 - r0);
      return bps / 100; // BPS → percent
    }
  }
  // Above last kink — hold at last rate
  return num(rates[rates.length - 1]) / 100;
}

// ─── Normalize ──────────────────────────────────────────────────────────────

function toNormalized(m: MarketGqlValue, prices: Record<string, number>): NormalizedPool {
  const coinType = normalizeCoinType(m.coin_type);
  const symbol   = symbolFromCoinType(coinType);
  const decimals = decimalsFromDigit(m.decimal_digit?.value);
  const price    = num(prices[coinType]);

  // xtoken_ratio is scaled by 1e18; multiplying after dividing by token
  // decimals first preserves precision for typical sub-2x ratios.
  const xRatio   = num(m.xtoken_ratio?.value) / 1e18 || 1;

  const totalSupply  = rawToHuman(m.xtoken_supply, decimals) * xRatio;
  const totalBorrows = rawToHuman(m.borrowed_amount, decimals);
  const availableLiquidity = Math.max(0, totalSupply - totalBorrows);

  const totalSupplyUsd        = totalSupply * price;
  const totalBorrowsUsd       = totalBorrows * price;
  const availableLiquidityUsd = availableLiquidity * price;

  const utilization = totalSupply > 0 ? (totalBorrows / totalSupply) * 100 : 0;

  // Interest rate model
  const kinks = decodeKinks(m.config?.interest_rate_kinks);
  const rates = m.config?.interest_rates ?? [];
  const borrowApy = estimateBorrowAprPercent(utilization, rates, kinks);
  const spreadFee = num(m.config?.spread_fee_bps) / 10000; // BPS → fraction
  const supplyApy = borrowApy * (utilization / 100) * (1 - spreadFee);

  // Risk params from config
  const ltv                  = num(m.config?.safe_collateral_ratio) / 100;
  const liquidationThreshold = num(m.config?.liquidation_threshold) / 100;
  const supplyCapCeiling     = rawToHuman(m.config?.deposit_limit ?? '0', decimals);
  const borrowCapCeiling     = rawToHuman(m.config?.borrow_limit ?? '0', decimals);

  // IRM params: kinks[0]=0% with rate[0]; kinks[len-2] is the kink utilization;
  // rates between are the multiplier slope; rate after the kink is the jump.
  const irm = (kinks.length >= 2 && rates.length >= 2)
    ? {
        baseRate:       num(rates[0]) / 100,                              // %
        multiplier:     (num(rates[1]) - num(rates[0])) / 100,            // % rise to first kink
        jumpMultiplier: (num(rates[rates.length - 1]) - num(rates[Math.max(0, rates.length - 2)])) / 100,
        kink:           kinks[kinks.length - 2] / 100,                    // decimal 0-1
        reserveFactor:  num(m.config?.spread_fee_bps) / 10000,            // decimal 0-1
      }
    : undefined;

  return {
    symbol,
    coinType,
    decimals,
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
    supplyCapCeiling,
    borrowCapCeiling,
    optimalUtilization: kinks.length >= 2 ? kinks[kinks.length - 2] / 100 : 0,
    irm,
    price,
  };
}
