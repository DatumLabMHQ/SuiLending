/**
 * Database client.
 *
 * Uses Prisma when DATABASE_URL is set. Otherwise returns null
 * so the app can render without a database (API routes
 * return empty arrays until a DB is connected).
 *
 * Prisma runs without its Rust engine (`engineType = "client"`) and talks to Postgres
 * through the `pg` driver adapter, which works on Cloudflare Workers and in Node scripts.
 *
 * On Workers a socket opened while serving one request cannot be used by another, so a
 * client (and its connection pool) is created per call there and closed after the response. Routes call getDb() once per
 * request. In Node (scripts, `next dev`) the client is cached as before.
 *
 * Run `npx prisma generate && npx prisma db push` after setting DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- callers use the client untyped, as before */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { after } from 'next/server';

const onWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
let prisma: any = null;

function createClient(url: string): any {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: onWorkers ? 3 : 10 }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export function getDb(): any {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (onWorkers) {
    const client = createClient(url);
    // Close this request's pool once the response is sent (waitUntil on Workers).
    try {
      after(() => client.$disconnect());
    } catch {
      // called outside a request scope; the pool is dropped with the isolate
    }
    return client;
  }
  if (prisma) return prisma;

  const globalForPrisma = globalThis as unknown as { __prisma: any };
  if (!globalForPrisma.__prisma) globalForPrisma.__prisma = createClient(url);
  prisma = globalForPrisma.__prisma;
  return prisma;
}

// Note: the old `pgbouncer=true` URL rewrite is gone. It told Prisma's Rust engine not to
// use named prepared statements on Neon's pooled endpoint. The pg driver adapter only sends
// unnamed statements, so stale cached plans after ALTER COLUMN cannot happen.

// ─── Type definitions matching the Prisma schema ────────────────────────────

export interface PoolSnapshotRow {
  id: number;
  symbol: string;
  timestamp: Date;
  totalSupply: number;
  totalSupplyUsd: number;
  totalBorrows: number;
  totalBorrowsUsd: number;
  availableLiquidity: number;
  availableLiquidityUsd: number;
  supplyApy: number;
  borrowApy: number;
  utilization: number;
  price: number;
}

export interface PoolDailyRow {
  id: number;
  symbol: string;
  date: Date;
  avgSupplyApy: number;
  avgBorrowApy: number;
  avgUtilization: number;
  closeTotalSupplyUsd: number;
  closeTotalBorrowsUsd: number;
  closeLiquidityUsd: number;
  closePrice: number;
}

export interface LiquidationEventRow {
  id: string;
  txDigest: string;
  timestamp: Date;
  liquidator: string;
  borrower: string;
  collateralAsset: string;
  collateralAmount: number;
  collateralPrice: number;
  collateralUsd: number;
  debtAsset: string;
  debtAmount: number;
  debtPrice: number;
  debtUsd: number;
  treasuryAmount: number;
}

export interface WalletPositionRow {
  id: number;
  address: string;
  collateralUsd: number;
  borrowUsd: number;
  healthFactor: number;
  collateralAssets: string;
  borrowAssets: string;
  refreshPriority: number;
  lastUpdated: Date;
}

export interface CollateralBorrowPairRow {
  id: number;
  collateralAsset: string;
  borrowAsset: string;
  count: number;
  totalCollateralUsd: number;
  totalBorrowUsd: number;
  updatedAt: Date;
}
