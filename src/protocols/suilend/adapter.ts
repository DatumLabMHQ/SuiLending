/**
 * Suilend Protocol adapter.
 *
 * Uses @suilend/sdk to parse the on-chain LendingMarket object into reserves
 * with USD-denominated supply/borrow, current APYs, utilization, and risk
 * params. The SDK does the BigNumber/Decimal scaling for us — including Pyth
 * price fetching and interest rate evaluation against the piecewise model.
 *
 * Why the SDK rather than raw RPC: Suilend stores rates as cumulative borrow
 * indexes that need to be combined with the piecewise interest rate config
 * and a current-time delta to derive APYs. Reproducing that math correctly is
 * non-trivial and would diverge from official numbers as Suilend updates its
 * model. The SDK handles all of it.
 *
 * Cost: this pulls @mysten/sui v2 + Pyth + bcs into the dep tree. The NAVI
 * codebase historically used @mysten/sui v1 (only in protocols/navi/userState.ts)
 * which has been migrated to v2 alongside this adapter.
 *
 * ── Reserve filtering ─────────────────────────────────────────────────────
 * Suilend's MAIN_POOL has 45+ reserves including isolated frontier markets
 * and LST forks with no real TVL or no proper price feed. We filter to a
 * curated whitelist (SUILEND_WHITELIST_COINTYPES) to keep the dashboard
 * focused on real markets. Add a coinType to the whitelist to surface a new
 * reserve. Pass `?all=true` to the cron to bypass the filter for debugging.
 */

import BigNumber from 'bignumber.js';
import { getSuiClient } from '@/lib/sui-client';
import { normalizeFeedId } from '@suilend/sdk/utils/feedId';
import { SuilendClient } from '@suilend/sdk/client';
import { initializeSuilend } from '@suilend/sdk/lib/initialize';

import type { ProtocolAdapter, NormalizedPool, NormalizedLiquidation } from '../types';
import { SUILEND_LENDING_MARKET_ID, SUILEND_LENDING_MARKET_TYPE, SUILEND_EVENT_TYPES } from './config';
import { fetchSuiCoinPrices } from '@/lib/prices';
import { queryEvents, rpc, type EventCursor } from '@/lib/rpc';

// On-chain reads go through the shared gRPC client (see src/lib/sui-client.ts).
//
// Prices: the SDK prices reserves from Pyth Hermes, which started returning
// 401 (auth required) in late August 2026 and took Suilend pools down. We
// inject our own PriceFeedSource backed by coins.llama.fi, keyed by the
// reserves' Pyth feed ids, and tolerate feeds DefiLlama cannot price.
type FeedPrice = { id: string; price: number; emaPrice: number; publishTimeS: number };
function bytesToHex(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  return out;
}
function llamaPriceSource(feedToCoinType: Record<string, string>) {
  const lookup = async (ids: string[]) => {
    const wanted = ids.map((id) => normalizeFeedId(id));
    const coinTypes = Array.from(new Set(wanted.map((id) => feedToCoinType[id]).filter(Boolean)));
    const prices = coinTypes.length ? await fetchSuiCoinPrices(coinTypes) : {};
    const nowS = Math.floor(Date.now() / 1000);
    const feeds: FeedPrice[] = [];
    const missing: string[] = [];
    wanted.forEach((id, i) => {
      const ct = feedToCoinType[id];
      const p = ct ? prices[ct] : undefined;
      if (p && p > 0) feeds.push({ id, price: p, emaPrice: p, publishTimeS: nowS });
      else missing.push(ids[i]);
    });
    return { feeds, missing };
  };
  return {
    async getLatestPriceFeeds(ids: string[]) { return (await lookup(ids)).feeds; },
    async getLatestPriceFeedsPartial(ids: string[]) { return lookup(ids); },
  };
}

// ─── CoinType → canonical symbol ────────────────────────────────────────────
//
// Disambiguates Wormhole-bridged tokens (all use `::coin::COIN` so the
// trailing struct name collides) and renames awkward struct names like
// SPRING_SUI → sSUI. Order doesn't matter; lookup is by full coinType.
const CANONICAL_BY_COINTYPE: Record<string, string> = {
  // Native SUI
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 'SUI',

  // Stablecoins
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'USDC',
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 'wUSDC',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 'wUSDT',
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 'USDT',
  '0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD': 'AUSD',

  // Bridged BTC / ETH (Wormhole)
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 'WBTC',
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 'WETH',

  // SUI liquid staking tokens
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 'sSUI',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 'haSUI',
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 'afSUI',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 'vSUI',

  // Sui-native ecosystem tokens
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 'DEEP',
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': 'WAL',
  '0xb45fcfcc2cc07ce0702cc2d229621e046c906ef14d9b25e8e4d25f6e8763fef7::send::SEND': 'SEND',
};

// ─── Reserve filter ─────────────────────────────────────────────────────────
//
// Drop the long tail (45 reserves → ~14 real markets). Two-tier filter:
//   1. Whitelist: any coinType in CANONICAL_BY_COINTYPE always passes (gets a
//      canonical symbol like wUSDC instead of raw "COIN").
//   2. Dust threshold: any non-whitelisted reserve with at least $500K of
//      supply ALSO passes — surfaces real Suilend markets we haven't manually
//      mapped (XBTC, LBTC, USDSUI, etc.) with their raw struct-name symbol.
//      Add them to CANONICAL_BY_COINTYPE later for nicer labels.
const SUILEND_WHITELIST_COINTYPES = new Set<string>(Object.keys(CANONICAL_BY_COINTYPE));
const SUILEND_MIN_TVL_USD = 500_000;

// ─── LST price overrides ────────────────────────────────────────────────────
//
// Suilend SDK falls back to SUI price when a Pyth feed isn't configured for
// an LST. For canonical LSTs we fetch the real price from DefiLlama (keyed
// by coinType, more reliable than CoinGecko slug guessing) and override.
const LST_COINTYPES_TO_OVERRIDE: string[] = [
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI', // sSUI
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI',           // haSUI
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI',           // afSUI
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT',             // vSUI
];

// ─── Adapter ────────────────────────────────────────────────────────────────

const suilendAdapter: ProtocolAdapter = {
  async fetchPools(): Promise<NormalizedPool[]> {
    try {
      const suiClient = getSuiClient();
      const suilendClient = await SuilendClient.initialize(
        SUILEND_LENDING_MARKET_ID,
        SUILEND_LENDING_MARKET_TYPE,
        suiClient,
      );
      // Map each reserve's Pyth feed id to its coinType so our price source
      // can answer the SDK's feed-id lookups from DefiLlama.
      const feedToCoinType: Record<string, string> = {};
      for (const r of (suilendClient.lendingMarket?.reserves ?? []) as any[]) {
        const ct = r?.coinType?.name ?? r?.coinType;
        const bytes = r?.priceIdentifier?.bytes;
        if (typeof ct === 'string' && bytes) feedToCoinType[normalizeFeedId(bytesToHex(bytes))] = ct.startsWith('0x') ? ct : `0x${ct}`;
      }
      const { lendingMarket } = await initializeSuilend(suiClient, suilendClient, undefined, undefined, {
        pythConnection: llamaPriceSource(feedToCoinType),
        tolerateMissingPriceFeeds: true,
      });

      // Optional price lookups for LSTs that the SDK couldn't price properly.
      // Keyed by full coinType. Best-effort; if DefiLlama fails we keep the
      // SDK's fallback price (typically SUI's price for SUI LSTs — close
      // enough since LSTs trade within ±5% of SUI).
      const lstPrices = await fetchSuiCoinPrices(LST_COINTYPES_TO_OVERRIDE);

      // Filter → normalize → recompute USD with overridden prices
      return lendingMarket.reserves
        .filter((r) => {
          if (SUILEND_WHITELIST_COINTYPES.has(r.coinType)) return true;
          // Non-whitelisted: keep only if TVL >= dust threshold
          return toNum(r.depositedAmountUsd) >= SUILEND_MIN_TVL_USD;
        })
        .map((r) => toNormalized(r, lstPrices));
    } catch (error) {
      console.error('[suilend.fetchPools]', error);
      return [];
    }
  },

  async fetchPool(symbol: string): Promise<NormalizedPool | null> {
    const all = await this.fetchPools();
    return all.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  },

  /**
   * Index Suilend's on-chain LiquidateEvent. Event shape (verified via
   * suix_queryEvents 2026-04):
   *   liquidator_bonus_amount, obligation_id, protocol_fee_amount,
   *   repay_amount, repay_coin_type.name, repay_reserve_id,
   *   withdraw_amount, withdraw_coin_type.name, withdraw_reserve_id,
   *   lending_market_id
   *
   * Notes:
   *   - The event lacks `liquidator` and `borrower` addresses. We fall back
   *     to the tx sender for `liquidator` and use `obligation_id` as a
   *     borrower proxy (resolving to the EOA owner would require an extra
   *     getObject call per event).
   *   - Amounts are raw on-chain (×10^decimals). We resolve decimals via
   *     Pyth-priced reserves cached during fetchPools.
   */
  async fetchLiquidations({ untilEventId, maxPages = 4 } = {}): Promise<NormalizedLiquidation[]> {
    const out: NormalizedLiquidation[] = [];
    let cursor: EventCursor | null = null;
    let pages = 0;

    // First pass: collect all events into raw form so we can batch-fetch
    // prices once at the end, instead of per-event. We pre-collect the set
    // of distinct coinTypes we'll need to price.
    interface RawEvt {
      eventId: string; txDigest: string; timestamp: Date;
      sender: string; borrower: string;
      repayCoinType: string; withdrawCoinType: string;
      debtAmount: number; collateralAmount: number; treasuryAmount: number;
    }
    const raws: RawEvt[] = [];
    const coinTypesNeedingPrice = new Set<string>();

    while (pages < maxPages) {
      const page = await queryEvents(SUILEND_EVENT_TYPES.LIQUIDATE, cursor, 50, 'descending');

      let stop = false;
      for (const evt of page.data) {
        const eventId = `${evt.id.txDigest}:${evt.id.eventSeq}`;
        if (untilEventId && eventId === untilEventId) { stop = true; break; }

        const j = evt.parsedJson as Record<string, unknown>;
        const repayCoinType    = '0x' + ((j.repay_coin_type as { name?: string })?.name ?? '');
        const withdrawCoinType = '0x' + ((j.withdraw_coin_type as { name?: string })?.name ?? '');
        if (repayCoinType === '0x' || withdrawCoinType === '0x') continue;

        const decimals = (ct: string) => DECIMAL_BY_COINTYPE[ct] ?? 9;
        const dDec = decimals(repayCoinType);
        const cDec = decimals(withdrawCoinType);

        const debtAmount       = Number(String(j.repay_amount    ?? '0')) / 10 ** dDec;
        const collateralAmount = Number(String(j.withdraw_amount ?? '0')) / 10 ** cDec;
        const treasuryAmount   = Number(String(j.protocol_fee_amount ?? '0')) / 10 ** cDec;

        // Get tx sender as liquidator (event doesn't carry it)
        let sender = '';
        try {
          const tx = await rpc<{ transaction?: { data?: { sender?: string } } }>(
            'sui_getTransactionBlock', [evt.id.txDigest, { showInput: true }]
          );
          sender = tx.transaction?.data?.sender ?? '';
        } catch {}

        coinTypesNeedingPrice.add(repayCoinType);
        coinTypesNeedingPrice.add(withdrawCoinType);

        raws.push({
          eventId, txDigest: evt.id.txDigest,
          timestamp: new Date(Number(evt.timestampMs)),
          sender, borrower: String(j.obligation_id ?? ''),
          repayCoinType, withdrawCoinType,
          debtAmount, collateralAmount, treasuryAmount,
        });
      }

      if (stop || !page.hasNextPage) break;
      cursor = page.nextCursor;
      pages += 1;
    }

    // Batch-fetch USD prices for every asset that appeared in events.
    // DefiLlama's `sui:<coinType>` endpoint covers stables, BTC variants, ETH,
    // SUI LSTs, DEEP, WAL out of the box.
    //
    // Note: this uses the CURRENT spot price for events that may be hours/days
    // old — accurate within ~1-2% for recent events, less for older ones. To
    // get exact-time prices we'd need Pyth historical or a price snapshot
    // table (deferred).
    const priceMap = await fetchSuiCoinPrices([...coinTypesNeedingPrice]).catch(() => ({} as Record<string, number>));

    for (const r of raws) {
      const debtPrice       = priceMap[r.repayCoinType]    ?? 0;
      const collateralPrice = priceMap[r.withdrawCoinType] ?? 0;
      out.push({
        id: r.eventId,
        txDigest: r.txDigest,
        timestamp: r.timestamp,
        liquidator: r.sender,
        borrower: r.borrower,
        collateralAsset: CANONICAL_BY_COINTYPE[r.withdrawCoinType] ?? r.withdrawCoinType.split('::').pop()?.toUpperCase() ?? '',
        collateralAmount: r.collateralAmount,
        collateralPrice,
        collateralUsd: r.collateralAmount * collateralPrice,
        debtAsset: CANONICAL_BY_COINTYPE[r.repayCoinType] ?? r.repayCoinType.split('::').pop()?.toUpperCase() ?? '',
        debtAmount: r.debtAmount,
        debtPrice,
        debtUsd: r.debtAmount * debtPrice,
        treasuryAmount: r.treasuryAmount,
      });
    }

    return out;
  },
};

// Static decimal map — used to scale event amounts. Same canonical types as
// the pool whitelist.
const DECIMAL_BY_COINTYPE: Record<string, number> = {
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 9,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 6,
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 6,
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 6,  // wUSDC
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 6,  // wUSDT
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 8,  // WETH
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 8,  // WBTC
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI': 9,
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 9,
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': 9,
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 6,
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': 9,
};

export default suilendAdapter;

// ─── Helpers ────────────────────────────────────────────────────────────────

type ParsedReserve = Awaited<ReturnType<typeof initializeSuilend>>['lendingMarket']['reserves'][number];

const toNum = (v: BigNumber | { toString(): string } | number | string | undefined | null, fallback = 0): number => {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : new BigNumber(String(v)).toNumber();
  return Number.isFinite(n) ? n : fallback;
};

/** Resolve coinType → canonical symbol. Falls back to trailing struct name. */
function symbolFromCoinType(coinType: string): string {
  const known = CANONICAL_BY_COINTYPE[coinType];
  if (known) return known;
  const tail = (coinType.split('::').pop() ?? coinType).toUpperCase();
  return tail.slice(0, 24);
}

function toNormalized(r: ParsedReserve, lstPrices: Record<string, number>): NormalizedPool {
  const symbol = symbolFromCoinType(r.coinType);

  const totalSupply           = toNum(r.depositedAmount);
  const totalBorrows          = toNum(r.borrowedAmount);
  const availableLiquidity    = toNum(r.availableAmount);

  // Resolve price: SDK price first, override for LSTs that DefiLlama priced.
  let price = toNum(r.price);
  if (lstPrices[r.coinType]) price = lstPrices[r.coinType];

  // Recompute USD totals against the resolved price so override flows through
  // to supplyUsd/borrowUsd/liquidityUsd consistently.
  const totalSupplyUsd        = totalSupply * price;
  const totalBorrowsUsd       = totalBorrows * price;
  const availableLiquidityUsd = availableLiquidity * price;

  const supplyApy = toNum(r.depositAprPercent);
  const borrowApy = toNum(r.borrowAprPercent);

  const utilization = totalSupply > 0 ? (totalBorrows / totalSupply) * 100 : 0;

  const cfg = r.config;
  const ltv                  = cfg ? toNum(cfg.openLtvPct) / 100 : 0;
  const liquidationThreshold = cfg ? toNum(cfg.closeLtvPct) / 100 : 0;
  const supplyCapCeiling     = cfg ? toNum(cfg.depositLimit) : 0;
  const borrowCapCeiling     = cfg ? toNum(cfg.borrowLimit) : 0;

  // Suilend's IRM is a piecewise array of {utilPercent, aprPercent}. The kink
  // proxy is the second-to-last utilPercent (the highest pre-jump point).
  // Map the piecewise model to our 5-knob IrmParams shape:
  //   baseRate         = aprPercent[0]
  //   multiplier       = aprPercent[N-2] − aprPercent[0]   (slope from 0 → kink)
  //   jumpMultiplier   = aprPercent[N-1] − aprPercent[N-2] (slope above kink)
  //   kink             = utilPercent[N-2] / 100
  //   reserveFactor    = config.spreadFeeBps / 10000
  let optimalUtilization = 0;
  let irm: NormalizedPool['irm'] | undefined;
  if (cfg?.interestRate && cfg.interestRate.length >= 2) {
    const points = cfg.interestRate;
    const N = points.length;
    optimalUtilization = toNum(points[N - 2]?.utilPercent) / 100;
    const baseRate       = toNum(points[0]?.aprPercent);
    const rateAtKink     = toNum(points[N - 2]?.aprPercent);
    const rateAtMaxUtil  = toNum(points[N - 1]?.aprPercent);
    irm = {
      baseRate,
      multiplier:     Math.max(0, rateAtKink - baseRate),
      jumpMultiplier: Math.max(0, rateAtMaxUtil - rateAtKink),
      kink:           optimalUtilization,
      reserveFactor:  toNum(cfg.spreadFeeBps) / 10000,
    };
  }

  return {
    symbol,
    coinType: r.coinType,
    decimals: r.mintDecimals,
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
    optimalUtilization,
    irm,
    price,
  };
}
