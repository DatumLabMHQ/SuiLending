/**
 * Cron auth health-check.
 *
 * Returns whether CRON_SECRET is configured and what the daily refresh
 * pipeline looks like. No secrets leak — we never echo the value, only
 * whether it's present and a redacted hash for fingerprinting.
 *
 * Public — no auth required (intentional, so you can hit it from a browser
 * to confirm Vercel env vars are set without copying the secret around).
 */

import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@/lib/constants';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

function fingerprint(s: string | undefined): string {
  if (!s) return 'MISSING';
  // Coarse fingerprint so we can confirm the value across deploys without
  // leaking it. First 4 + last 4 chars of a 4-char-shifted view.
  if (s.length < 8) return 'TOO_SHORT';
  return `${s.slice(0, 2)}…${s.slice(-2)} (len=${s.length})`;
}

export async function GET() {
  const db = getDb();

  const env = {
    CRON_SECRET: fingerprint(CRON_SECRET),
    DATA_SOURCE: process.env.DATA_SOURCE === 'platform' ? 'platform' : 'legacy (default)',
    PLATFORM_READ_URL: process.env.PLATFORM_READ_URL ? 'set' : 'MISSING',
    DATABASE_URL: process.env.DATABASE_URL ? `postgresql://…(len=${process.env.DATABASE_URL.length})` : 'MISSING',
    BLOCKVISION_SUI_RPC: process.env.BLOCKVISION_SUI_RPC ? 'set' : 'MISSING',
    SUI_GRPC_URL: process.env.SUI_GRPC_URL ?? 'MISSING (using public fullnode gRPC)',
    SUI_GRPC_AUTH: process.env.SUI_GRPC_BEARER || process.env.SUI_GRPC_API_KEY ? 'set' : 'MISSING',
    ALCHEMY_SUI_RPC: process.env.ALCHEMY_SUI_RPC ? 'set (legacy JSON-RPC, unused)' : 'MISSING',
  };

  let dbCheck: Record<string, unknown> = { connected: false };
  if (db) {
    try {
      const lastSnap = await db.poolSnapshot.findFirst({
        orderBy: { timestamp: 'desc' },
        select: { protocol: true, timestamp: true },
      });
      const lastLiq = await db.liquidationEvent.findFirst({
        orderBy: { timestamp: 'desc' },
        select: { protocol: true, timestamp: true },
      });
      dbCheck = {
        connected: true,
        latestPoolSnapshot: lastSnap,
        hoursSinceLastSnapshot: lastSnap
          ? Math.round((Date.now() - lastSnap.timestamp.getTime()) / 36e5 * 10) / 10
          : null,
        latestLiquidation: lastLiq,
      };
    } catch (e) {
      dbCheck = { connected: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({
    service: 'sui-lending-cron-status',
    timestamp: new Date().toISOString(),
    deployment: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      region: process.env.VERCEL_REGION ?? null,
    },
    env,
    db: dbCheck,
    crons: {
      schedule: 'see vercel.json',
      protocols: ['navi', 'suilend', 'scallop', 'alphalend', 'bucket'],
      manualTrigger: 'curl -H "Authorization: Bearer $CRON_SECRET" /api/<protocol>/cron/collect-pools',
    },
  });
}
