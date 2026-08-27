import {
  CapturePayloadV1Schema,
  type CaptureDeltaV1,
  type CapturePayloadV1,
} from "@ai-archive/contracts";
import { defineBackground } from "wxt/utils/define-background";
import type {
  CaptureUiState,
  ExtensionMessage,
  ExtensionSettings,
} from "../lib/messages";
import {
  dueRecords,
  enqueue,
  listRecords,
  markAuthRevoked,
  markFailed,
  outboxCount,
  remove,
  retryAllRecords,
  retryRecord,
} from "../lib/outbox";
import { packagedServerOrigin } from "../lib/packaged-origin";

const AUTH_STORAGE_KEYS: Array<keyof AuthStorage> = [
  "serverUrl",
  "deviceId",
  "deviceToken",
  "deviceName",
];

type AuthStorage = Pick<
  ExtensionSettings,
  "serverUrl" | "deviceId" | "deviceToken" | "deviceName"
>;

async function readAuthState(): Promise<Partial<AuthStorage>> {
  return (await browser.storage.local.get(AUTH_STORAGE_KEYS)) as Partial<AuthStorage>;
}

async function writeAuthState(state: AuthStorage): Promise<void> {
  // Device tokens are bearer credentials. Keep them on this browser profile
  // instead of copying them through the user's Chrome Sync account.
  await browser.storage.local.set(state);
  await browser.storage.sync.remove(AUTH_STORAGE_KEYS);
}

async function clearAuthState(): Promise<void> {
  await Promise.all([
    browser.storage.local.remove(AUTH_STORAGE_KEYS),
    browser.storage.sync.remove(AUTH_STORAGE_KEYS),
  ]);
}

function normalizedServerUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("服务地址必须是 HTTP(S)");
  }
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    throw new Error("远程归档服务必须使用 HTTPS");
  }
  return url.origin;
}

function payloadMessageCount(payload: CapturePayloadV1): number {
  return isDeltaPayload(payload)
    ? payload.baseMessageCount + payload.appendedMessages.length
    : payload.messages.length;
}

function isDeltaPayload(payload: CapturePayloadV1): payload is CaptureDeltaV1 {
  return payload.captureMode === "append" && "appendedMessages" in payload;
}

async function setStatus(state: CaptureUiState): Promise<void> {
  await browser.storage.local.set({ lastStatus: state });
  const badge =
    state.status === "complete"
      ? "✓"
      : state.status === "partial"
        ? "!"
        : state.status === "failed"
          ? "×"
          : ["scanning", "checking", "waiting", "syncing"].includes(state.status)
            ? "…"
            : "";
  await browser.action.setBadgeText({ text: badge });
  await browser.action.setBadgeBackgroundColor({
    color:
      state.status === "complete"
        ? "#16725d"
        : state.status === "partial"
          ? "#b27400"
          : state.status === "failed"
            ? "#a43e3e"
            : "#53615d",
  });
}

async function gzipJson(value: unknown): Promise<Blob> {
  const source = new Blob([JSON.stringify(value)]).stream();
  if (typeof CompressionStream === "undefined") {
    return new Blob([JSON.stringify(value)], { type: "application/json" });
  }
  const compressed = source.pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).blob();
}

interface FlushResult {
  sent: number;
  remaining: number;
  requiresFullCapture?: boolean;
  lastResult?: {
    conversationId?: string;
    revisionId?: string;
    messageCount?: number;
    completeness?: "complete" | "partial";
    captureMode?: "full" | "append" | "import";
  };
}

class UploadHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function flushOutbox(force = false): Promise<FlushResult> {
  const settings = (await browser.storage.local.get("deviceToken")) as ExtensionSettings;
  const serverUrl = normalizedServerUrl(packagedServerOrigin());
  if (!settings.deviceToken) {
    return { sent: 0, remaining: await outboxCount() };
  }
  let sent = 0;
  let lastResult: FlushResult["lastResult"];
  for (const record of await dueRecords(10, force)) {
    try {
      const captureMode = isDeltaPayload(record.payload) ? "append" : "full";
      await setStatus({
        status: "syncing",
        provider: record.payload.provider,
        sessionId: record.payload.sessionId,
        captureMode,
        message: captureMode === "append" ? "正在上传增量采集" : "正在上传完整快照",
        updatedAt: new Date().toISOString(),
      });
      const body = await gzipJson(record.payload);
      const gzip = body.type !== "application/json";
      const response = await fetch(`${serverUrl}/api/v1/captures`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.deviceToken}`,
          "Content-Type": "application/json",
          ...(gzip ? { "Content-Encoding": "gzip" } : {}),
          "Idempotency-Key": record.id,
        },
        body,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          requiresFullCapture?: boolean;
        };
        if (
          response.status === 409 &&
          payload.requiresFullCapture &&
          isDeltaPayload(record.payload)
        ) {
          await remove(record.id);
          await setStatus({
            status: "failed",
            provider: record.payload.provider,
            sessionId: record.payload.sessionId,
            captureMode: "append",
            message: "增量基线不一致，正在回退完整采集",
            updatedAt: new Date().toISOString(),
          });
          return {
            sent,
            remaining: await outboxCount(),
            requiresFullCapture: true,
          };
        }
        if (response.status === 401) {
          const authMessage = "设备授权已失效，需要重新配对；待上传数据已保留";
          await markAuthRevoked(record.id, authMessage, record.attempts + 1);
          await clearAuthState();
          await browser.storage.local.set({ authRevoked: true });
          await setStatus({
            status: "failed",
            provider: record.payload.provider,
            sessionId: record.payload.sessionId,
            captureMode,
            message: authMessage,
            updatedAt: new Date().toISOString(),
          });
          return { sent, remaining: await outboxCount() };
        }
        throw new UploadHttpError(payload.error ?? `上传失败 (${response.status})`, response.status);
      }
      const result = (await response.json().catch(() => ({}))) as {
        conversationId?: string;
        revisionId?: string;
        messageCount?: number;
        completeness?: "complete" | "partial";
        captureMode?: "full" | "append" | "import";
      };
      lastResult = {
        ...result,
        captureMode,
        messageCount: result.messageCount ?? payloadMessageCount(record.payload),
      };
      await remove(record.id);
      sent += 1;
      await setStatus({
        status: "complete",
        provider: record.payload.provider,
        sessionId: record.payload.sessionId,
        captureMode,
        message: `${payloadMessageCount(record.payload)} 条消息已归档`,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markFailed(
        record.id,
        message,
        record.attempts + 1,
        error instanceof UploadHttpError ? error.status : undefined,
      );
      await setStatus({
        status: "failed",
        provider: record.payload.provider,
        sessionId: record.payload.sessionId,
        captureMode: isDeltaPayload(record.payload) ? "append" : "full",
        message,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return { sent, remaining: await outboxCount(), ...(lastResult ? { lastResult } : {}) };
}

export default defineBackground(() => {
  // Remove credentials written by older builds to Chrome Sync.
  void browser.storage.sync.remove(AUTH_STORAGE_KEYS);

  browser.alarms.create("flush-outbox", { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "flush-outbox") void flushOutbox();
  });

  browser.runtime.onMessage.addListener((rawMessage: unknown, sender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    if (!rawMessage || typeof rawMessage !== "object" || !("type" in rawMessage)) {
      return undefined;
    }
    const message = rawMessage as ExtensionMessage;
    if (message.type === "enqueueCapture") {
      return (async () => {
        const payload = CapturePayloadV1Schema.parse(message.payload);
        await enqueue(payload);
        await setStatus({
          status: "queued",
          provider: payload.provider,
          sessionId: payload.sessionId,
          captureMode: isDeltaPayload(payload) ? "append" : "full",
          message: isDeltaPayload(payload) ? "增量采集等待上传" : "完整采集等待上传",
          updatedAt: new Date().toISOString(),
        });
        return flushOutbox();
      })();
    }
    if (message.type === "captureState") {
      return setStatus(message.state).then(() => ({ ok: true }));
    }
    if (message.type === "flushOutbox") return flushOutbox(true);
    if (message.type === "getOutbox") return listRecords();
    if (message.type === "retryOutboxItem") {
      return retryRecord(message.id).then(() => flushOutbox(true));
    }
    if (message.type === "removeOutboxItem") {
      return remove(message.id).then(() => ({ ok: true }));
    }
    if (message.type === "retryAllOutbox") {
      return retryAllRecords().then(() => flushOutbox(true));
    }
    if (message.type === "pairDevice") {
      return (async () => {
        const serverUrl = normalizedServerUrl(packagedServerOrigin());
        const response = await fetch(`${serverUrl}/api/v1/devices/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: message.code,
            kind: message.kind,
          }),
        });
        const payload = (await response.json()) as {
          deviceId?: string;
          token?: string;
          name?: string;
          error?: string;
        };
        if (!response.ok || !payload.deviceId || !payload.token) {
          throw new Error(payload.error ?? "设备配对失败");
        }
        await writeAuthState({
          serverUrl,
          deviceId: payload.deviceId,
          deviceToken: payload.token,
          deviceName: payload.name ?? "Chrome",
        });
        await browser.storage.local.set({ authRevoked: false });
        await retryAllRecords();
        await flushOutbox();
        return { ok: true, deviceId: payload.deviceId };
      })();
    }
    return undefined;
  });

  void (async () => {
    const packagedUrl = normalizedServerUrl(packagedServerOrigin());
    const settings = (await readAuthState()) as Partial<AuthStorage>;
    if (settings.deviceToken && settings.serverUrl) {
      let storedUrl = "";
      try {
        storedUrl = normalizedServerUrl(settings.serverUrl);
      } catch {
        // A malformed legacy address is treated as a server change.
      }
      if (storedUrl !== packagedUrl) {
        await clearAuthState();
        await setStatus({
          status: "failed",
          message: "归档服务地址已更新，请使用新的配对码重新配对",
          updatedAt: new Date().toISOString(),
        });
        return;
      }
    } else if (settings.deviceToken) {
      await writeAuthState({
        serverUrl: packagedUrl,
        deviceId: settings.deviceId ?? "",
        deviceToken: settings.deviceToken,
        deviceName: settings.deviceName ?? "Chrome",
      });
    }
    await flushOutbox();
  })();
});
