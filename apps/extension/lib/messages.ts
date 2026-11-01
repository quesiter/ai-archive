import type { CapturePayloadV1, DeviceKind } from "@ai-archive/contracts";
import type { NativeConversationReadDiagnostic } from "./native-conversation";

export type ExtensionMessage =
  | { type: "enqueueCapture"; payload: CapturePayloadV1; batch?: { itemId: string; operationId: string } }
  | { type: "startBatchCapture"; operationId: string; itemId: string; sessionId: string }
  | { type: "getBatchCaptureState"; operationId: string }
  | { type: "cancelBatchCapture"; operationId: string }
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
  archiveMessageCount?: number;
  archiveCompleteness?: "complete" | "partial";
  outboxCount?: number;
  message?: string;
  incompleteReason?: string;
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
  lastManualCapture?: CaptureUiState;
  nativeReadDiagnostic?: NativeConversationReadDiagnostic & { updatedAt: string };
  authRevoked?: boolean;
  batchStatus?: { message: string; jobId?: string; updatedAt: string };
}
