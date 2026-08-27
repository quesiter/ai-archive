import type { CapturePayloadV1, DeviceKind } from "@ai-archive/contracts";

export type ExtensionMessage =
  | { type: "enqueueCapture"; payload: CapturePayloadV1 }
  | { type: "captureState"; state: CaptureUiState }
  | { type: "flushOutbox" }
  | { type: "getOutbox" }
  | { type: "retryOutboxItem"; id: string }
  | { type: "removeOutboxItem"; id: string }
  | { type: "retryAllOutbox" }
  | {
      type: "pairDevice";
      code: string;
      kind: DeviceKind;
    }
  | { type: "manualCapture" }
  | { type: "forceFullCapture"; reason: "incremental_base_mismatch" }
  | { type: "getContentState" };

export interface CaptureUiState {
  status:
    | "idle"
    | "scanning"
    | "checking"
    | "waiting"
    | "skipped"
    | "queued"
    | "syncing"
    | "complete"
    | "partial"
    | "failed";
  provider?: string;
  sessionId?: string;
  triggerReason?: string;
  captureMode?: "full" | "append" | "import";
  messageCount?: number;
  outboxCount?: number;
  message?: string;
  updatedAt: string;
}

export interface ExtensionSettings {
  serverUrl?: string;
  deviceId?: string;
  deviceToken?: string;
  deviceName?: string;
  pausedHosts?: Record<string, boolean>;
  showFloatingIndicator?: boolean;
  lastStatus?: CaptureUiState;
  authRevoked?: boolean;
}
