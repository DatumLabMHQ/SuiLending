import BigNumber from 'bignumber.js';
import { parseLiquidationEvent } from '../src/protocols/navi/events';

const RPC_URL = process.env.ALCHEMY_SUI_RPC ?? 'https://fullnode.mainnet.sui.io:443';
const NAVI_PACKAGE = '0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb';
const LIQUIDATION_TYPE = `${NAVI_PACKAGE}::event::LiquidationEvent`;
const NAVI_POOLS_API = 'https://open-api.naviprotocol.io/api/navi/pools';

interface PoolInfo { symbol: string; decimals: number; }

async function loadPoolRegistry(): Promise<Record<number, PoolInfo>> {
  const res = await fetch(NAVI_POOLS_API);
  const json = await res.json();
  const byId: Record<number, PoolInfo> = {};
  for (const p of json.data) {
    byId[p.id] = { symbol: p.token.symbol, decimals: p.token.decimals };
  }
  return byId;
}

let reqId = 0;
async function rpc(method: string, params: unknown[]) {
  reqId++;
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }),
  });
  return res.json();
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const { getDb } = await import('../src/lib/db');
  const db = getDb();
  if (!db) throw new Error('DATABASE_URL is not set');

  console.log('Loading NAVI pool registry...');
  const registry = await loadPoolRegistry();
  console.log(`  Loaded ${Object.keys(registry).length} pools`);

  let cursor: { txDigest: string; eventSeq: string } | null = null;
  let total = 0, skipped = 0, hasMore = true, page = 0;

  while (hasMore) {
    page++;
    const result = await rpc('suix_queryEvents', [{ MoveEventType: LIQUIDATION_TYPE }, cursor, 50, false]);
    const data = result.result;
    if (!data?.data?.length) break;

    const rows = [];
    for (const evt of data.data) {
      let p;
      try { p = parseLiquidationEvent(evt.parsedJson); }
      catch (err) { console.warn(`  skip ${evt.id.txDigest}:${evt.id.eventSeq}: ${err instanceof Error ? err.message : err}`); skipped++; continue; }

      const cPool = registry[p.collateral_asset];
      const dPool = registry[p.debt_asset];
      if (!cPool || !dPool) { skipped++; continue; }

      const cScale = new BigNumber(10).pow(cPool.decimals);
      const dScale = new BigNumber(10).pow(dPool.decimals);

      const collateralAmount = new BigNumber(p.collateral_amount).dividedBy(cScale).toNumber();
      const debtAmount       = new BigNumber(p.debt_amount).dividedBy(dScale).toNumber();
      const collateralPrice  = new BigNumber(p.collateral_price).dividedBy(cScale).toNumber();
      const debtPrice        = new BigNumber(p.debt_price).dividedBy(dScale).toNumber();
      const treasuryAmount   = new BigNumber(p.treasury).dividedBy(cScale).toNumber();

      rows.push({
        id: `${evt.id.txDigest}:${evt.id.eventSeq}`,
        protocol: 'navi',
        txDigest: evt.id.txDigest,
        timestamp: new Date(Number(evt.timestampMs)),
        liquidator: p.sender,
        borrower: p.user,
        collateralAsset: cPool.symbol,
        collateralAmount, collateralPrice,
        collateralUsd: collateralAmount * collateralPrice,
        debtAsset: dPool.symbol,
        debtAmount, debtPrice,
        debtUsd: debtAmount * debtPrice,
        treasuryAmount,
      });
    }

    if (rows.length > 0) {
      await db.liquidationEvent.createMany({ data: rows, skipDuplicates: true });
      total += rows.length;
    }

    cursor = data.nextCursor;
    hasMore = data.hasNextPage;
    console.log(`Page ${page}: ${rows.length} events (total: ${total})`);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nDone! ${total} indexed, ${skipped} skipped`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
