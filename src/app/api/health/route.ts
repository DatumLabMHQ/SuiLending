export const dynamic = 'force-dynamic';

// Health probe for datum-monitor. Intentionally dependency-free so the monitor
// can distinguish "dashboard is up, upstream SDK flaky" from "dashboard is down".
export async function GET() {
  return Response.json({
    status: 'ok',
    service: 'navi-dashboard',
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    commit: process.env.GIT_COMMIT_SHA ?? null,
  });
}
