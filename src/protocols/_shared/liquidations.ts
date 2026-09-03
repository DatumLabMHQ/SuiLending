/**
 * Shared best-effort liquidation event parser.
 *
 * Different Sui lending protocols emit `LiquidateEvent` with varying field
 * shapes. We don't have an authoritative cross-protocol parser, so this
 * helper does pragmatic heuristic extraction of the fields most commonly
 * present:
 *
 *   liquidator     — direct field, OR fall back to tx sender
 *   borrower       — `obligation_id` / `position_id` / `obligation` / `vault`
 *                    / direct `borrower` field
 *   debtAsset      — coinType from `repay_coin_type` / `debt_asset` / etc.
 *   collateralAsset — same, from `withdraw_coin_type` / `collateral_asset`
 *   debtAmount     — raw number from `repay_amount` / `debt_amount` /
 *                    `repay_on_behalf_amount`
 *   collateralAmount — raw from `withdraw_amount` / `collateral_amount` /
 *                      `seized_amount` / `collateral_seized`
 *
 * Returns events with USD/price fields = 0; the dashboard can backfill
 * via current pool prices if needed. Skips events that can't yield even
 * a borrower + debt/collateral asset pair.
 */

import type { NormalizedLiquidation } from '../types';
import { queryEvents, rpc, type EventCursor } from '@/lib/rpc';

interface FetchOpts {
  untilEventId?: string;
  maxPages?: number;
  /** Optional decimal lookup by coinType — defaults to 9 if missing. */
  decimals?: Record<string, number>;
  /** Optional symbol lookup by coinType. */
  symbols?: Record<string, string>;
}

export async function tryFetchLiquidations(
  eventType: string,
  opts: FetchOpts = {},
): Promise<NormalizedLiquidation[]> {
  const { untilEventId, maxPages = 4, decimals = {}, symbols = {} } = opts;
  const out: NormalizedLiquidation[] = [];

  let cursor: EventCursor | null = null;
  let pages = 0;

  while (pages < maxPages) {
    let page;
    try {
      page = await queryEvents(eventType, cursor, 50, 'descending');
    } catch (e) {
      console.warn(`[tryFetchLiquidations] queryEvents failed for ${eventType}:`,
        e instanceof Error ? e.message : e);
      break;
    }

    let stop = false;
    for (const evt of page.data) {
      const eventId = `${evt.id.txDigest}:${evt.id.eventSeq}`;
      if (untilEventId && eventId === untilEventId) { stop = true; break; }

      const j = evt.parsedJson as Record<string, unknown>;
      const parsed = pickFields(j);

      // Need at minimum a borrower-equivalent and one asset to be useful
      if (!parsed.borrower && !parsed.collateralAsset && !parsed.debtAsset) continue;

      // Resolve liquidator: prefer event field, fall back to tx sender
      let liquidator = parsed.liquidator;
      if (!liquidator) {
        try {
          const tx = await rpc<{ transaction?: { data?: { sender?: string } } }>(
            'sui_getTransactionBlock', [evt.id.txDigest, { showInput: true }],
          );
          liquidator = tx.transaction?.data?.sender ?? '';
        } catch { liquidator = ''; }
      }

      const collateralCoinType = parsed.collateralAsset ?? '';
      const debtCoinType       = parsed.debtAsset ?? '';
      const cDec = decimals[collateralCoinType] ?? 9;
      const dDec = decimals[debtCoinType] ?? 9;

      const collateralAmount = parsed.collateralAmount != null ? parsed.collateralAmount / 10 ** cDec : 0;
      const debtAmount       = parsed.debtAmount       != null ? parsed.debtAmount       / 10 ** dDec : 0;

      out.push({
        id: eventId,
        txDigest: evt.id.txDigest,
        timestamp: new Date(Number(evt.timestampMs)),
        liquidator: (liquidator || '').slice(0, 66),
        borrower: (parsed.borrower || '').slice(0, 66),
        collateralAsset: (symbols[collateralCoinType] ?? collateralCoinType.split('::').pop()?.toUpperCase() ?? '').slice(0, 24),
        collateralAmount,
        collateralPrice: 0,
        collateralUsd: 0,
        debtAsset: (symbols[debtCoinType] ?? debtCoinType.split('::').pop()?.toUpperCase() ?? '').slice(0, 24),
        debtAmount,
        debtPrice: 0,
        debtUsd: 0,
        treasuryAmount: 0,
      });
    }

    if (stop || !page.hasNextPage) break;
    cursor = page.nextCursor;
    pages += 1;
  }

  return out;
}

// ─── Field extraction heuristics ────────────────────────────────────────────

interface Picked {
  liquidator?: string;
  borrower?: string;
  collateralAsset?: string;
  debtAsset?: string;
  collateralAmount?: number;
  debtAmount?: number;
}

function pickFields(j: Record<string, unknown>): Picked {
  return {
    liquidator: pickStr(j, ['liquidator', 'sender', 'caller']),
    borrower: pickStr(j, [
      'borrower', 'user', 'obligation_id', 'obligation', 'position_id',
      'position', 'vault_id', 'vault', 'debtor',
    ]),
    collateralAsset: pickCoinType(j, [
      'withdraw_coin_type', 'collateral_coin_type', 'collateral_type',
      'collateral_asset', 'seized_coin_type', 'collateral',
    ]),
    debtAsset: pickCoinType(j, [
      'repay_coin_type', 'debt_coin_type', 'debt_type', 'debt_asset',
      'borrow_coin_type', 'usdb_coin_type', 'borrow_asset',
    ]),
    collateralAmount: pickNum(j, [
      'withdraw_amount', 'collateral_amount', 'seized_amount',
      'collateral_seized', 'seize_amount',
    ]),
    debtAmount: pickNum(j, [
      'repay_amount', 'debt_amount', 'debt_repaid', 'repaid',
      'repay_on_behalf_amount', 'usdb_repaid',
    ]),
  };
}

function pickStr(j: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = j[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNum(j: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = j[k];
    if (v == null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Coerce a coinType value. Sui's parsedJson sometimes returns a `TypeName`
 * struct as `{ name: "..." }`, sometimes as a bare string. Both forms land
 * here and emerge as `0x...::module::TYPE`.
 */
function pickCoinType(j: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = j[k];
    if (!v) continue;
    if (typeof v === 'string') return v.startsWith('0x') ? v : '0x' + v;
    if (typeof v === 'object') {
      const name = (v as { name?: string }).name;
      if (typeof name === 'string') return name.startsWith('0x') ? name : '0x' + name;
    }
  }
  return undefined;
}
