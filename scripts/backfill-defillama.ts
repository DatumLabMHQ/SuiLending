/**
 * Manual DefiLlama TVL backfill — CLI entrypoint.
 *
 * Usage: set -a && source .env.local && set +a && npx tsx scripts/backfill-defillama.ts
 *
 * This is the manual escape hatch. The same logic runs automatically every
 * day at 02:00 UTC via /api/cron/backfill-defillama — see
 * src/lib/defillama-backfill.ts for the shared implementation. Re-run this
 * by hand if you need to seed a freshly-migrated DB or fill an unusually
 * long gap (the cron caps at 60 days).
 */

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const { getDb } = await import('../src/lib/db');
  const db = getDb();
  if (!db) throw new Error('DATABASE_URL is not set');
  const { backfillAll } = await import('../src/lib/defillama-backfill');

  console.log('Backfilling DefiLlama TVL history for all 5 protocols…\n');
  // Pass no sinceDays → unlimited (full 1-3 year history). Manual runs
  // are rare and usually want everything.
  const results = await backfillAll(db);
  let grandTotal = 0;
  for (const r of results) {
    grandTotal += r.inserted;
    const tag = r.error ? `  ERROR: ${r.error}` : r.failed ? `  [${r.failed} failed]` : '';
    const span = r.first && r.last ? `${r.first} → ${r.last}` : r.error ? 'n/a' : 'empty';
    console.log(`  ${r.protocol.padEnd(10)} ${String(r.inserted).padStart(5)} rows  (${span})${tag}`);
  }
  console.log(`\nDone — ${grandTotal} total DefillamaTvl rows upserted.`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
