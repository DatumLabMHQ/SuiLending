// ═══════════════════════════════════════════════════════════════════
// JUNE 2026 CSV EXPORT
// Pulls every June series the dashboard captured into docs/june-2026-csv/*.csv.
// Granular tables (markets-daily, liquidation events, risk params) come
// straight from the DB; summary/derived series are read from the audit's
// docs/june-2026-data.json so both stay in lockstep. Same window + $1 OR
// liquidation filter as june-audit.ts. No metric logic changed here.
//
// Run:  node --env-file=.env.local --import tsx scripts/june-csv-export.ts
// ═══════════════════════════════════════════════════════════════════
import { getDb } from '../src/lib/db';
import * as fs from 'fs';
import * as path from 'path';

const JUNE_START = '2026-06-01';
const JUNE_END = '2026-06-30';
const OUT_DIR = path.join(process.cwd(), 'docs', 'june-2026-csv');

// ── CSV helpers (RFC-4180 quoting) ──────────────────────────────────
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'bigint') s = v.toString();
  else if (typeof v === 'object')
    s = (typeof (v as any).toString === 'function' && (v as any).toString !== Object.prototype.toString)
      ? (v as any).toString()
      : JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  return lines.join('\n') + '\n';
}
function write(name: string, rows: Record<string, unknown>[]) {
  fs.writeFileSync(path.join(OUT_DIR, name), toCsv(rows));
  console.log(`  ✓ ${name.padEnd(30)} ${String(rows.length).padStart(6)} rows`);
}

(async () => {
  const db = getDb(); if (!db) throw new Error('no db');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Writing June 2026 CSVs → ${OUT_DIR}\n`);

  // 1. Markets daily — per protocol/market/day (PoolDaily, the dashboard's core series)
  const marketsDaily = (await db.$queryRawUnsafe(`
    SELECT to_char(date,'YYYY-MM-DD') AS date, protocol, symbol,
      "avgSupplyApy"::float8   AS avg_supply_apy,
      "avgBorrowApy"::float8   AS avg_borrow_apy,
      "avgUtilization"::float8 AS avg_utilization,
      "closeTotalSupplyUsd"::float8  AS close_supply_usd,
      "closeTotalBorrowsUsd"::float8 AS close_borrows_usd,
      "closeLiquidityUsd"::float8    AS close_liquidity_usd,
      "closePrice"::float8           AS close_price
    FROM "PoolDaily"
    WHERE date >= '${JUNE_START}'::date AND date <= '${JUNE_END}'::date
    ORDER BY date, protocol, symbol
  `)) as any[];
  write('01_markets_daily.csv', marketsDaily);

  // 2. TVL daily — per protocol/day (DefiLlama, the report-canonical TVL)
  const tvlDaily = (await db.$queryRawUnsafe(`
    SELECT to_char(date,'YYYY-MM-DD') AS date, protocol, "tvlUsd"::float8 AS tvl_usd
    FROM "DefillamaTvl"
    WHERE date >= '${JUNE_START}'::date AND date <= '${JUNE_END}'::date
    ORDER BY date, protocol
  `)) as any[];
  write('02_tvl_daily.csv', tvlDaily);

  // 3. Liquidation events — every June event passing the $1 OR filter, anomalies flagged
  const liqEvents = (await db.$queryRawUnsafe(`
    SELECT protocol, timestamp, "txDigest" AS tx_digest, liquidator, borrower,
      "collateralAsset" AS collateral_asset, "collateralAmount"::float8 AS collateral_amount,
      "collateralPrice"::float8 AS collateral_price, "collateralUsd"::float8 AS collateral_usd,
      "debtAsset" AS debt_asset, "debtAmount"::float8 AS debt_amount,
      "debtPrice"::float8 AS debt_price, "debtUsd"::float8 AS debt_usd,
      "treasuryAmount"::float8 AS treasury_amount,
      ("collateralUsd" > 2000000 OR "debtUsd" > 2000000) AS anomaly_over_2m
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
    ORDER BY timestamp
  `)) as any[];
  write('03_liquidation_events.csv', liqEvents);

  // 4. Composition as-of Jun 30 — latest snapshot per protocol/market in the Jun 28-30 window
  const comp = (await db.$queryRawUnsafe(`
    SELECT DISTINCT ON (protocol, symbol)
      protocol, symbol,
      "totalSupplyUsd"::float8  AS supply_usd,
      "totalBorrowsUsd"::float8 AS borrows_usd,
      timestamp AS as_of
    FROM "PoolSnapshot"
    WHERE timestamp >= '2026-06-28T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
    ORDER BY protocol, symbol, timestamp DESC
  `)) as any[];
  write('04_composition_jun30.csv', comp);

  // 5. Risk params — full current read (all columns cast to text for a clean raw dump)
  const rmCols = (await db.$queryRawUnsafe(`
    SELECT string_agg(quote_ident(column_name)||'::text AS '||quote_ident(column_name), ', ' ORDER BY ordinal_position) AS sel
    FROM information_schema.columns WHERE table_name = 'RateModelParams'
  `)) as any[];
  const risk = (await db.$queryRawUnsafe(`
    SELECT ${rmCols[0].sel} FROM "RateModelParams" ORDER BY protocol, symbol
  `)) as any[];
  write('05_risk_params.csv', risk);

  // 6..12 derived summaries — read from the audit JSON so numbers can't drift
  const jp = path.join(process.cwd(), 'docs', 'june-2026-data.json');
  const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
  write('06_tvl_summary.csv', j.tvlTrajectory.map((r: any) => ({ protocol: r.protocol, jun1_usd: r.jun1, jun30_usd: r.jun30, change_pct: r.changePct })));
  write('07_jun30_shares.csv', j.jun30Shares.map((r: any) => ({ protocol: r.protocol, tvl_usd: r.tvl, share_pct: r.sharePct })));
  write('08_liquidations_summary.csv', j.liquidations.map((r: any) => ({ protocol: r.protocol, events_filtered: r.events, raw_events: r.rawEvents, debt_usd: r.debt, avg_debt_usd: r.avg_debt, seized_usd: r.seized, liquidators: r.liquidators })));
  write('09_liquidations_weekly.csv', j.liquidationsWeekly.map((r: any) => ({ week_start: r.week, events: r.events, debt_usd: r.debt })));
  write('10_liquidations_daily.csv', j.liquidationsDaily.map((r: any) => ({ date: r.date, protocol: r.protocol, events: r.events, debt_usd: r.debt, seized_usd: r.seized })));
  write('11_top_liquidators.csv', j.topLiquidators.map((r: any) => ({ protocol: r.protocol, liquidator: r.liquidator, events: r.events, share_pct: r.sharePct })));
  write('12_coverage.csv', j.poolDailyCoverage.map((r: any) => ({
    protocol: r.protocol, pooldaily_days: r.days, first: r.first, last: r.last, markets: r.markets,
    defillama_days: (j.defillamaCoverage.find((d: any) => d.protocol === r.protocol) || {}).days ?? '',
    missing_pooldaily_days: (j.poolDailyMissing[r.protocol] || []).join('; '),
  })));

  // README
  const readme = [
    'STATE OF LENDING ON SUI — JUNE 2026 DATA EXPORT',
    `Generated: ${j.generatedAt}  |  Window: ${j.window.start} .. ${j.window.end}`,
    `Protocols: NAVI, Suilend, Scallop, AlphaLend, Bucket`,
    '',
    'FILES',
    '  01_markets_daily.csv       Per protocol/market/day: APY (base, excl. incentives), utilization, close supply/borrow/liquidity USD, price. Source: PoolDaily.',
    '  02_tvl_daily.csv           Per protocol/day TVL (USD). Source: DefiLlama (report-canonical).',
    '  03_liquidation_events.csv  Every June liquidation >= $1 (debt OR collateral). anomaly_over_2m flags suspect-price events.',
    '  04_composition_jun30.csv   Latest supply/borrow USD per market in the Jun 28-30 window (month-end snapshot).',
    '  05_risk_params.csv         Current risk parameters per protocol/market (RateModelParams), raw.',
    '  06_tvl_summary.csv         Per protocol Jun 1 vs Jun 30 TVL + % change.',
    '  07_jun30_shares.csv        Jun 30 TVL share per protocol.',
    '  08_liquidations_summary.csv Per protocol event counts, debt, seized, unique liquidators.',
    '  09_liquidations_weekly.csv Weekly liquidation events + debt.',
    '  10_liquidations_daily.csv  Daily liquidation events/debt/seized per protocol.',
    '  11_top_liquidators.csv     Top liquidator per protocol + share.',
    '  12_coverage.csv            Per protocol day-coverage + any missing PoolDaily dates.',
    '',
    'KNOWN DATA-QUALITY FLAGS (do not publish without handling — surfaced by june-audit.ts):',
    '  1. AlphaLend DefiLlama TVL reads $0 on Jun 30 (02/06 CSVs) — a DefiLlama gap, not a real collapse;',
    '     04_composition shows AlphaLend alive (~$108M supply). This distorts the sector -30% figure (real ~ -17%).',
    '  2. NAVI liquidation on 2026-06-24 (wUSDT priced ~$60,481) = $401.87M phantom collateral (flagged',
    '     anomaly_over_2m=true in 03). Inflates NAVI seized in 08/10; real NAVI seized is ~$0.75M.',
    '  3. Bucket liquidationThreshold in 05 is stored as a percent (e.g. 90.91) while other protocols store a',
    '     fraction (0.90) — a units inconsistency, not a real 9091% threshold.',
    '',
    'METHODOLOGY: liquidations use the $1 OR filter (debtUsd>=1 OR collateralUsd>=1); TVL is DefiLlama-canonical;',
    'composition is a month-end (Jun 28-30) latest-snapshot read; APYs are base rates (exclude token incentives).',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'), readme + '\n');
  console.log(`  ✓ README.txt`);

  console.log(`\n✓ Done → ${OUT_DIR}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
