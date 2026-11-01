export type RecaptureItemStatus = "pending" | "running" | "complete" | "partial" | "failed" | "skipped";
export interface RecaptureItem {
  id: string;
  conversationId: string | null;
  sessionId: string;
  title: string;
  ordinal: number;
  status: RecaptureItemStatus;
  attempts: number;
  message: string | null;
  messageCount: number | null;
}
export interface RecaptureJob {
  id: string;
  deviceId: string;
  deviceName: string;
  status: "running" | "paused" | "completed" | "cancelled";
  message: string | null;
  lastRunnerSeenAt: string | null;
  createdAt: string;
  counts: Record<RecaptureItemStatus, number>;
  items: RecaptureItem[];
}
export interface RecaptureTask {
  jobId: string;
  itemId: string;
  leaseToken: string;
  sessionId: string;
  url: string;
  title: string;
  startedAt: string;
}
export interface RecaptureNext {
  job: { id: string; status: RecaptureJob["status"]; message: string | null } | null;
  task: RecaptureTask | null;
  busy?: boolean;
}
export interface RecaptureReport {
  jobId: string;
  itemId: string;
  leaseToken: string;
  captureId?: string | undefined;
  outcome?: "failed" | "attention" | "skipped" | undefined;
  message?: string | undefined;
}
