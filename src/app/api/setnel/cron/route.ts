import { NextResponse } from 'next/server';
import { setSelfUrl } from '@/lib/setnel/detectors'; // also registers detectors via side-effect
import { runDetectors } from '@/lib/setnel/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/setnel/cron — runs State of SUI detectors, posts to the Setnel Hub.
export async function GET(req: Request) {
  const hubUrl = process.env.SETNEL_HUB_URL;
  const secret = process.env.SETNEL_SECRET;
  if (!hubUrl || !secret) {
    return NextResponse.json({ error: 'SETNEL_HUB_URL / SETNEL_SECRET not set' }, { status: 500 });
  }
  setSelfUrl(new URL(req.url).origin);
  const report = await runDetectors({ dashboardId: 'sui', hubUrl, secret });
  return NextResponse.json(report);
}
