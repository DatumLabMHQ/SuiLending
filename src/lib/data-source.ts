/**
 * DATA_SOURCE switch: where the dashboard's aggregator reads from.
 *
 *   legacy    (default) this app's own Prisma database, filled by its daily crons.
 *   platform  the Datum data platform's curated tables (datum-models), read through the
 *             read-only role in PLATFORM_READ_URL. Rate-model parameters and wallet positions
 *             are not in the platform yet, so those two reads still come from the legacy
 *             database when it is configured (hybrid), and are empty otherwise.
 *
 * Flip back = change the env var and redeploy. Nothing else differs between the two paths:
 * the same assembly code shapes the same JSON, which is what the shadow comparison checks.
 */
import { Client } from 'pg';

export type DataSource = 'legacy' | 'platform';

export function dataSource(): DataSource {
  return process.env.DATA_SOURCE === 'platform' ? 'platform' : 'legacy';
}

// One short-lived connection per query. On Cloudflare Workers a socket opened while serving
// one request cannot be used by another, so a module-level pg Pool breaks from the second
// request on. Callers run a handful of queries per request against Neon's pooler, so the
// extra connect is cheap.
export async function platformQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.PLATFORM_READ_URL;
  if (!url) throw new Error('DATA_SOURCE=platform but PLATFORM_READ_URL is not set');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query(sql, params);
    return r.rows as T[];
  } finally {
    await client.end().catch(() => {});
  }
}
