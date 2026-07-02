// ═══════════════════════════════════════════════════════════════════
// JUNE 2026 DATA AUDIT + REPORT DATA PULL
// Mirrors may-coverage.ts + verify-report-claims.ts + verify-may31-state.ts
// methodology exactly ($1 OR filter, DefiLlama-canonical TVL, month-end
// composition read). Prints a human summary AND writes
// docs/june-2026-data.json with every series the June MDX report needs.
//
// Run from repo root:  npx tsx scripts/june-audit.ts
// ═══════════════════════════════════════════════════════════════════
import { getDb } from '../src/lib/db';
import * as fs from 'fs';
import * as path from 'path';

const PROTOCOLS = ['navi', 'suilend', 'scallop', 'alphalend', 'bucket'];
const STABLES = new Set(['USDC','USDT','suiUSDT','wUSDC','wUSDT','USDsui','USDSUI','USDB','BUCK','AUSD','FDUSD','USDY','mUSD']);
const SUI_LSTS = new Set(['SUI','vSUI','haSUI','sSUI','afSUI','stSUI']);
const JUNE_START = '2026-06-01';
const JUNE_END = '2026-06-30';

const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), window: { start: JUNE_START, end: JUNE_END } };

(async () => {
  const db = getDb(); if (!db) throw new Error('no db');

  // ── 1. COVERAGE: PoolDaily ────────────────────────────────────────
  console.log('═══ 1. PoolDaily coverage — June 2026 (target 30 days) ═══');
  const pd = (await db.$queryRawUnsafe(`
    SELECT protocol, COUNT(DISTINCT date)::int AS days,
           MIN(date) AS first, MAX(date) AS last,
           COUNT(DISTINCT symbol)::int AS markets
    FROM "PoolDaily"
    WHERE date >= '${JUNE_START}'::date AND date <= '${JUNE_END}'::date
    GROUP BY protocol ORDER BY protocol
  `)) as any[];
  for (const r of pd)
    console.log(`  ${r.protocol.padEnd(10)} ${String(r.days).padStart(3)} days  ${r.first.toISOString().slice(0,10)} → ${r.last.toISOString().slice(0,10)}  ${r.markets} markets`);
  out.poolDailyCoverage = pd.map(r => ({ protocol: r.protocol, days: r.days, first: r.first.toISOString().slice(0,10), last: r.last.toISOString().slice(0,10), markets: r.markets }));

  // Missing PoolDaily dates per protocol
  const pdMissing = (await db.$queryRawUnsafe(`
    SELECT p.protocol, d.day::date AS missing
    FROM (SELECT DISTINCT protocol FROM "PoolDaily") p
    CROSS JOIN generate_series('${JUNE_START}'::date, '${JUNE_END}'::date, '1 day') AS d(day)
    LEFT JOIN (SELECT DISTINCT protocol, date FROM "PoolDaily") x
      ON x.protocol = p.protocol AND x.date = d.day::date
    WHERE x.protocol IS NULL
    ORDER BY p.protocol, d.day
  `)) as any[];
  const missingByProto: Record<string, string[]> = {};
  for (const r of pdMissing) (missingByProto[r.protocol] ??= []).push(r.missing.toISOString().slice(0,10));
  for (const [p, ds] of Object.entries(missingByProto))
    console.log(`  MISSING ${p}: ${ds.join(', ')}`);
  if (!pdMissing.length) console.log('  No missing PoolDaily dates. ✓');
  out.poolDailyMissing = missingByProto;

  // ── 2. COVERAGE: DefillamaTvl ─────────────────────────────────────
  console.log('\n═══ 2. DefillamaTvl coverage — June 2026 ═══');
  const dl = (await db.$queryRawUnsafe(`
    SELECT protocol, COUNT(*)::int AS days, MIN(date) AS first, MAX(date) AS last
    FROM "DefillamaTvl"
    WHERE date >= '${JUNE_START}'::date AND date <= '${JUNE_END}'::date
    GROUP BY protocol ORDER BY protocol
  `)) as any[];
  for (const r of dl)
    console.log(`  ${r.protocol.padEnd(10)} ${String(r.days).padStart(3)} days  ${r.first.toISOString().slice(0,10)} → ${r.last.toISOString().slice(0,10)}`);
  out.defillamaCoverage = dl.map(r => ({ protocol: r.protocol, days: r.days }));

  // ── 3. COVERAGE: PoolSnapshot distinct days ───────────────────────
  console.log('\n═══ 3. PoolSnapshot distinct days — June 2026 ═══');
  const ps = (await db.$queryRawUnsafe(`
    SELECT protocol, COUNT(DISTINCT timestamp::date)::int AS days,
           COUNT(*)::int AS rows
    FROM "PoolSnapshot"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
    GROUP BY protocol ORDER BY protocol
  `)) as any[];
  for (const r of ps)
    console.log(`  ${r.protocol.padEnd(10)} ${String(r.days).padStart(3)} days  ${r.rows} snapshot rows`);
  out.poolSnapshotCoverage = ps.map(r => ({ protocol: r.protocol, days: r.days, rows: r.rows }));

  // ── 4. TVL trajectory (DefillamaTvl, canonical) ───────────────────
  console.log('\n═══ 4. TVL: Jun 1 vs Jun 30 per protocol ═══');
  const traj: any[] = [];
  for (const proto of PROTOCOLS) {
    const rows = (await db.$queryRawUnsafe(`
      SELECT date, "tvlUsd"::float8 AS tvl FROM "DefillamaTvl"
      WHERE protocol = $1 AND date IN ('${JUNE_START}'::date, '${JUNE_END}'::date)
      ORDER BY date
    `, proto)) as any[];
    if (rows.length >= 2) {
      const a = rows[0].tvl, b = rows[rows.length-1].tvl, ch = ((b-a)/a)*100;
      console.log(`  ${proto.padEnd(10)} $${(a/1e6).toFixed(2)}M → $${(b/1e6).toFixed(2)}M  (${ch>=0?'+':''}${ch.toFixed(2)}%)`);
      traj.push({ protocol: proto, jun1: a, jun30: b, changePct: ch });
    } else console.log(`  ${proto.padEnd(10)} INCOMPLETE (${rows.length} boundary rows)`);
  }
  out.tvlTrajectory = traj;

  // Full daily sector series for the MDX chart
  const daily = (await db.$queryRawUnsafe(`
    SELECT date, protocol, "tvlUsd"::float8 AS tvl FROM "DefillamaTvl"
    WHERE date >= '${JUNE_START}'::date AND date <= '${JUNE_END}'::date
    ORDER BY date, protocol
  `)) as any[];
  out.tvlDaily = daily.map(r => ({ date: r.date.toISOString().slice(0,10), protocol: r.protocol, tvl: r.tvl }));

  const sec = (await db.$queryRawUnsafe(`
    SELECT date, SUM("tvlUsd")::float8 AS tvl, COUNT(*)::int AS n FROM "DefillamaTvl"
    WHERE date IN ('${JUNE_START}'::date, '${JUNE_END}'::date)
    GROUP BY date ORDER BY date
  `)) as any[];
  if (sec.length === 2) {
    const ch = ((sec[1].tvl - sec[0].tvl) / sec[0].tvl) * 100;
    console.log(`  SECTOR     $${(sec[0].tvl/1e6).toFixed(2)}M → $${(sec[1].tvl/1e6).toFixed(2)}M  (${ch>=0?'+':''}${ch.toFixed(2)}%)  [${sec[0].n}/${sec[1].n} protocols]`);
    out.sector = { jun1: sec[0].tvl, jun30: sec[1].tvl, changePct: ch };
  }

  // HHI on Jun 30 shares
  const jun30 = (await db.$queryRawUnsafe(`
    SELECT protocol, "tvlUsd"::float8 AS tvl FROM "DefillamaTvl"
    WHERE date = '${JUNE_END}'::date ORDER BY tvl DESC
  `)) as any[];
  const tot = jun30.reduce((s,r)=>s+r.tvl,0);
  let hhi = 0; for (const r of jun30) { const sh=(r.tvl/tot)*100; hhi += sh*sh; }
  console.log(`  HHI (Jun 30): ${hhi.toFixed(1)} · top-2 share: ${((jun30[0]?.tvl+jun30[1]?.tvl)/tot*100).toFixed(1)}%`);
  out.hhi = hhi;
  out.jun30Shares = jun30.map(r => ({ protocol: r.protocol, tvl: r.tvl, sharePct: r.tvl/tot*100 }));

  // ── 5. LIQUIDATIONS June ($1 OR filter, identical to May) ─────────
  console.log('\n═══ 5. Liquidations — June 2026 ($1 OR filter) ═══');
  const liq = (await db.$queryRawUnsafe(`
    SELECT protocol,
           COUNT(*)::int AS events,
           SUM("debtUsd")::float8 AS debt,
           AVG("debtUsd")::float8 AS avg_debt,
           SUM("collateralUsd")::float8 AS seized,
           COUNT(DISTINCT liquidator)::int AS liquidators
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
    GROUP BY protocol ORDER BY debt DESC
  `)) as any[];
  const raw = (await db.$queryRawUnsafe(`
    SELECT protocol, COUNT(*)::int AS events FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
    GROUP BY protocol
  `)) as any[];
  const rawMap = Object.fromEntries(raw.map(r => [r.protocol, r.events]));
  for (const r of liq)
    console.log(`  ${r.protocol.padEnd(10)} ${String(r.events).padStart(5)} events (raw ${rawMap[r.protocol]})  debt $${(r.debt/1e6).toFixed(3)}M  avg $${r.avg_debt.toFixed(0)}  seized $${(r.seized/1e6).toFixed(3)}M  ${r.liquidators} liquidators`);
  out.liquidations = liq.map(r => ({ ...r, rawEvents: rawMap[r.protocol] }));

  // Top liquidator per protocol
  console.log('\n  Top liquidator share:');
  const topLiq: any[] = [];
  for (const proto of PROTOCOLS.filter(p => p !== 'bucket')) {
    const rows = (await db.$queryRawUnsafe(`
      SELECT liquidator, COUNT(*)::int AS n FROM "LiquidationEvent"
      WHERE protocol = $1
        AND timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
        AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
      GROUP BY liquidator ORDER BY n DESC LIMIT 1
    `, proto)) as any[];
    const t = liq.find(l => l.protocol === proto);
    if (rows.length && t) {
      const share = rows[0].n / t.events * 100;
      console.log(`  ${proto.padEnd(10)} ${rows[0].liquidator.slice(0,10)}…  ${rows[0].n}/${t.events} (${share.toFixed(1)}%)`);
      topLiq.push({ protocol: proto, liquidator: rows[0].liquidator, events: rows[0].n, sharePct: share });
    }
  }
  out.topLiquidators = topLiq;

  // Sector-wide dedup liquidator count + multi-protocol operators
  const dedup = (await db.$queryRawUnsafe(`
    SELECT COUNT(DISTINCT liquidator)::int AS uniq,
           (SELECT COUNT(*)::int FROM (
              SELECT liquidator FROM "LiquidationEvent"
              WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
                AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
              GROUP BY liquidator HAVING COUNT(DISTINCT protocol) > 1) m) AS multi
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
  `)) as any[];
  console.log(`  Sector distinct liquidators: ${dedup[0].uniq} (${dedup[0].multi} on >1 protocol)`);
  out.liquidatorDedup = dedup[0];

  // Weekly buckets
  const weekly = (await db.$queryRawUnsafe(`
    SELECT date_trunc('week', timestamp)::date AS week,
           COUNT(*)::int AS events, SUM("debtUsd")::float8 AS debt
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
    GROUP BY week ORDER BY week
  `)) as any[];
  console.log('\n  Weekly: ' + weekly.map(w => `${w.week.toISOString().slice(5,10)}: ${w.events} ev / $${(w.debt/1e6).toFixed(3)}M`).join(' · '));
  out.liquidationsWeekly = weekly.map(w => ({ week: w.week.toISOString().slice(0,10), events: w.events, debt: w.debt }));

  // Daily series for MDX chart
  const liqDaily = (await db.$queryRawUnsafe(`
    SELECT timestamp::date AS date, protocol, COUNT(*)::int AS events,
           SUM("debtUsd")::float8 AS debt, SUM("collateralUsd")::float8 AS seized
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
    GROUP BY date, protocol ORDER BY date
  `)) as any[];
  out.liquidationsDaily = liqDaily.map(r => ({ date: r.date.toISOString().slice(0,10), protocol: r.protocol, events: r.events, debt: r.debt, seized: r.seized }));

  // ── 6. ANOMALY SCAN: outsized events (the Jun-24 wUSDT check) ─────
  console.log('\n═══ 6. Anomaly scan: events with debt or collateral > $2M ═══');
  const anom = (await db.$queryRawUnsafe(`
    SELECT protocol, "txDigest", timestamp, "collateralAsset", "collateralAmount"::float8 AS camt,
           "collateralPrice"::float8 AS cprice, "collateralUsd"::float8 AS cusd,
           "debtAsset", "debtUsd"::float8 AS dusd
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_START}T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("collateralUsd" > 2000000 OR "debtUsd" > 2000000)
    ORDER BY "collateralUsd" DESC LIMIT 20
  `)) as any[];
  for (const r of anom)
    console.log(`  ${r.protocol} ${r.timestamp.toISOString()} ${r.collateralAsset}: amt=${r.camt} price=${r.cprice} → $${(r.cusd/1e6).toFixed(2)}M collateral, $${(r.dusd/1e6).toFixed(2)}M debt (${r.txDigest})`);
  if (!anom.length) console.log('  None. ✓');
  out.anomalies = anom.map(r => ({ ...r, timestamp: r.timestamp.toISOString() }));

  // ── 7. COMPOSITION as-of Jun 30 (latest snapshot ≤ Jul 1) ─────────
  console.log('\n═══ 7. Composition as-of Jun 30 ═══');
  const comp = (await db.$queryRawUnsafe(`
    SELECT DISTINCT ON (protocol, symbol)
      protocol, symbol, "totalSupplyUsd"::float8 AS sup, "totalBorrowsUsd"::float8 AS bor,
      timestamp
    FROM "PoolSnapshot"
    WHERE timestamp < '2026-07-01T00:00:00Z' AND timestamp >= '2026-06-28T00:00:00Z'
    ORDER BY protocol, symbol, timestamp DESC
  `)) as any[];
  let stableBor = 0, totalBor = 0, suiSup = 0, totalSup = 0;
  const perProto: Record<string, { sup: number; bor: number }> = {};
  for (const r of comp) {
    totalBor += r.bor; totalSup += r.sup;
    if (STABLES.has(r.symbol)) stableBor += r.bor;
    if (SUI_LSTS.has(r.symbol)) suiSup += r.sup;
    (perProto[r.protocol] ??= { sup: 0, bor: 0 });
    perProto[r.protocol].sup += r.sup; perProto[r.protocol].bor += r.bor;
  }
  console.log(`  Sector supply $${(totalSup/1e6).toFixed(1)}M · borrow $${(totalBor/1e6).toFixed(1)}M`);
  console.log(`  Stablecoin borrow share: ${(stableBor/totalBor*100).toFixed(1)}%  (May: 46.7%)`);
  console.log(`  SUI+LST supply share:    ${(suiSup/totalSup*100).toFixed(1)}%  (May: 32.3%)`);
  for (const [p, v] of Object.entries(perProto))
    console.log(`  ${p.padEnd(10)} supply $${(v.sup/1e6).toFixed(1)}M · borrow $${(v.bor/1e6).toFixed(1)}M`);
  out.composition = {
    totalSupplyUsd: totalSup, totalBorrowUsd: totalBor,
    stableBorrowSharePct: stableBor/totalBor*100, suiLstSupplySharePct: suiSup/totalSup*100,
    perProtocol: perProto,
    perAsset: comp.map(r => ({ protocol: r.protocol, symbol: r.symbol, sup: r.sup, bor: r.bor, asOf: r.timestamp.toISOString() })),
  };

  // Market count
  const mkts = (await db.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT DISTINCT protocol, symbol FROM "PoolSnapshot"
      WHERE timestamp >= '2026-06-28T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
    ) x
  `)) as any[];
  console.log(`  Active markets (Jun 28-30 window): ${mkts[0].n}  (May: 159)`);
  out.activeMarkets = mkts[0].n;

  // ── 8. Rate model params (current read) ───────────────────────────
  console.log('\n═══ 8. Liquidation thresholds, current read ═══');
  const rmp = (await db.$queryRawUnsafe(`
    SELECT protocol, symbol, "liquidationThreshold"::float8 AS lt, "updatedAt"
    FROM "RateModelParams"
    WHERE symbol IN ('SUI','USDC','USDT','wUSDT','WBTC','WETH')
    ORDER BY symbol, protocol
  `)) as any[];
  for (const r of rmp)
    console.log(`  ${r.symbol.padEnd(8)} ${r.protocol.padEnd(10)} LT=${(r.lt*100).toFixed(0)}%  (as of ${r.updatedAt.toISOString().slice(0,10)})`);
  out.rateModelParams = rmp.map(r => ({ protocol: r.protocol, symbol: r.symbol, lt: r.lt, updatedAt: r.updatedAt.toISOString() }));

  // ── Write JSON ────────────────────────────────────────────────────
  const outPath = path.join(process.cwd(), 'docs', 'june-2026-data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 2));
  console.log(`\n✓ Wrote ${outPath}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
