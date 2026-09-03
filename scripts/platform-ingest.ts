/**
 * Platform ingest: run every protocol adapter and write the results into the
 * datum platform's raw layer (schema `sui` in the Neon project `datum`).
 *
 * This is the bridge for Phase A of the migration. The live dashboard is not
 * touched: this script only reads from the same sources the adapters already
 * use and writes to a different database. It follows the ingest contract in
 * datum-models/ingest/README.md: open a run, read cursors, append rows with
 * provenance, advance cursors after commit, close the run.
 *
 *   PLATFORM_DATABASE_URL=postgresql://...  npx tsx scripts/platform-ingest.ts [--pools] [--liquidations] [--defillama]
 *
 * With no flags it runs all three. Exit code is non-zero if any job errored so
 * the workflow shows red, but a failure in one protocol never blocks the others.
 */
import { Pool } from 'pg';
import { getProtocol, listProtocolSlugs } from '../src/protocols/registry';
import type { NormalizedPool, NormalizedLiquidation } from '../src/protocols/types';

const RUNNER = process.env.GITHUB_ACTIONS ? 'github-actions' : 'local';
const url = process.env.PLATFORM_DATABASE_URL;
if (!url) { console.error('PLATFORM_DATABASE_URL is not set'); process.exit(2); }
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });

const SOURCE_BY_PROTOCOL: Record<string, string> = {
  navi: 'navi_api', suilend: 'suilend_sdk', scallop: 'scallop_indexer', alphalend: 'sui_graphql', bucket: 'bucket_sdk',
};
const DEFILLAMA_SLUG: Record<string, string> = {
  navi: 'navi-protocol', suilend: 'suilend', scallop: 'scallop-lend', alphalend: 'alphalend', bucket: 'bucket-protocol',
};

async function openRun(job: string, product: string, notes: Record<string, unknown> = {}): Promise<number> {
  const r = await pool.query(
    `insert into ops.sync_runs (job, product, runner, notes) values ($1, $2, $3, $4) returning run_id`,
    [job, product, RUNNER, JSON.stringify(notes)],
  );
  return Number(r.rows[0].run_id);
}
async function closeRun(runId: number, status: 'ok' | 'error' | 'skipped', rows: number, error?: string, notes: Record<string, unknown> = {}) {
  await pool.query(
    `update ops.sync_runs set finished_at = now(), status = $2, rows_written = $3, error = $4, notes = notes || $5::jsonb where run_id = $1`,
    [runId, status, rows, error ?? null, JSON.stringify(notes)],
  );
}
async function getCursor(job: string): Promise<string | null> {
  const r = await pool.query(`select cursor from ops.sync_cursors where job = $1`, [job]);
  return r.rows[0]?.cursor ?? null;
}
async function setCursor(job: string, cursor: string, notes: Record<string, unknown> = {}) {
  await pool.query(
    `insert into ops.sync_cursors (job, cursor, notes) values ($1, $2, $3)
     on conflict (job) do update set cursor = excluded.cursor, notes = excluded.notes, updated_at = now()`,
    [job, cursor, JSON.stringify(notes)],
  );
}
async function touchFreshness(product: string, sourceId: string, status: string, expectedHours: number) {
  await pool.query(
    `insert into ops.source_freshness (product, source_id, expected_hours, last_seen_at, last_status)
     values ($1, $2, $3, now(), $4)
     on conflict (product, source_id) do update set last_seen_at = now(), last_status = excluded.last_status, expected_hours = excluded.expected_hours, updated_at = now()`,
    [product, sourceId, expectedHours, status],
  );
}

// ─── Pools ──────────────────────────────────────────────────────────────────
async function ingestPools(): Promise<boolean> {
  let allOk = true;
  for (const slug of listProtocolSlugs()) {
    const entry: any = getProtocol(slug); const ad = entry?.adapter ?? entry;
    const job = `sui.collect_pools.${slug}`;
    const runId = await openRun(job, 'sui');
    try {
      const pools: NormalizedPool[] = await ad.fetchPools();
      const fetchedAt = new Date();
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const p of pools) {
          await client.query(
            `insert into sui.raw_pool_snapshots
               (run_id, source_id, fetched_at, protocol, symbol, coin_type, decimals,
                total_supply, total_supply_usd, total_borrows, total_borrows_usd,
                available_liquidity, available_liquidity_usd, supply_apy, borrow_apy,
                incentive_supply_apy, incentive_borrow_apy, utilization, ltv, liquidation_threshold,
                price_usd, irm, payload)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [runId, SOURCE_BY_PROTOCOL[slug] ?? slug, fetchedAt, slug, p.symbol, (p as any).coinType ?? null, (p as any).decimals ?? null,
             num(p.totalSupply), num(p.totalSupplyUsd), num(p.totalBorrows), num(p.totalBorrowsUsd),
             num((p as any).availableLiquidity), num((p as any).availableLiquidityUsd), num(p.supplyApy), num(p.borrowApy),
             num((p as any).boostedSupplyApy ?? (p as any).incentiveSupplyApy), num((p as any).boostedBorrowApy ?? (p as any).incentiveBorrowApy),
             num(p.utilization), pct(p.ltv), pct(p.liquidationThreshold), num((p as any).price), (p as any).irm ? JSON.stringify((p as any).irm) : null,
             JSON.stringify(p)],
          );
        }
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
      await closeRun(runId, pools.length ? 'ok' : 'error', pools.length, pools.length ? undefined : 'adapter returned no pools');
      await touchFreshness('sui', SOURCE_BY_PROTOCOL[slug] ?? slug, pools.length ? 'ok' : 'broken', 26);
      console.log(`[pools] ${slug}: ${pools.length} rows`);
      if (!pools.length) allOk = false;
    } catch (e: any) {
      await closeRun(runId, 'error', 0, String(e?.message ?? e));
      await touchFreshness('sui', SOURCE_BY_PROTOCOL[slug] ?? slug, 'broken', 26);
      console.error(`[pools] ${slug} FAILED: ${e?.message ?? e}`);
      allOk = false;
    }
  }
  return allOk;
}

// ─── Liquidations ───────────────────────────────────────────────────────────
async function ingestLiquidations(): Promise<boolean> {
  let allOk = true;
  for (const slug of listProtocolSlugs()) {
    const entry: any = getProtocol(slug); const ad = entry?.adapter ?? entry;
    if (!ad.fetchLiquidations) continue;
    const job = `sui.index_liquidations.${slug}`;
    const untilEventId = await getCursor(job);
    const runId = await openRun(job, 'sui', { untilEventId });
    try {
      // Newest first, stop at the last event we stored. First run takes up to 8 pages (400 events).
      const events: NormalizedLiquidation[] = await ad.fetchLiquidations({ untilEventId: untilEventId ?? undefined, maxPages: untilEventId ? 4 : 8 });
      const fetchedAt = new Date();
      let written = 0;
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const ev of events) {
          const r = await client.query(
            `insert into sui.raw_liquidation_events
               (event_id, run_id, source_id, fetched_at, protocol, tx_digest, ts, liquidator, borrower,
                collateral_asset, collateral_amount, collateral_price, collateral_usd,
                debt_asset, debt_amount, debt_price, debt_usd, treasury_amount, gas_used_mist, gas_usd, checkpoint, payload)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
             on conflict (event_id) do nothing`,
            [ev.id, runId, 'sui_grpc', fetchedAt, slug, ev.txDigest, ev.timestamp, ev.liquidator || null, ev.borrower || null,
             ev.collateralAsset, num(ev.collateralAmount), num(ev.collateralPrice), num(ev.collateralUsd),
             ev.debtAsset, num(ev.debtAmount), num(ev.debtPrice), num(ev.debtUsd), num(ev.treasuryAmount),
             (ev as any).gasUsedMist != null ? String((ev as any).gasUsedMist) : null, num((ev as any).gasUsd), null, JSON.stringify(ev)],
          );
          written += r.rowCount ?? 0;
        }
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
      if (events.length) await setCursor(job, events[0].id, { latestTs: events[0].timestamp });
      await closeRun(runId, 'ok', written, undefined, { fetched: events.length });
      await touchFreshness('sui', 'sui_grpc', 'ok', 26);
      console.log(`[liquidations] ${slug}: fetched ${events.length}, new ${written}`);
    } catch (e: any) {
      await closeRun(runId, 'error', 0, String(e?.message ?? e));
      console.error(`[liquidations] ${slug} FAILED: ${e?.message ?? e}`);
      allOk = false;
    }
  }
  return allOk;
}

// ─── DefiLlama TVL (reconciliation series) ──────────────────────────────────
async function ingestDefillama(): Promise<boolean> {
  let allOk = true;
  for (const [slug, llama] of Object.entries(DEFILLAMA_SLUG)) {
    const job = `sui.defillama_tvl.${slug}`;
    const runId = await openRun(job, 'sui', { llama });
    try {
      const res = await fetch(`https://api.llama.fi/protocol/${llama}`);
      if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
      const j: any = await res.json();
      const series: Array<{ date: number; totalLiquidityUSD: number }> = j?.chainTvls?.Sui?.tvl ?? j?.tvl ?? [];
      const fetchedAt = new Date();
      const cutoff = Math.floor(Date.now() / 1000) - 400 * 86400;
      // Drop the partial current day (last point) per datum-context/sources.yaml.
      const rows = series.filter((p) => p.date >= cutoff).slice(0, -1);
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const p of rows) {
          await client.query(
            `insert into sui.raw_defillama_tvl (protocol, slug, day, tvl_usd, fetched_at, run_id)
             values ($1, $2, to_timestamp($3)::date, $4, $5, $6)
             on conflict (protocol, day) do update set tvl_usd = excluded.tvl_usd, fetched_at = excluded.fetched_at, run_id = excluded.run_id`,
            [slug, llama, p.date, p.totalLiquidityUSD, fetchedAt, runId],
          );
        }
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
      await closeRun(runId, rows.length ? 'ok' : 'skipped', rows.length, rows.length ? undefined : 'no Sui series');
      console.log(`[defillama] ${slug} (${llama}): ${rows.length} days`);
    } catch (e: any) {
      await closeRun(runId, 'error', 0, String(e?.message ?? e));
      console.error(`[defillama] ${slug} FAILED: ${e?.message ?? e}`);
      allOk = false;
    }
  }
  await touchFreshness('sui', 'defillama_protocol', allOk ? 'ok' : 'broken', 36);
  return allOk;
}

function num(v: unknown): number | null { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; }
// Adapters carry LTV / LT as fractions (0..1); the platform stores percent (0..100) per house/units.md.
function pct(v: unknown): number | null { const n = num(v); return n == null ? null : (n <= 1 ? n * 100 : n); }

(async () => {
  const args = new Set(process.argv.slice(2));
  const all = args.size === 0;
  const results: boolean[] = [];
  if (all || args.has('--pools')) results.push(await ingestPools());
  if (all || args.has('--liquidations')) results.push(await ingestLiquidations());
  if (all || args.has('--defillama')) results.push(await ingestDefillama());
  await pool.end();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(async (e) => { console.error('platform-ingest crashed:', e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
