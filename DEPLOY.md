# Deploy — sui-lending-dashboard (static frontend)

This is a static HTML+JSX dashboard that fetches its data from
**navi-dashboard's `/api/sui-lending` endpoint**. It needs:

1. The navi-dashboard backend deployed (see that repo's `DEPLOY.md`)
2. A separate Vercel static deployment for these HTML files

## One-time setup

### 1. Initialize git (if not already)

```sh
cd "<this folder>"
git init
git add -A
git commit -m "Initial scaffold of sui-lending-dashboard"
```

### 2. Point `data.js` at the live API

Edit `data.js`, change the `DEFAULT_API` line:

```js
const DEFAULT_API =
  (typeof window !== 'undefined' && window.SUI_LENDING_API_URL) ||
  'https://<your-navi-dashboard-deploy>.vercel.app/api/sui-lending'; // ← change me
```

(Optional) Override per-environment by inlining a `<script>` tag BEFORE
`data.js` in each HTML page:

```html
<script>window.SUI_LENDING_API_URL = "https://navi-dashboard-staging.vercel.app/api/sui-lending";</script>
<script src="data.js"></script>
```

### 3. Deploy on Vercel

```sh
# Connect Vercel (one-time)
vercel link

# Deploy
vercel deploy --prod
```

There's no build step — Vercel just serves the HTML/JS/CSS as-is.

## Post-deploy verification

Open `https://<your-static-deploy>.vercel.app/Overview.html`. You should see:

- Boot splash for ~3s while data fetches
- KPI strip with real numbers (TVL, Supply, Borrow, Liquidations)
- TVL by Protocol chart populated with 90 days of data
- Daily Flows chart with stacked supply/borrow/liquid bars
- All 5 protocols visible in dropdowns

If the boot splash sticks at "data fetch failed: …", check the browser
console — most likely a CORS issue or wrong API URL. Verify with:

```sh
curl -i -X OPTIONS \
  -H "Origin: https://<static-deploy>.vercel.app" \
  https://<navi-dashboard>.vercel.app/api/sui-lending
```

Should return `HTTP 204` with `Access-Control-Allow-Origin: *`.

## Architecture

```
┌──────────────────────────────────┐    1.4MB JSON         ┌──────────────────────────┐
│ sui-lending-dashboard (static)   │────────────────────→  │ navi-dashboard (Next.js) │
│  · Overview.html                 │   /api/sui-lending    │  · /api/sui-lending      │
│  · Protocol.html                 │       (CORS *)        │  · /api/<proto>/cron/*   │
│  · Rates.html                    │                       │                          │
│  · Revenue.html                  │                       │  postgres (Neon)         │
│  · Collateral.html               │                       │   · PoolSnapshot         │
│  · Liquidation.html              │                       │   · PoolDaily            │
│  · MarketDetail.html             │                       │   · LiquidationEvent     │
│                                  │                       │   · RateModelParams      │
│  data.js → fetch ──┐             │                       │   · CollateralBorrowPair │
│                    │             │                       │   · WalletPosition       │
└────────────────────┼─────────────┘                       └──────────────────────────┘
                     │
                     v
              window.SUI_LENDING_DATA
              window.DATA_READY (Promise)
```

## What changed since the mock-data scaffold

- `data.js` now fetches from a live endpoint (was: seeded mock generator)
- Each HTML page wraps `ReactDOM.render(...)` in `window.DATA_READY.then(...)`
- `pages.jsx` accesses data via `Proxy` so `D.protocols.map(...)` works
  whether the underlying data was sync (mock) or arrived async (fetch)

To revert to mock data for offline development, restore the original
`data.js` from git history (or copy from
`Datum Labs Dashboard SDK/data.js` and adapt).

## Sui access after the JSON-RPC shutdown (September 2026)

Sui JSON-RPC is gone: the Foundation disabled it on public fullnodes in late July 2026 and
Alchemy retires it on 25 September 2026. Every on-chain read now goes through gRPC-Web via
`src/lib/sui-client.ts`. Set these on the Vercel project (Production + Preview):

| Variable | Value |
|---|---|
| `SUI_GRPC_URL` | `https://sui-mainnet.g.alchemy.com` (Alchemy) or `https://sui-mainnet-grpc.blockvision.org` (BlockVision) |
| `SUI_GRPC_BEARER` | Alchemy API key (sent as `Authorization: Bearer`) |
| `SUI_GRPC_API_KEY` | BlockVision key (sent as `x-api-key`), if using BlockVision |

With none set the app falls back to the public fullnode (`fullnode.mainnet.sui.io`), which is
rate limited, keeps only a few weeks of history and is meant for development. The primary
provider is also backed by the public node on failure (`withSuiClient`).

`ALCHEMY_SUI_RPC` and `BLOCKVISION_SUI_RPC` (JSON-RPC) are no longer read by the app.
`/api/cron-status` reports which provider is configured.

Prices for Suilend reserves no longer come from Pyth Hermes (which began returning 401 in late
August 2026 and emptied the Suilend pools); they come from coins.llama.fi through an injected
price source in `src/protocols/suilend/adapter.ts`.

## Data source switch (platform migration)

`DATA_SOURCE=platform` makes `/api/sui-lending` read the Datum data platform's curated tables
(`sui.fct_sui_pool_daily`, `sui.fct_sui_liquidations`, `sui.fct_sui_protocol_tvl_daily`, the snapshot staging view)
through `PLATFORM_READ_URL` (the read-only `datum_reader` role). Unset, or `legacy`, keeps this app's own database.
Rate-model parameters and wallet positions still come from the legacy database when it is configured.

The Datum Labs copy (`sui-lending-datum`) runs on `platform`; the personal copy stays on `legacy` until the
shadow period is over. `scripts/shadow-compare.mjs` (daily via the shadow-compare workflow) compares the two.
Flip back: set `DATA_SOURCE=legacy` and redeploy.
