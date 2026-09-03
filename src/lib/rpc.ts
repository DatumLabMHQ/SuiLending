/**
 * Sui read helpers with the JSON-RPC-era shapes the adapters were written
 * against, implemented over gRPC (see ./sui-client.ts).
 *
 * The old file was a raw `fetch` JSON-RPC client. JSON-RPC no longer exists on
 * public fullnodes and Alchemy retires it on 25 Sep 2026, so the same exports
 * are kept and re-implemented:
 *
 *   queryEvents(type, cursor, limit, order)  -> LedgerService.ListEvents
 *   getObject / getMultipleObjects           -> LedgerService.GetObject / BatchGetObjects
 *   getDynamicFields                         -> StateService.ListDynamicFields
 *   rpc('sui_getTransactionBlock', ...)      -> LedgerService.GetTransaction
 *   rpc('sui_getLatestCheckpointSequenceNumber') -> LedgerService.GetServiceInfo
 *   rpc('sui_getCheckpoint', [seq])          -> LedgerService.GetCheckpoint
 *
 * Shape differences worth knowing:
 *   - Event cursors are opaque strings now (they used to be {txDigest, eventSeq}).
 *     Callers only pass them back, so `EventCursor` is exported for typing.
 *   - Object content comes back as decoded JSON. Nested Move structs are plain
 *     objects rather than `{ type, fields }` wrappers. The bucket walker
 *     (`nested()`) already tolerates both forms.
 *   - Event timestamps are not on the event itself in gRPC; we batch-fetch the
 *     transactions' timestamps once per page (one extra call per page, not per
 *     event).
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { withSuiClient } from './sui-client';

// ─── Events ─────────────────────────────────────────────────────────────────

export type EventCursor = string;

export interface EventPage {
  data: Array<{
    id: { txDigest: string; eventSeq: string };
    packageId: string;
    transactionModule: string;
    sender: string;
    type: string;
    parsedJson: Record<string, unknown>;
    timestampMs: string;
    checkpoint?: string;
  }>;
  nextCursor: EventCursor | null;
  hasNextPage: boolean;
}

// gRPC renders Move `TypeName` values as bare strings ("<pkg>::module::Name"),
// where JSON-RPC rendered them as `{ name: "<pkg>::module::Name" }`. The
// adapters were written against the JSON-RPC form (`j.repay_coin_type.name`),
// so event JSON is normalised back to it here. Everything else (u64 as
// strings, addresses, nested structs as plain objects) already matches what
// the adapters read.
const MOVE_TYPE_RE = /^(0x)?[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_<>:, ]*$/;
function normalizeMoveJson(v: unknown): unknown {
  if (typeof v === 'string') return MOVE_TYPE_RE.test(v) ? { name: v } : v;
  if (Array.isArray(v)) return v.map(normalizeMoveJson);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalizeMoveJson(x);
    return out;
  }
  return v;
}

function tsToMs(ts: { seconds?: bigint | string | number; nanos?: number } | undefined): string {
  if (!ts || ts.seconds == null) return '';
  const s = typeof ts.seconds === 'bigint' ? Number(ts.seconds) : Number(ts.seconds);
  const ms = s * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
  return String(ms);
}

async function timestampsFor(client: SuiGrpcClient, digests: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const unique = Array.from(new Set(digests)).filter(Boolean);
  if (!unique.length) return out;
  // BatchGetTransactions is capped per request; keep chunks small and cheap.
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const r = await client.ledgerService.batchGetTransactions({
      digests: chunk,
      readMask: { paths: ['digest', 'timestamp'] },
    });
    for (const t of (r.response as any).transactions ?? []) {
      // BatchGetTransactionsResponse wraps each item as { result: { oneofKind: 'transaction', transaction } }.
      const tx = t.result?.transaction ?? t.transaction ?? t;
      if (tx?.digest) out[tx.digest] = tsToMs(tx.timestamp);
    }
  }
  return out;
}

export async function queryEvents(
  eventType: string,
  cursor?: EventCursor | { txDigest: string; eventSeq: string } | null,
  limit = 50,
  order: 'ascending' | 'descending' = 'descending'
): Promise<EventPage> {
  // Legacy object cursors cannot be translated; start from the tip instead.
  const cur = typeof cursor === 'string' ? cursor : null;
  return withSuiClient(async (client) => {
    const page = await client.core.listEvents({
      filter: { eventType },
      limit,
      order,
      ...(cur ? (order === 'descending' ? { before: cur } : { after: cur }) : {}),
    });
    const events = page.events as any[];
    const ts = await timestampsFor(client, events.map((e) => e.transactionDigest));
    return {
      data: events.map((e) => ({
        id: { txDigest: e.transactionDigest, eventSeq: String(e.eventIndex ?? 0) },
        packageId: e.packageId,
        transactionModule: e.module,
        sender: e.sender,
        type: e.eventType,
        parsedJson: normalizeMoveJson(e.json ?? {}) as Record<string, unknown>,
        timestampMs: ts[e.transactionDigest] ?? '',
        checkpoint: e.checkpoint != null ? String(e.checkpoint) : undefined,
      })),
      nextCursor: page.hasNextPage ? (page.endCursor ?? null) : null,
      hasNextPage: page.hasNextPage,
    };
  });
}

// ─── Objects ────────────────────────────────────────────────────────────────

export interface SuiObject {
  data: {
    objectId: string;
    version: string;
    content: {
      dataType: string;
      type: string;
      fields: Record<string, unknown>;
    };
  };
}

function toSuiObject(o: any): SuiObject {
  return {
    data: {
      objectId: o.objectId,
      version: String(o.version ?? ''),
      content: {
        dataType: 'moveObject',
        type: o.type ?? '',
        fields: (o.json ?? {}) as Record<string, unknown>,
      },
    },
  };
}

export async function getObject(objectId: string): Promise<SuiObject> {
  return withSuiClient(async (client) => {
    const { object } = await client.core.getObject({ objectId, include: { content: true } });
    return toSuiObject(object);
  });
}

export async function getMultipleObjects(objectIds: string[]): Promise<SuiObject[]> {
  if (!objectIds.length) return [];
  return withSuiClient(async (client) => {
    const out: SuiObject[] = [];
    for (let i = 0; i < objectIds.length; i += 50) {
      const { objects } = await client.core.getObjects({
        objectIds: objectIds.slice(i, i + 50),
        include: { content: true },
      });
      for (const o of objects as any[]) out.push(toSuiObject(o));
    }
    return out;
  });
}

// ─── Dynamic fields ─────────────────────────────────────────────────────────

export interface DynamicFieldPage {
  data: Array<{
    name: { type: string; value: unknown };
    objectId: string;
    objectType: string;
  }>;
  nextCursor: string | null;
  hasNextPage: boolean;
}

export async function getDynamicFields(
  parentId: string,
  cursor?: string | null,
  limit = 50
): Promise<DynamicFieldPage> {
  return withSuiClient(async (client) => {
    const page: any = await client.core.listDynamicFields({ parentId, limit, cursor: cursor ?? undefined });
    return {
      data: (page.dynamicFields as any[]).map((f) => ({
        name: { type: f.name?.type ?? '', value: f.name?.bcs ?? null },
        objectId: f.fieldId,
        objectType: f.valueType ?? f.type ?? '',
      })),
      nextCursor: page.hasNextPage ? (page.cursor ?? page.endCursor ?? null) : null,
      hasNextPage: !!page.hasNextPage,
    };
  });
}

// ─── Method-style access for the few remaining call sites ───────────────────

/**
 * Minimal JSON-RPC-method dispatcher kept so existing `rpc('sui_...')` call
 * sites keep working. Only the methods this app uses are implemented.
 */
export async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  switch (method) {
    case 'sui_getTransactionBlock': {
      const digest = String(params[0]);
      return withSuiClient(async (client) => {
        const r = await client.ledgerService.getTransaction({
          digest,
          readMask: { paths: ['digest', 'transaction.sender', 'effects.gas_used', 'effects.status', 'timestamp', 'checkpoint'] },
        });
        const tx: any = (r.response as any).transaction ?? {};
        const gas = tx.effects?.gasUsed;
        return {
          digest: tx.digest ?? digest,
          transaction: { data: { sender: tx.transaction?.sender ?? '' } },
          effects: gas
            ? { gasUsed: { computationCost: String(gas.computationCost ?? '0'), storageCost: String(gas.storageCost ?? '0'), storageRebate: String(gas.storageRebate ?? '0') }, status: tx.effects?.status }
            : undefined,
          timestampMs: tsToMs(tx.timestamp),
          checkpoint: tx.checkpoint != null ? String(tx.checkpoint) : undefined,
        } as unknown as T;
      });
    }
    case 'sui_getLatestCheckpointSequenceNumber': {
      return withSuiClient(async (client) => {
        const r = await client.ledgerService.getServiceInfo({});
        return String((r.response as any).checkpointHeight ?? '') as unknown as T;
      });
    }
    case 'sui_getCheckpoint': {
      const seq = BigInt(String(params[0]));
      return withSuiClient(async (client) => {
        const r = await client.ledgerService.getCheckpoint({
          checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: seq },
          readMask: { paths: ['sequence_number', 'digest', 'summary.timestamp'] },
        });
        const cp: any = (r.response as any).checkpoint ?? {};
        return {
          sequenceNumber: String(cp.sequenceNumber ?? seq),
          digest: cp.digest ?? '',
          timestampMs: tsToMs(cp.summary?.timestamp),
        } as unknown as T;
      });
    }
    default:
      throw new Error(`rpc: ${method} has no gRPC implementation in src/lib/rpc.ts`);
  }
}
