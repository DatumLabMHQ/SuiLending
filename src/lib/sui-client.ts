/**
 * Shared Sui gRPC client.
 *
 * Sui JSON-RPC is gone: the Foundation's public fullnodes stopped serving it
 * in late July 2026 and Alchemy switches it off on 25 September 2026. Every
 * on-chain read in this app goes through this client (gRPC-Web over fetch,
 * which works in Node, Vercel functions and browsers without extra deps).
 *
 * Provider selection is by env:
 *   SUI_GRPC_URL      base URL of the gRPC-Web endpoint. Examples:
 *                       https://sui-mainnet.g.alchemy.com          (Alchemy, Bearer key)
 *                       https://sui-mainnet-grpc.blockvision.org   (BlockVision, x-api-key)
 *                       https://fullnode.mainnet.sui.io:443         (public, rate-limited)
 *   SUI_GRPC_BEARER   sent as `Authorization: Bearer <value>` (Alchemy API key)
 *   SUI_GRPC_API_KEY  sent as `x-api-key: <value>` (BlockVision); falls back to
 *                     BLOCKVISION_API_KEY when the URL is a BlockVision host.
 *
 * The public fullnode is always kept as a fallback client: it is fine for a
 * once-daily cron but is rate limited and keeps only a few weeks of history,
 * so it must not be the primary in production.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';

export const PUBLIC_SUI_GRPC_URL = 'https://fullnode.mainnet.sui.io:443';

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

export function suiGrpcUrl(): string {
  // `||` not `??`: CI runners set unset secrets to '' and an empty base URL breaks every call.
  return stripTrailingSlash(process.env.SUI_GRPC_URL || PUBLIC_SUI_GRPC_URL);
}

export function suiRpcSourceLabel(): string {
  const u = suiGrpcUrl();
  if (u.includes('alchemy')) return 'alchemy-grpc';
  if (u.includes('blockvision')) return 'blockvision-grpc';
  if (u.includes('fullnode.mainnet.sui.io')) return 'fullnode.sui.io-grpc';
  try { return new URL(u).host; } catch { return 'grpc'; }
}

function authMeta(url: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const bearer = process.env.SUI_GRPC_BEARER || undefined;
  const apiKey = process.env.SUI_GRPC_API_KEY
    || (url.includes('blockvision') ? process.env.BLOCKVISION_API_KEY : undefined) || undefined;
  if (bearer) meta.Authorization = `Bearer ${bearer}`;
  if (apiKey) meta['x-api-key'] = apiKey;
  return meta;
}

let _primary: SuiGrpcClient | null = null;
let _public: SuiGrpcClient | null = null;

/** The configured provider (or the public node when SUI_GRPC_URL is unset). */
export function getSuiClient(): SuiGrpcClient {
  if (!_primary) {
    const baseUrl = suiGrpcUrl();
    const meta = authMeta(baseUrl);
    _primary = new SuiGrpcClient({
      network: 'mainnet',
      baseUrl,
      ...(Object.keys(meta).length ? { meta } : {}),
      timeout: 30_000,
    });
  }
  return _primary;
}

/** The public fullnode, used only when the primary fails. */
export function getPublicSuiClient(): SuiGrpcClient {
  if (!_public) {
    _public = new SuiGrpcClient({ network: 'mainnet', baseUrl: PUBLIC_SUI_GRPC_URL, timeout: 30_000 });
  }
  return _public;
}

/**
 * Run `fn` against the primary client; on failure, retry once against the
 * public node when the primary is not already the public node. Errors from
 * the fallback propagate so callers keep their existing error handling.
 */
export async function withSuiClient<T>(fn: (client: SuiGrpcClient) => Promise<T>): Promise<T> {
  const primary = getSuiClient();
  try {
    return await fn(primary);
  } catch (err) {
    if (suiGrpcUrl() === PUBLIC_SUI_GRPC_URL) throw err;
    console.warn(`[sui-client] primary (${suiRpcSourceLabel()}) failed, retrying on public fullnode:`,
      err instanceof Error ? err.message : err);
    return fn(getPublicSuiClient());
  }
}
