# Sui Lending Dashboard

State of Lending across the Sui ecosystem. Built on the **Datum Labs Dashboard SDK**
pattern: vanilla HTML + React via CDN, no build step, one HTML file per page.

## Pages

| Page | File | What it shows |
|---|---|---|
| Overview | `Overview.html` | Cross-protocol TVL, supply, borrow, daily flows |
| Protocol | `Protocol.html` | Per-protocol drilldown (NAVI / Suilend / Scallop / AlphaLend / Bucket) |
| Rates | `Rates.html` | Supply/borrow APY, utilization, kink — pool + CDP variants |
| Revenue | `Revenue.html` | Derived protocol fees, run-rate, fee mix |
| Collateral | `Collateral.html` | Asset composition + cross-protocol concentration |
| Liquidation | `Liquidation.html` | 30D event series + recent-events table |

`index.html` redirects to Overview.

## Run

It's static HTML — no install, no build.

```sh
# any local server works
python3 -m http.server 8000
# then open http://localhost:8000/Overview.html
```

Or just open `Overview.html` directly in a browser.

## File layout

| File | Purpose |
|---|---|
| `styles.css` | Design tokens + component CSS (copied from SDK) |
| `charts.jsx` | `AreaChart`, `StackedBarChart`, `Treemap`, `Sparkline`, … (copied) |
| `widgets.jsx` | `Dropdown`, `ChartToolbar`, `ExpandModal`, helpers (copied) |
| `shell.jsx` | Topbar / Sidebar / StatusBar / Ticker — Sui Lending nav |
| `pages.jsx` | Six `Page<Name>` components — one per HTML file |
| `data.js` | Mock `window.SUI_LENDING_DATA`, matches `SCHEMA.js` shape |
| `SCHEMA.js` | Documented data shapes (extends Aether SDK schema) |
| `Overview.html` … `Liquidation.html` | Page entry points |
| `index.html` | Redirect → `Overview.html` |
| `assets/` | Icons (copied from SDK) |

## Data flow

```
backend worker ── poll SDKs ──→ Postgres ──→ /api/* ──→ data.js fetches ──→ window.SUI_LENDING_DATA
                                                          (currently: mocked)
```

Today `data.js` is a self-contained mock seeded for stable values matching real
April 2026 Sui TVLs (NAVI ≈ $350M, AlphaLend ≈ $69M, Bucket ≈ $61M, Suilend ≈ $52M,
Scallop ≈ $9.5M).

## Swapping mock for live data

`data.js` exposes a single global: `window.SUI_LENDING_DATA`. To go live, replace
that with a `fetch()` against your backend. The shape is locked in `SCHEMA.js`.

```js
// data.js — production version
window.SUI_LENDING_DATA_PROMISE = fetch('/api/sui-lending').then(r => r.json());
// pages.jsx will need to await this before rendering
```

## Source-of-truth map (for the backend)

| Field | Source |
|---|---|
| `pools[].supply / borrow / supplyApy / borrowApy / util` | Per-protocol SDK live calls |
| `vaults[].collateralUsd / debtUsd / interestRate` | `@bucket-protocol/sdk` |
| `tvlSeries`, `tvlMetricSeries`, `volumeSeries` | Snapshot DB (poll-and-store every 10 min) |
| `liquidations`, `liquidationSeries` | BlockVision Sui DeFi API + Scallop indexer |
| `protocolMetrics.fees` | Derived: `reserve_factor × borrow_interest × dt` |
| Token prices, USD denomination | Pyth on Sui |

## Schema delta vs. SDK

The Aether SDK schema covers most needs. Two additions baked in:

1. **`protocol`** dimension on every pool / market / event (so the dashboard can
   filter and stack across protocols).
2. **`liquidations`** and **`liquidationSeries`** — richer than the SDK's generic
   `events`, with debt/collateral asset, USD repaid/seized, liquidator bonus,
   borrower address, tx digest, and HF at the moment of liquidation.

CDP-archetype protocols (Bucket) use a separate `vaults[]` shape — supply/borrow
APY don't apply cleanly. Rates page renders a CDP variant for those rows.

## Theming

Same controls as the SDK — three body attributes:

```html
<body data-theme="light" data-aesthetic="evolved" data-density="cozy">
```

Persisted in `localStorage`. Tweaks panel from the SDK is wired but hidden by
default; toggle by adding the TweaksPanel component to `PageShell` in
`pages.jsx` if you want host-edit support.

## Deploy (Cloudflare Workers)

The app and the static dashboard in `public/` run as one Cloudflare Worker (`suilending`), built with
[vinext](https://github.com/cloudflare/vinext). Live: https://suilending.datumlabs.workers.dev

- `npm run dev` (Vite, port 3000), `npm run build`, `npm start` (built Worker in workerd), `npm run deploy`
- `npm run dev:next` / `npm run build:next` still run plain Next.js
- Plain settings live in `cloudflare.config.ts`; set secrets with `./scripts/set-secrets.sh`
- Daily crons are called by `datum-scheduler`. See `DEPLOY.md`.
