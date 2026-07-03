// ═══════════════════════════════════════════════════════════════════
// JUNE 2026 — ISSUE #02 METRICS
// Same conventions as june-audit.ts. All from Neon (PoolSnapshot /
// LiquidationEvent), June 2026. Appends to docs/june-issue02-data.json.
//
// Month-end reads use the latest snapshot per (protocol, symbol) in the
// Jun 28-30 window (carry-forward, so a market that misses a same-day snapshot
// isn't counted as $0). Month-start reads use the earliest snapshot per market
// in the Jun 1-3 window. Liquidations use the $1 OR filter, identical to
// june-audit.ts. No DefiLlama table used (alphalend's slug is dead) — TVL is
// computed as net supply − borrow from our own snapshots.
//
// Run: node --env-file=.env.local --import tsx scripts/june-issue02-metrics.ts
// ═══════════════════════════════════════════════════════════════════
import { getDb } from '../src/lib/db';
import * as fs from 'fs';
import * as path from 'path';

const W30_LO = '2026-06-28T00:00:00Z', W30_HI = '2026-07-01T00:00:00Z';
const W01_LO = '2026-06-01T00:00:00Z', W01_HI = '2026-06-04T00:00:00Z';
const JUNE_LO = '2026-06-01T00:00:00Z', JUNE_HI = '2026-07-01T00:00:00Z';
const PROTOCOLS = ['navi', 'suilend', 'scallop', 'alphalend', 'bucket'];

type Row = { protocol: string; symbol: string; sup: number; bor: number; sapy: number; bapy: number };

// HHI over a set of dollar values → sum of (percent share)^2, 0..10000.
function hhi(vals: number[]): number {
  const t = vals.reduce((s, v) => s + Math.max(0, v), 0);
  if (t <= 0) return 0;
  return vals.reduce((s, v) => { const sh = (Math.max(0, v) / t) * 100; return s + sh * sh; }, 0);
}
// Gini coefficient (0 = perfectly equal, →1 = one actor dominates).
function gini(xs: number[]): number {
  const a = xs.filter((v) => v >= 0).sort((x, y) => x - y);
  const n = a.length; if (!n) return 0;
  const sum = a.reduce((s, v) => s + v, 0); if (sum === 0) return 0;
  let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * a[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}
// Collapse per-protocol market symbols to a canonical asset for concentration.
function normSym(s: string): string {
  const u = s.toUpperCase();
  if (u.includes('USDC')) return 'USDC';
  if (u.includes('USDT')) return 'USDT';
  if (u.includes('USDB')) return 'USDB';
  if (u === 'SUI') return 'SUI';
  return s;
}

(async () => {
  const db = getDb(); if (!db) throw new Error('no db');
  const out: Record<string, unknown> = {};

  const fetchComp = async (lo: string, hi: string, order: 'ASC' | 'DESC') =>
    (await db.$queryRawUnsafe(`
      SELECT DISTINCT ON (protocol, symbol)
        protocol, symbol,
        "totalSupplyUsd"::float8 AS sup, "totalBorrowsUsd"::float8 AS bor,
        "supplyApy"::float8 AS sapy, "borrowApy"::float8 AS bapy
      FROM "PoolSnapshot"
      WHERE timestamp >= '${lo}' AND timestamp < '${hi}'
      ORDER BY protocol, symbol, timestamp ${order}
    `)) as Row[];

  const c30 = await fetchComp(W30_LO, W30_HI, 'DESC');
  const c01 = await fetchComp(W01_LO, W01_HI, 'ASC');
  console.log(`Loaded ${c30.length} Jun-30 market rows, ${c01.length} Jun-1 market rows`);
  const sm = c30.find((r) => r.protocol === 'navi' && normSym(r.symbol) === 'USDC');
  if (sm) console.log(`  units check — navi USDC: supplyApy=${sm.sapy}  borrowApy=${sm.bapy}  (APYs are percent)`);

  // ── 1. Per-protocol at Jun 30 vs Jun 1 ────────────────────────────
  console.log('\n═══ 1. Per-protocol metrics (Jun 30 vs Jun 1) ═══');
  const agg = (rows: Row[]) => {
    const m = new Map<string, { sup: number; bor: number; sW: number; bW: number }>();
    for (const r of rows) {
      let a = m.get(r.protocol); if (!a) { a = { sup: 0, bor: 0, sW: 0, bW: 0 }; m.set(r.protocol, a); }
      a.sup += r.sup; a.bor += r.bor; a.sW += r.sapy * r.sup; a.bW += r.bapy * r.bor;
    }
    return m;
  };
  const a30 = agg(c30), a01 = agg(c01);
  const metrics = (a: { sup: number; bor: number; sW: number; bW: number }) => {
    const wSupplyApy = a.sup > 0 ? a.sW / a.sup : 0;
    const wBorrowApy = a.bor > 0 ? a.bW / a.bor : 0;
    return { suppliedUsd: a.sup, borrowedUsd: a.bor, utilization: a.sup > 0 ? a.bor / a.sup : 0,
             wSupplyApy, wBorrowApy, effectiveSpread: wBorrowApy - wSupplyApy };
  };
  const s1: any[] = [];
  for (const p of PROTOCOLS) {
    const x = a30.get(p); if (!x) continue;
    const y = a01.get(p);
    const rec: any = { protocol: p, jun30: metrics(x), jun1: y ? metrics(y) : null };
    if (y) {
      rec.supplyChangePct = y.sup > 0 ? (x.sup - y.sup) / y.sup * 100 : null;
      rec.borrowChangePct = y.bor > 0 ? (x.bor - y.bor) / y.bor * 100 : null;
    }
    s1.push(rec);
    console.log(`  ${p.padEnd(10)} sup $${(x.sup / 1e6).toFixed(1)}M bor $${(x.bor / 1e6).toFixed(1)}M util ${(rec.jun30.utilization * 100).toFixed(1)}%  sAPY ${rec.jun30.wSupplyApy.toFixed(2)} bAPY ${rec.jun30.wBorrowApy.toFixed(2)} spread ${rec.jun30.effectiveSpread.toFixed(2)}  Δsup ${rec.supplyChangePct?.toFixed(1) ?? 'n/a'}% Δbor ${rec.borrowChangePct?.toFixed(1) ?? 'n/a'}%`);
  }
  out.section1_protocolMetrics = s1;

  // ── 2. Suilend + NAVI per-asset decomposition (top 10) ────────────
  console.log('\n═══ 2. Per-asset supply decomposition, Jun 1 vs Jun 30 ═══');
  const decomp = (proto: string) => {
    const m = new Map<string, { j1: number; j30: number }>();
    for (const r of c01) if (r.protocol === proto) { const a = m.get(r.symbol) ?? { j1: 0, j30: 0 }; a.j1 += r.sup; m.set(r.symbol, a); }
    for (const r of c30) if (r.protocol === proto) { const a = m.get(r.symbol) ?? { j1: 0, j30: 0 }; a.j30 += r.sup; m.set(r.symbol, a); }
    return [...m.entries()]
      .map(([symbol, v]) => ({ symbol, jun1SupUsd: v.j1, jun30SupUsd: v.j30, changeUsd: v.j30 - v.j1, changePct: v.j1 > 0 ? (v.j30 - v.j1) / v.j1 * 100 : null }))
      .sort((a, b) => Math.max(b.jun1SupUsd, b.jun30SupUsd) - Math.max(a.jun1SupUsd, a.jun30SupUsd))
      .slice(0, 10);
  };
  const s2 = { suilend: decomp('suilend'), navi: decomp('navi') };
  for (const proto of ['suilend', 'navi'] as const) {
    console.log(`  ${proto}:`);
    for (const a of s2[proto]) console.log(`    ${a.symbol.padEnd(14)} $${(a.jun1SupUsd / 1e6).toFixed(2)}M → $${(a.jun30SupUsd / 1e6).toFixed(2)}M  (${a.changePct == null ? 'new' : (a.changePct >= 0 ? '+' : '') + a.changePct.toFixed(1) + '%'})`);
  }
  out.section2_assetDecomp = s2;

  // ── 3. Asset-level concentration across all 5 protocols (Jun 30) ──
  console.log('\n═══ 3. Asset-level concentration (Jun 30, all protocols) ═══');
  const supByAsset = new Map<string, number>(), borByAsset = new Map<string, number>();
  for (const r of c30) {
    const sAsset = normSym(r.symbol);                                   // supply keeps the collateral symbol
    const bAsset = r.protocol === 'bucket' ? 'USDB' : normSym(r.symbol); // Bucket borrow is all USDB issuance
    supByAsset.set(sAsset, (supByAsset.get(sAsset) ?? 0) + r.sup);
    borByAsset.set(bAsset, (borByAsset.get(bAsset) ?? 0) + r.bor);
  }
  const supArr = [...supByAsset].map(([asset, usd]) => ({ asset, usd })).sort((a, b) => b.usd - a.usd);
  const borArr = [...borByAsset].map(([asset, usd]) => ({ asset, usd })).sort((a, b) => b.usd - a.usd);
  const totBor = borArr.reduce((s, x) => s + x.usd, 0);
  const usdcSuiShare = totBor > 0 ? ((borByAsset.get('USDC') ?? 0) + (borByAsset.get('SUI') ?? 0)) / totBor * 100 : 0;
  out.section3_assetConcentration = {
    supplyByAsset: supArr, supplyHHI: hhi(supArr.map((x) => x.usd)),
    borrowByAsset: borArr, borrowHHI: hhi(borArr.map((x) => x.usd)),
    usdcPlusSuiBorrowSharePct: usdcSuiShare,
    note: 'Supply keyed by (normalized) collateral symbol; Bucket vault names are kept as-is. Borrow: Bucket attributed to USDB.',
  };
  console.log(`  Supply HHI ${hhi(supArr.map((x) => x.usd)).toFixed(0)} · top supply: ${supArr.slice(0, 3).map((x) => `${x.asset} $${(x.usd / 1e6).toFixed(0)}M`).join(', ')}`);
  console.log(`  Borrow HHI ${hhi(borArr.map((x) => x.usd)).toFixed(0)} · top borrow: ${borArr.slice(0, 3).map((x) => `${x.asset} $${(x.usd / 1e6).toFixed(0)}M`).join(', ')}`);
  console.log(`  USDC+SUI share of total borrowing: ${usdcSuiShare.toFixed(1)}%`);

  // ── 4. HHI three ways (Jun 30, protocol-level) ────────────────────
  console.log('\n═══ 4. Protocol HHI three ways (Jun 30) ═══');
  const per = [...a30.entries()].map(([protocol, a]) => ({ protocol, netTvl: a.sup - a.bor, supplied: a.sup, borrowed: a.bor }));
  out.section4_hhiThreeWays = {
    tvlNetHHI: hhi(per.map((p) => p.netTvl)),
    suppliedHHI: hhi(per.map((p) => p.supplied)),
    borrowedHHI: hhi(per.map((p) => p.borrowed)),
    perProtocol: per,
  };
  console.log(`  HHI(net TVL) ${hhi(per.map((p) => p.netTvl)).toFixed(0)} · HHI(supplied) ${hhi(per.map((p) => p.supplied)).toFixed(0)} · HHI(borrowed) ${hhi(per.map((p) => p.borrowed)).toFixed(0)}`);

  // ── 5. NAVI idle collateral (>$5M supplied, <5% utilization) ──────
  console.log('\n═══ 5. NAVI idle collateral (>$5M supplied, <5% util) ═══');
  const idle = c30.filter((r) => r.protocol === 'navi' && r.sup > 5e6 && (r.sup > 0 ? r.bor / r.sup : 0) < 0.05)
    .map((r) => ({ symbol: r.symbol, suppliedUsd: r.sup, borrowedUsd: r.bor, utilizationPct: r.sup > 0 ? r.bor / r.sup * 100 : 0 }))
    .sort((a, b) => b.suppliedUsd - a.suppliedUsd);
  for (const m of idle) console.log(`  ${m.symbol.padEnd(12)} $${(m.suppliedUsd / 1e6).toFixed(2)}M supplied · ${m.utilizationPct.toFixed(2)}% util`);
  if (!idle.length) console.log('  none');
  out.section5_naviIdle = idle;

  // ── 6. Liquidator Gini per protocol (June, $1 OR filter) ──────────
  console.log('\n═══ 6. Liquidator Gini (June, $1 OR filter) ═══');
  const liqRows = (await db.$queryRawUnsafe(`
    SELECT protocol, liquidator, COUNT(*)::int AS n
    FROM "LiquidationEvent"
    WHERE timestamp >= '${JUNE_LO}' AND timestamp < '${JUNE_HI}'
      AND ("debtUsd" >= 1 OR "collateralUsd" >= 1)
    GROUP BY protocol, liquidator
  `)) as { protocol: string; liquidator: string; n: number }[];
  const byProto = new Map<string, number[]>();
  for (const r of liqRows) { const a = byProto.get(r.protocol) ?? []; a.push(r.n); byProto.set(r.protocol, a); }
  const s6: any[] = [];
  for (const p of PROTOCOLS) {
    const counts = byProto.get(p); if (!counts || !counts.length) continue;
    const rec = { protocol: p, liquidators: counts.length, events: counts.reduce((s, v) => s + v, 0), gini: gini(counts) };
    s6.push(rec);
    console.log(`  ${p.padEnd(10)} Gini ${rec.gini.toFixed(2)}  (${rec.liquidators} liquidators, ${rec.events} events)`);
  }
  out.section6_liquidatorGini = s6;

  // ── 7. Bucket collateral vs issued USDB + backing ratio (Jun 30) ──
  console.log('\n═══ 7. Bucket backing (Jun 30) ═══');
  const bkt = c30.filter((r) => r.protocol === 'bucket');
  const collateral = bkt.reduce((s, r) => s + r.sup, 0);
  const usdb = bkt.reduce((s, r) => s + r.bor, 0);
  out.section7_bucketBacking = { collateralUsd: collateral, issuedUsdb: usdb, backingRatioPct: usdb > 0 ? collateral / usdb * 100 : null };
  console.log(`  Collateral $${(collateral / 1e6).toFixed(2)}M · issued USDB $${(usdb / 1e6).toFixed(2)}M · backing ${usdb > 0 ? (collateral / usdb * 100).toFixed(0) + '%' : 'n/a'}  (May: 408%)`);

  // ── Append to docs/june-issue02-data.json ─────────────────────────
  const outPath = path.join(process.cwd(), 'docs', 'june-issue02-data.json');
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const merged = { ...existing, generatedAt: new Date().toISOString(), window: { start: '2026-06-01', end: '2026-06-30' }, ...out };
  fs.writeFileSync(outPath, JSON.stringify(merged, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  console.log(`\n✓ Wrote ${outPath}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
