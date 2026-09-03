import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/constants';
import { isValidProtocol } from '@/protocols/registry';
import { NAVI_EVENT_TYPES } from '@/protocols/navi/config';
import { queryEvents } from '@/lib/rpc';
import { getDb } from '@/lib/db';
import {
  fetchNaviUserState,
  healthToRefreshPriority,
} from '@/protocols/navi/userState';
import { parseBorrowEvent, parseDepositEvent } from '@/protocols/navi/events';

export const dynamic = 'force-dynamic';

const REFRESH_BUCKETS = [
  { priority: 0, staleMinutes: 2 },
  { priority: 1, staleMinutes: 5 },
  { priority: 2, staleMinutes: 15 },
  { priority: 3, staleMinutes: 60 },
];
const REFRESH_CAP = 50;

/**
 * Wallet indexer cron.
 * 1) Discover new borrower/depositor addresses from recent events.
 * 2) Refresh stale wallets (tiered by healthFactor-derived priority).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ protocol: string }> }
) {
  const authHeader = req.headers.get('authorization');
  if (!cronAuthorized(authHeader)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { protocol: slug } = await params;

  if (!isValidProtocol(slug)) {
    return NextResponse.json({ error: `Unknown protocol: ${slug}` }, { status: 404 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'No database configured' }, { status: 503 });
  }

  if (slug !== 'navi') {
    return NextResponse.json({ message: `Wallet indexing not yet implemented for ${slug}` });
  }

  try {
    // Step 1: discover new addresses from recent events
    const newAddresses = new Set<string>();
    const eventParsers: Array<[string, (raw: Record<string, unknown>) => { sender: string }]> = [
      [NAVI_EVENT_TYPES.BORROW, parseBorrowEvent],
      [NAVI_EVENT_TYPES.DEPOSIT, parseDepositEvent],
    ];
    for (const [eventType, parse] of eventParsers) {
      try {
        const page = await queryEvents(eventType, null, 50, 'descending');
        for (const evt of page.data) {
          try {
            const { sender } = parse(evt.parsedJson);
            if (sender) newAddresses.add(sender);
          } catch {
            // schema drift on a single event shouldn't halt discovery
          }
        }
      } catch {
        // skip if this event type query fails entirely
      }
    }

    let discovered = 0;
    for (const address of newAddresses) {
      try {
        const res = await db.walletPosition.upsert({
          where: { protocol_address: { protocol: slug, address } },
          create: {
            protocol: slug,
            address,
            collateralUsd: 0,
            borrowUsd: 0,
            healthFactor: 999,
            collateralAssets: '[]',
            borrowAssets: '[]',
            refreshPriority: 3,
            // lastUpdated intentionally set to epoch so the refresh step
            // below picks this wallet up on the next run (or this run, if
            // capacity allows).
            lastUpdated: new Date(0),
          },
          update: {},
        });
        if (res.lastUpdated.getTime() === 0) discovered++;
      } catch {
        // ignore duplicates / races
      }
    }

    // Step 2: refresh stale wallets, priority-ordered
    let refreshed = 0;
    let failures = 0;

    for (const { priority, staleMinutes } of REFRESH_BUCKETS) {
      if (refreshed >= REFRESH_CAP) break;

      const staleThreshold = new Date(Date.now() - staleMinutes * 60 * 1000);
      const staleWallets = await db.walletPosition.findMany({
        where: {
          protocol: slug,
          refreshPriority: priority,
          lastUpdated: { lt: staleThreshold },
        },
        orderBy: { lastUpdated: 'asc' },
        take: REFRESH_CAP - refreshed,
      });

      for (const wallet of staleWallets) {
        try {
          const state = await fetchNaviUserState(wallet.address);
          await db.walletPosition.update({
            where: { id: wallet.id },
            data: {
              collateralUsd: state.collateralUsd,
              borrowUsd: state.borrowUsd,
              healthFactor: state.healthFactor,
              collateralAssets: JSON.stringify(state.collateralAssets),
              borrowAssets: JSON.stringify(state.borrowAssets),
              refreshPriority: healthToRefreshPriority(state.healthFactor),
              lastUpdated: new Date(),
            },
          });
          refreshed++;
        } catch (err) {
          failures++;
          console.error(
            `[index-wallets] refresh failed for ${wallet.address}:`,
            err instanceof Error ? err.message : err
          );
          // Bump lastUpdated so we don't hammer a bad address every run,
          // but keep its priority so it stays eligible for retry later.
          await db.walletPosition
            .update({
              where: { id: wallet.id },
              data: { lastUpdated: new Date() },
            })
            .catch(() => {});
        }
      }
    }

    return NextResponse.json({
      success: true,
      protocol: slug,
      discovered,
      refreshed,
      failures,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`index-wallets[${slug}] error:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
