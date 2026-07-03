// ═══════════════════════════════════════════════════════════════════
// PUBLISH CHART DATA — May + June 2026 combined report
// Exports the three series the report's charts still need May data for.
// Same conventions as june-audit.ts. Writes docs/may-june-chart-data.json.
// Run from repo root:  npx tsx scripts/publish-chart-data.ts
// (or however june-audit.ts was successfully run)
// ═══════════════════════════════════════════════════════════════════
import { getDb } from '../src/lib/db';
import * as fs from 'fs';
import * as path from 'path';

const out: Record<string, unknown> = { generatedAt: new Date().toISOString() };

(async () => {
  const db = getDb(); if (!db) throw new Error('no db');

  // ── 1. Daily TVL per protocol, 1 May – 30 Jun (DefillamaTvl) ──────
  const tvl = (await db.$queryRawUnsafe(`
    SELECT date, protocol, "tvlUsd"::float8 AS tvl
    FROM "DefillamaTvl"
    WHERE date >= '2026-05-01'::date AND date <= '2026-06-30'::date
    ORDER BY date, protocol
  `)) as any[];
  out.tvlDaily = tvl.map(r => ({ date: r.date.toISOString().slice(0, 10), protocol: r.protocol, tvl: Math.round(r.tvl) }));
  console.log(`1. tvlDaily: ${tvl.length} rows`);

  // ── 2. Daily liquidated debt, sector, 1 May – 30 Jun ($1 OR filter) ─
  const liq = (await db.$queryRawUnsafe(`
    SELECT timestamp::date AS date, SUM("debtUsd")::float8 AS debt, COUNT(*)::int AS events
    FROM "LiquidationEvent"
    WHERE timestamp >= '2026-05-01T00:00:00Z' AND timestamp < '2026-07-01T00:00:00Z'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
    GROUP BY date ORDER BY date
  `)) as any[];
  out.liqDaily = liq.map(r => ({ date: r.date.toISOString().slice(0, 10), debt: Math.round(r.debt), events: r.events }));
  console.log(`2. liqDaily: ${liq.length} rows`);

  // ── 3. Per-asset supply/borrow at 31 May (latest snapshot ≤ 1 Jun) ─
  const may = (await db.$queryRawUnsafe(`
    SELECT symbol, SUM(sup)::float8 AS sup, SUM(bor)::float8 AS bor FROM (
      SELECT DISTINCT ON (protocol, symbol)
        symbol, "totalSupplyUsd"::float8 AS sup, "totalBorrowsUsd"::float8 AS bor
      FROM "PoolSnapshot"
      WHERE timestamp < '2026-06-01T00:00:00Z' AND timestamp >= '2026-05-28T00:00:00Z'
      ORDER BY protocol, symbol, timestamp DESC
    ) x GROUP BY symbol ORDER BY sup DESC
  `)) as any[];
  out.may31Assets = may.map(r => ({ symbol: r.symbol, sup: Math.round(r.sup), bor: Math.round(r.bor) }));
  console.log(`3. may31Assets: ${may.length} symbols`);

  const outPath = path.join(process.cwd(), 'docs', 'may-june-chart-data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  console.log(`✓ Wrote ${outPath}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
