/**
 * The aggregator's reads, served from the Datum data platform. Every function returns exactly
 * the row shape the legacy query returned (same column aliases, same units), so the assembly
 * code in /api/sui-lending does not know which source it is on.
 *
 * Tables (datum-models, schema `sui`):
 *   stg_sui__pool_snapshots   every hourly snapshot; used for "latest per pool" and the IRM JSON
 *   fct_sui_pool_daily        last snapshot of each pool per UTC day (history since Feb 2026)
 *   fct_sui_protocol_tvl_daily net/gross TVL per protocol per day with the DefiLlama reference
 *   fct_sui_liquidations      one row per liquidation event (history since Nov 2025)
 */
import { platformQuery } from './data-source';

export async function latestSnapshots<T>(freshSince: Date): Promise<T[]> {
  return platformQuery<T>(`
    SELECT DISTINCT ON (protocol, symbol)
      protocol, symbol, fetched_at AS "timestamp",
      total_supply::float8 AS "totalSupply", total_supply_usd::float8 AS "totalSupplyUsd",
      total_borrows::float8 AS "totalBorrows", total_borrows_usd::float8 AS "totalBorrowsUsd",
      available_liquidity_usd::float8 AS "availableLiquidityUsd",
      supply_apy::float8 AS "supplyApy", borrow_apy::float8 AS "borrowApy",
      utilization::float8 AS utilization, price_usd::float8 AS price,
      COALESCE(ltv, 0)::float8 AS ltv, COALESCE(liquidation_threshold, 0)::float8 AS "liquidationThreshold",
      (irm->>'baseRate')::float8       AS "irmBaseRate",
      (irm->>'multiplier')::float8     AS "irmMultiplier",
      (irm->>'jumpMultiplier')::float8 AS "irmJumpMult",
      (irm->>'kink')::float8           AS "irmKink",
      (irm->>'reserveFactor')::float8  AS "irmReserveFactor",
      (irm->>'psmFee')::float8         AS "psmFee",
      (irm->>'redemptionFee')::float8  AS "redemptionFee"
    FROM sui.stg_sui__pool_snapshots
    WHERE fetched_at >= $1 AND is_lending_pool
    ORDER BY protocol, symbol, fetched_at DESC
  `, [freshSince]);
}

export async function dailyRows<T>(since: Date): Promise<T[]> {
  return platformQuery<T>(`
    SELECT protocol, symbol, day AS date,
      total_supply_usd::float8 AS "closeTotalSupplyUsd", total_borrows_usd::float8 AS "closeTotalBorrowsUsd",
      available_liquidity_usd::float8 AS "closeLiquidityUsd", supply_apy::float8 AS "avgSupplyApy", borrow_apy::float8 AS "avgBorrowApy"
    FROM sui.fct_sui_pool_daily
    WHERE day >= $1::date AND is_lending_pool
    ORDER BY protocol, day
  `, [since]);
}

export async function defillamaRows<T>(since: Date): Promise<T[]> {
  return platformQuery<T>(`
    SELECT protocol, day AS date, defillama_tvl_usd::float8 AS "tvlUsd"
    FROM sui.fct_sui_protocol_tvl_daily
    WHERE day >= $1::date AND defillama_tvl_usd IS NOT NULL
    ORDER BY protocol, day
  `, [since]);
}

export async function liquidationCount(since30: Date): Promise<number> {
  const rows = await platformQuery<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM sui.fct_sui_liquidations
    WHERE ts >= $1 AND (debt_usd >= 1 OR collateral_usd >= 1)
  `, [since30]);
  return rows[0]?.count ?? 0;
}

export async function liquidationRows<T>(since30: Date): Promise<T[]> {
  return platformQuery<T>(`
    SELECT event_id AS id, protocol, tx_digest AS "txDigest", ts AS "timestamp", liquidator, borrower,
      collateral_asset AS "collateralAsset", collateral_amount::float8 AS "collateralAmount", collateral_usd::float8 AS "collateralUsd",
      debt_asset AS "debtAsset", debt_amount::float8 AS "debtAmount", debt_usd::float8 AS "debtUsd"
    FROM sui.fct_sui_liquidations
    WHERE ts >= $1 AND (debt_usd >= 1 OR collateral_usd >= 1)
    ORDER BY ts DESC
    LIMIT 500
  `, [since30]);
}

export async function userCounts<T>(since30: Date): Promise<T[]> {
  return platformQuery<T>(`
    SELECT protocol, count(DISTINCT borrower)::int AS users FROM sui.fct_sui_liquidations
    WHERE ts >= $1 GROUP BY protocol
  `, [since30]);
}
