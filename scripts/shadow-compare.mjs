// Shadow comparison: the same /api/sui-lending payload from the legacy copy and the platform
// copy, side by side. Prints a markdown table (also to the GitHub job summary) and writes
// shadow-compare.json. Never fails the job: the divergence log in datum-context is where a
// difference gets a cause and a status.
//
//   LEGACY_URL=https://sui-lending.vercel.app PLATFORM_URL=https://sui-lending-datum.vercel.app node scripts/shadow-compare.mjs
import { writeFileSync, appendFileSync } from 'node:fs';

const L = (process.env.LEGACY_URL || 'https://sui-lending.vercel.app').replace(/\/$/, '');
const P = (process.env.PLATFORM_URL || 'https://sui-lending-datum.vercel.app').replace(/\/$/, '');
const TOL = Number(process.env.TOLERANCE_PCT || 2);

async function get(base) {
  const r = await fetch(`${base}/api/sui-lending`, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`${base} -> HTTP ${r.status}`);
  return r.json();
}
const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : a ? Infinity : 0);
const fmt = (v, unit = '') => v == null ? '—' : unit === '$M' ? `$${Number(v).toFixed(2)}M` : unit === '%' ? `${Number(v).toFixed(2)}%` : String(v);

const [legacy, platform] = await Promise.all([get(L), get(P)]);
const rows = [];
const add = (metric, a, b, unit) => { const d = pct(a ?? 0, b ?? 0); rows.push({ metric, platform: a, legacy: b, unit, diffPct: Number.isFinite(d) ? +d.toFixed(2) : d, flag: Math.abs(d) > TOL ? '⚠' : '' }); };

for (const pm of platform.protocolMetrics ?? []) {
  const lm = (legacy.protocolMetrics ?? []).find((x) => x.id === pm.id) ?? {};
  add(`${pm.id} tvl`, pm.tvl, lm.tvl, '$M');
  add(`${pm.id} supply`, pm.supply, lm.supply, '$M');
  add(`${pm.id} borrow`, pm.borrow, lm.borrow, '$M');
}
add('pools (count)', platform.pools?.length, legacy.pools?.length);
add('vaults (count)', platform.vaults?.length, legacy.vaults?.length);
add('liquidations 30d (count)', platform.liq30dCount, legacy.liq30dCount);
add('liquidation rows returned', platform.liquidations?.length, legacy.liquidations?.length);
for (const ps of platform.tvlSeries ?? []) {
  const proto = ps[ps.length - 1]?.protocol; const ls = (legacy.tvlSeries ?? []).find((x) => x[x.length - 1]?.protocol === proto) ?? [];
  const lastP = ps[ps.length - 1]?.value, lastL = ls[ls.length - 1]?.value;
  add(`${proto} tvlSeries last day`, lastP, lastL, '$M');
  const nzP = ps.filter((d) => d.value > 0).length, nzL = ls.filter((d) => d.value > 0).length;
  add(`${proto} tvlSeries days with data`, nzP, nzL);
}
for (const sym of ['USDC', 'SUI', 'USDT']) {
  const pp = (platform.pools ?? []).find((x) => x.protocol === 'navi' && x.symbol === sym), lp = (legacy.pools ?? []).find((x) => x.protocol === 'navi' && x.symbol === sym);
  if (pp || lp) { add(`navi ${sym} supplyApy`, pp?.supplyApy, lp?.supplyApy, '%'); add(`navi ${sym} utilization`, pp?.utilization, lp?.utilization, '%'); add(`navi ${sym} ltv`, pp?.ltv, lp?.ltv, '%'); }
}

const flagged = rows.filter((r) => r.flag).length;
const md = [
  `## Sui shadow comparison · ${new Date().toISOString().slice(0, 16)} UTC`,
  `platform: ${P} (dataSource=${platform.dataSource ?? '?'}, dataAsOf ${platform.dataAsOf ?? '?'}) · legacy: ${L} (dataSource=${legacy.dataSource ?? '?'}, dataAsOf ${legacy.dataAsOf ?? '?'})`,
  `${rows.length} checks, ${flagged} beyond ±${TOL}%`, '',
  '| metric | platform | legacy | diff |', '|---|---:|---:|---:|',
  ...rows.map((r) => `| ${r.metric} | ${fmt(r.platform, r.unit)} | ${fmt(r.legacy, r.unit)} | ${r.flag} ${Number.isFinite(r.diffPct) ? r.diffPct + '%' : 'n/a'} |`),
].join('\n');
console.log(md);
writeFileSync('shadow-compare.json', JSON.stringify({ at: new Date().toISOString(), legacy: L, platform: P, tolerancePct: TOL, flagged, rows }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
