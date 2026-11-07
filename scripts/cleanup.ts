import { getDb } from '../src/lib/db';

async function main() {
  const db = getDb();
  if (!db) throw new Error('DATABASE_URL is not set');
  const res = await db.liquidationEvent.deleteMany({
    where: {
      protocol: 'navi',
      OR: [
        { collateralAsset: { in: ['NAVX', 'haSUI', 'UNKNOWN'] } },
        { debtAsset:       { in: ['NAVX', 'haSUI', 'UNKNOWN'] } },
      ],
    },
  });
  console.log(`Deleted ${res.count} rows.`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
