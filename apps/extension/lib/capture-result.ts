import type { CapturePayloadV1 } from "@ai-archive/contracts";

export interface CaptureReceipt {
  revisionId?: string;
  messageCount?: number;
  completeness?: "complete" | "partial";
  baselineContentHash?: string;
  archiveMessageCount?: number;
  archiveCompleteness?: "complete" | "partial";
}

/** Display the archive result without changing the receipt used for append baselines. */
export function fullCaptureResult(snapshot: CapturePayloadV1, receipt?: CaptureReceipt) {
  const delta = "appendedMessages" in snapshot;
  const sourceStatus = delta ? "complete" : snapshot.completeness.status;
  const messageCount = receipt?.messageCount ?? (delta
    ? snapshot.baseMessageCount + snapshot.appendedMessages.length : snapshot.messages.length);
  if (!receipt) return {
    status: "queued" as const, messageCount,
    message: `${messageCount} 条消息已保存到本地队列，等待上传`,
  };
  const archiveComplete = receipt.archiveCompleteness === "complete";
  const status = archiveComplete ? "complete" : receipt.completeness ?? sourceStatus;
  const reason = status === "partial" && sourceStatus === "complete"
    ? "当前页面已完整采集；累计归档含历史差异，需要核对"
    : (!delta && snapshot.completeness.reason) || "历史可能尚未加载完整";
  return {
    status, messageCount,
    ...(status === "partial" ? { incompleteReason: reason } : {}),
    ...(receipt.archiveMessageCount !== undefined ? { archiveMessageCount: receipt.archiveMessageCount } : {}),
    ...(receipt.archiveCompleteness ? { archiveCompleteness: receipt.archiveCompleteness } : {}),
    message: receipt.archiveMessageCount !== undefined
      ? `本次保存 ${messageCount} 条消息，累计归档 ${receipt.archiveMessageCount} 条${archiveComplete ? "（完整）" : ""}${status === "partial" ? `；${reason}` : ""}`
      : archiveComplete ? `本次保存 ${messageCount} 条消息，累计归档已确认完整`
      : status === "complete" ? `${messageCount} 条消息已完整归档` : `已保存 ${messageCount} 条消息；${reason}`,
  };
}
