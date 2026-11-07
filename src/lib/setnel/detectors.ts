// State of SUI — Setnel detectors.
//
// Covers all Sui lending protocols the dashboard tracks (Navi, Suilend,
// Scallop, AlphaLend, Bucket) from its aggregate API. Run on a cron
// (app/api/setnel/cron) and posted to the Setnel Hub.

import { defineDetector } from './runtime';

// Base URL to call this dashboard's own API routes from the cron runtime.
// SETNEL_SELF_URL wins; otherwise the cron route passes in the origin it was
// called on (the Worker's own URL on Cloudflare).
let requestOrigin: string | undefined;
export function setSelfUrl(origin: string): void {
  requestOrigin = origin;
}
function baseUrl(): string {
  if (process.env.SETNEL_SELF_URL) return process.env.SETNEL_SELF_URL;
  if (requestOrigin) return requestOrigin;
  return 'http://localhost:3000';
}

type Pool = { sym: string; name: string; protocol: string; supply: number; borrow: number; util: number; risk: string };
type TvlPoint = { day: number; value: number; protocol: string };
type SuiAgg = {
  protocols: { id: string; name: string }[];
  pools: Pool[];
  tvlSeries: TvlPoint[][] | TvlPoint[];
};

type DataHealthCheck = { source: string; status: string; latest?: string; ageHours?: number; detail?: string };
type DataHealth = { status: string; summary: string; checks: DataHealthCheck[] };

function hhi(values: number[]): number {
  const total = values.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (total <= 0) return 0;
  return values.reduce((acc, v) => (v > 0 ? acc + Math.pow((v / total) * 100, 2) : acc), 0);
}

function fmtM(n: number): string {
  // tvlSeries + pool values are already in $M.
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}B`;
  return `$${n.toFixed(1)}M`;
}

// Group tvlSeries (array-of-arrays OR flat) into a per-protocol daily series.
function tvlByProtocol(agg: SuiAgg): Map<string, number[]> {
  const flat: TvlPoint[] = Array.isArray(agg.tvlSeries[0])
    ? (agg.tvlSeries as TvlPoint[][]).flat()
    : (agg.tvlSeries as TvlPoint[]);
  const byProto = new Map<string, TvlPoint[]>();
  for (const p of flat) {
    if (!byProto.has(p.protocol)) byProto.set(p.protocol, []);
    byProto.get(p.protocol)!.push(p);
  }
  const out = new Map<string, number[]>();
  for (const [proto, pts] of byProto) {
    pts.sort((a, b) => a.day - b.day);
    out.set(proto, pts.map((x) => x.value));
  }
  return out;
}

function protoName(agg: SuiAgg, id: string): string {
  return agg.protocols.find((p) => p.id === id)?.name ?? id;
}

// 1) Data-source health — surface the dashboard's own freshness checks. Broken
//    sources page (critical); stale sources warn. One incident per source so
//    each clears independently when it recovers.
defineDetector<DataHealth>({
  id: 'sui.data-sources',
  label: 'Data source broken or stale',
  category: 'technical',
  severity: 'critical',
  source: async () => {
    const r = await fetch(`${baseUrl()}/api/data-health`, { cache: 'no-store' });
    return r.json();
  },
  detect: (d) => {
    const events = [];
    for (const c of d.checks ?? []) {
      if (c.status === 'broken') {
        events.push({
          message: `Data source broken: ${c.source} (last ${c.latest ?? 'n/a'}, ${Math.round(c.ageHours ?? 0)}h old)`,
          fingerprint: `sui.data-source:${c.source}`,
          linkPath: '/',
          payload: { source: c.source, status: c.status, ageHours: c.ageHours },
        });
      }
    }
    return events;
  },
});

// 1b) Stale sources — warning tier, same per-source model.
defineDetector<DataHealth>({
  id: 'sui.data-sources-stale',
  label: 'Data source stale',
  category: 'technical',
  severity: 'warning',
  source: async () => {
    const r = await fetch(`${baseUrl()}/api/data-health`, { cache: 'no-store' });
    return r.json();
  },
  detect: (d) => {
    const events = [];
    for (const c of d.checks ?? []) {
      if (c.status === 'stale') {
        events.push({
          message: `Data source stale: ${c.source} (last ${c.latest ?? 'n/a'}, ${Math.round(c.ageHours ?? 0)}h old)`,
          fingerprint: `sui.data-source-stale:${c.source}`,
          linkPath: '/',
          payload: { source: c.source, status: c.status, ageHours: c.ageHours },
        });
      }
    }
    return events;
  },
});

// 2) Per-protocol TVL drop — 24h drop >10% (critical) per Sui lending protocol.
//    Also the sampler for per-protocol TVL + concentration (emitted every run).
defineDetector<SuiAgg>({
  id: 'sui.protocol-tvl-drop-24h',
  label: 'A protocol TVL dropped more than 10% in 24h',
  category: 'flows',
  severity: 'critical',
  source: async () => {
    const r = await fetch(`${baseUrl()}/api/sui-lending`, { cache: 'no-store' });
    return r.json();
  },
  sample: (agg) => {
    const out: Record<string, number> = {};
    const latest: number[] = [];
    for (const [proto, series] of tvlByProtocol(agg)) {
      if (series.length) {
        const v = series[series.length - 1];
        out[`sui.${proto}.tvl`] = v; // $M
        latest.push(v);
      }
    }
    if (latest.length >= 2) out['sui.tvl_hhi'] = hhi(latest);
    out['sui.tvl_total'] = latest.reduce((a, b) => a + b, 0);
    return out;
  },
  detect: (agg) => {
    const events = [];
    for (const [proto, series] of tvlByProtocol(agg)) {
      if (series.length < 2) continue;
      const latest = series[series.length - 1];
      const prior = series[series.length - 2];
      if (!latest || !prior) continue;
      const pct = ((latest - prior) / prior) * 100;
      if (pct <= -10) {
        events.push({
          message: `${protoName(agg, proto)} TVL dropped ${pct.toFixed(1)}% in 24h (${fmtM(prior)} → ${fmtM(latest)})`,
          fingerprint: `sui.protocol-tvl-drop-24h:${proto}`,
          linkPath: '/',
          payload: { protocol: proto, pct, from: prior, to: latest },
        });
      }
    }
    return events;
  },
});

// 3) Per-protocol TVL bleed — 7d drop >25%.
defineDetector<SuiAgg>({
  id: 'sui.protocol-tvl-drop-7d',
  label: 'A protocol TVL dropped more than 25% in 7 days',
  category: 'flows',
  severity: 'warning',
  source: async () => {
    const r = await fetch(`${baseUrl()}/api/sui-lending`, { cache: 'no-store' });
    return r.json();
  },
  detect: (agg) => {
    const events = [];
    for (const [proto, series] of tvlByProtocol(agg)) {
      if (series.length < 8) continue;
      const latest = series[series.length - 1];
      const prior = series[series.length - 8];
      if (!latest || !prior) continue;
      const pct = ((latest - prior) / prior) * 100;
      if (pct <= -25) {
        events.push({
          message: `${protoName(agg, proto)} TVL down ${pct.toFixed(1)}% over 7 days (${fmtM(prior)} → ${fmtM(latest)})`,
          fingerprint: `sui.protocol-tvl-drop-7d:${proto}`,
          linkPath: '/',
          payload: { protocol: proto, pct, from: prior, to: latest },
        });
      }
    }
    return events;
  },
});

// 4) TVL concentration (HHI) across Sui lending protocols.
defineDetector<SuiAgg>({
  id: 'sui.tvl-concentration',
  label: 'Sui lending TVL concentration (HHI) above 3000',
  category: 'risk-parameters',
  severity: 'warning',
  source: async () => {
    const r = await fetch(`${baseUrl()}/api/sui-lending`, { cache: 'no-store' });
    return r.json();
  },
  detect: (agg) => {
    const latest: number[] = [];
    for (const [, series] of tvlByProtocol(agg)) {
      if (series.length) latest.push(series[series.length - 1]);
    }
    if (latest.length < 2) return [];
    const index = hhi(latest);
    if (index > 3000) {
      const tier = index > 5000 ? 'highly concentrated' : 'concentrated';
      return [
        {
          message: `Sui lending TVL HHI is ${index.toFixed(0)} (${tier}) across ${latest.length} protocols`,
          fingerprint: 'sui.tvl-concentration',
          linkPath: '/',
          payload: { hhi: index, protocols: latest.length },
        },
      ];
    }
    return [];
  },
});

// 5) High-risk pools — pools the dashboard's own risk model flags as 'high'.
defineDetector<SuiAgg>({
  id: 'sui.high-risk-pools',
  label: 'Pool flagged high risk',
  category: 'liquidity',
  severity: 'warning',
  source: async () => {
    const r = await fetch(`${baseUrl()}/api/sui-lending`, { cache: 'no-store' });
    return r.json();
  },
  detect: (agg) => {
    return (agg.pools ?? [])
      .filter((p) => p.risk === 'high' && p.supply > 1) // supply in $M; ignore dust
      .map((p) => ({
        message: `${protoName(agg, p.protocol)} ${p.sym} flagged high risk · util ${p.util.toFixed(1)} · supply ${fmtM(p.supply)}`,
        fingerprint: `sui.high-risk-pool:${p.protocol}:${p.sym}`,
        linkPath: '/',
        payload: { protocol: p.protocol, sym: p.sym, util: p.util, supply: p.supply, exposureUsd: p.supply * 1e6 },
      }));
  },
});
