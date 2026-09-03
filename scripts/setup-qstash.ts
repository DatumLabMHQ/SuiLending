/**
 * Set up Upstash QStash schedules for all cron jobs.
 *
 * Usage: npx tsx scripts/setup-qstash.ts
 *
 * Requires:
 *   QSTASH_TOKEN — from Upstash dashboard
 *   APP_URL — your Vercel deployment URL (e.g. https://navi-dashboard.vercel.app)
 *   CRON_SECRET — shared secret for cron auth
 */

const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const APP_URL = process.env.APP_URL;
const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) throw new Error('CRON_SECRET must be set (no default; cron routes fail closed)');

if (!QSTASH_TOKEN || !APP_URL) {
  console.error('Missing QSTASH_TOKEN or APP_URL');
  process.exit(1);
}

const SCHEDULES = [
  {
    name: 'collect-pools',
    path: '/api/cron/collect-pools',
    cron: '*/5 * * * *', // every 5 minutes
  },
  {
    name: 'index-liquidations',
    path: '/api/cron/index-liquidations',
    cron: '*/10 * * * *', // every 10 minutes
  },
  {
    name: 'index-wallets',
    path: '/api/cron/index-wallets',
    cron: '*/2 * * * *', // every 2 minutes
  },
  {
    name: 'aggregate-daily',
    path: '/api/cron/aggregate-daily',
    cron: '5 0 * * *', // daily at 00:05 UTC
  },
  {
    name: 'aggregate-pairs',
    path: '/api/cron/aggregate-pairs',
    cron: '0 */6 * * *', // every 6 hours
  },
];

async function createSchedule(schedule: typeof SCHEDULES[0]) {
  const url = `${APP_URL}${schedule.path}`;

  const res = await fetch('https://qstash.upstash.io/v2/schedules', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Forward-Authorization': `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify({
      destination: url,
      cron: schedule.cron,
    }),
  });

  const data = await res.json();
  return data;
}

async function main() {
  console.log('Setting up QStash schedules...\n');
  console.log(`App URL: ${APP_URL}`);

  for (const schedule of SCHEDULES) {
    console.log(`\nCreating: ${schedule.name} (${schedule.cron})`);
    try {
      const result = await createSchedule(schedule);
      console.log(`  Schedule ID: ${result.scheduleId ?? 'unknown'}`);
      console.log(`  Status: ${result.scheduleId ? 'OK' : JSON.stringify(result)}`);
    } catch (err) {
      console.error(`  Error:`, err);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
