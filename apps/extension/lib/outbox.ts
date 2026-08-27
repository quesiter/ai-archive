import type { CaptureDeltaV1, CapturePayloadV1 } from "@ai-archive/contracts";

export interface OutboxRecord {
  id: string;
  payload: CapturePayloadV1;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
  lastStatusCode?: number;
  authRevoked?: boolean;
}

const DB_NAME = "ai-conversation-archive";
const STORE_NAME = "outbox";

function isDeltaPayload(payload: CapturePayloadV1): payload is CaptureDeltaV1 {
  return payload.captureMode === "append" && "appendedMessages" in payload;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function database(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("nextAttemptAt", "nextAttemptAt");
    }
  };
  return requestResult(request);
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    const tx = db.transaction(STORE_NAME, mode);
    const result = await requestResult(operation(tx.objectStore(STORE_NAME)));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    return result;
  } finally {
    db.close();
  }
}

export async function enqueue(payload: CapturePayloadV1): Promise<string> {
  const canonical = JSON.stringify({
    provider: payload.provider,
    sessionId: payload.sessionId,
    branchFingerprint: payload.branchFingerprint,
    captureMode: payload.captureMode ?? "full",
    title: payload.title ?? null,
    canonicalUrl: payload.canonicalUrl ?? null,
    adapterVersion: payload.adapterVersion,
    body:
      isDeltaPayload(payload)
        ? {
            baseRevisionId: payload.baseRevisionId ?? null,
            baseMessageCount: payload.baseMessageCount,
            baseLastMessageId: payload.baseLastMessageId ?? null,
            baseLastMessageTextHash: payload.baseLastMessageTextHash ?? null,
            appendedMessages: payload.appendedMessages,
          }
        : {
            completeness: payload.completeness,
            messages: payload.messages,
          },
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const id = `capture:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  const record: OutboxRecord = {
    id,
    payload,
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
  };
  await transaction("readwrite", (store) => store.put(record));
  return id;
}

export async function dueRecords(
  limit = 10,
  includeDeferred = false,
): Promise<OutboxRecord[]> {
  const records = await transaction("readonly", (store) => store.getAll());
  return (records as OutboxRecord[])
    .filter((record) => includeDeferred || record.nextAttemptAt <= Date.now())
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, limit);
}

export async function remove(id: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete(id));
}

export async function markFailed(
  id: string,
  error: string,
  attempts: number,
  statusCode?: number,
): Promise<void> {
  const record = (await transaction("readonly", (store) => store.get(id))) as
    | OutboxRecord
    | undefined;
  if (!record) return;
  const delay = Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 5_000);
  await transaction("readwrite", (store) =>
    store.put({
      ...record,
      attempts,
      lastError: error.slice(0, 1_000),
      lastStatusCode: statusCode,
      authRevoked: false,
      nextAttemptAt: Date.now() + delay,
    }),
  );
}

export async function markAuthRevoked(
  id: string,
  error: string,
  attempts: number,
): Promise<void> {
  const record = (await transaction("readonly", (store) => store.get(id))) as
    | OutboxRecord
    | undefined;
  if (!record) return;
  await transaction("readwrite", (store) => store.put({
    ...record,
    attempts,
    lastError: error.slice(0, 1_000),
    lastStatusCode: 401,
    authRevoked: true,
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
  }));
}

export async function listRecords(): Promise<OutboxRecord[]> {
  const records = await transaction("readonly", (store) => store.getAll());
  return (records as OutboxRecord[]).sort((left, right) => left.createdAt - right.createdAt);
}

export async function retryRecord(id: string): Promise<void> {
  const record = (await transaction("readonly", (store) => store.get(id))) as
    | OutboxRecord
    | undefined;
  if (!record) return;
  await transaction("readwrite", (store) => store.put({
    ...record,
    nextAttemptAt: Date.now(),
    authRevoked: false,
  }));
}

export async function retryAllRecords(): Promise<void> {
  for (const record of await listRecords()) await retryRecord(record.id);
}

export async function outboxCount(): Promise<number> {
  return transaction("readonly", (store) => store.count());
}
