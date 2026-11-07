/**
 * Backfill `gasUsedMist` + `gasUsd` for every existing LiquidationEvent.
 *
 * For each row where `gasUsedMist IS NULL`, calls Sui RPC's
 * `sui_getTransactionBlock(digest, {showEffects:true})` to read the
 * `gasCostSummary`. Net gas = computationCost + storageCost − storageRebate
 * (in MIST; 1 SUI = 1e9 MIST). Multiplies by the SUI price closest in time
 * to the event (from PoolSnapshot), or falls back to current SUI price.
 *
 * Resumable: only touches rows with NULL gasUsedMist. Safe to re-run.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-liquidation-gas.ts
 */

const RPC_URL = process.env.ALCHEMY_SUI_RPC ?? 'https://fullnode.mainnet.sui.io:443';
const NAVI_POOLS_API = 'https://open-api.naviprotocol.io/api/navi/pools';
const PAGE_SIZE = 50;
const MIST_PER_SUI = 1_000_000_000n;
const RPC_DELAY_MS = 200; // ~5 req/s

let reqId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  reqId++;
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

interface TxBlock {
  effects?: {
    gasUsed?: {
      computationCost: string;
      storageCost: string;
      storageRebate: string;
      nonRefundableStorageFee?: string;
    };
  };
}

async function getGasMist(digest: string): Promise<bigint | null> {
  try {
    const tx = await rpc<TxBlock>('sui_getTransactionBlock', [digest, { showEffects: true }]);
    const g = tx.effects?.gasUsed;
    if (!g) return null;
    const computation = BigInt(g.computationCost ?? '0');
    const storage = BigInt(g.storageCost ?? '0');
    const rebate = BigInt(g.storageRebate ?? '0');
    return computation + storage - rebate;
  } catch (err) {
    console.warn(`  [skip] ${digest.slice(0, 12)}…: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function getCurrentSuiPrice(): Promise<number> {
  try {
    const res = await fetch(NAVI_POOLS_API);
    const json = await res.json();
    const sui = json.data.find((p: { token: { symbol: string } }) => p.token.symbol === 'SUI');
    return Number(sui?.token?.price ?? 0) || 0;
  } catch {
    return 0;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const { getDb } = await import('../src/lib/db');
  const db = getDb();
  if (!db) throw new Error('DATABASE_URL is not set');

  const total = await db.liquidationEvent.count({
    where: { protocol: 'navi', gasUsedMist: null },
  });
  console.log(`Backfilling gas for ${total} liquidation events`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Throughput: ~${1000 / RPC_DELAY_MS} req/s → ~${Math.round(total * RPC_DELAY_MS / 1000 / 60)} min`);

  // Build a SUI price → timestamp lookup from PoolSnapshot. Falls back to
  // current price for events older than the earliest snapshot.
  const fallbackPrice = await getCurrentSuiPrice();
  const suiSnapshots = await db.poolSnapshot.findMany({
    where: { protocol: 'navi', symbol: 'SUI' },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, price: true },
  });
  console.log(`Loaded ${suiSnapshots.length} SUI price points; fallback price $${fallbackPrice.toFixed(4)}`);

  function priceAt(when: Date): number {
    if (suiSnapshots.length === 0) return fallbackPrice;
    // Binary search for the snapshot closest in time.
    let lo = 0, hi = suiSnapshots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (suiSnapshots[mid].timestamp.getTime() < when.getTime()) lo = mid + 1;
      else hi = mid;
    }
    const exact = suiSnapshots[lo];
    const before = lo > 0 ? suiSnapshots[lo - 1] : exact;
    // Pick whichever is temporally closer.
    return Math.abs(exact.timestamp.getTime() - when.getTime()) <
           Math.abs(before.timestamp.getTime() - when.getTime())
      ? exact.price
      : before.price;
  }

  let processed = 0;
  let updated = 0;
  let nullCount = 0;

  while (true) {
    const batch = await db.liquidationEvent.findMany({
      where: { protocol: 'navi', gasUsedMist: null },
      orderBy: { timestamp: 'asc' },
      take: PAGE_SIZE,
      select: { id: true, txDigest: true, timestamp: true },
    });
    if (batch.length === 0) break;

    for (const evt of batch) {
      const gasMist = await getGasMist(evt.txDigest);
      processed++;

      if (gasMist === null) {
        nullCount++;
      } else {
        const sui = priceAt(evt.timestamp);
        const gasUsd = sui > 0 ? Number(gasMist) / Number(MIST_PER_SUI) * sui : 0;
        await db.liquidationEvent.update({
          where: { id: evt.id },
          data: { gasUsedMist: gasMist, gasUsd },
        });
        updated++;
      }

      if (processed % 100 === 0) {
        console.log(`  ${processed}/${total} processed (${updated} updated, ${nullCount} skipped)`);
      }
      await new Promise((r) => setTimeout(r, RPC_DELAY_MS));
    }
  }

  console.log(`\nDone. ${updated} rows updated, ${nullCount} skipped (RPC failures).`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
