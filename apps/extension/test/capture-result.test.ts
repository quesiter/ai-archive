import { describe, expect, it } from "vitest";
import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { fullCaptureResult } from "../lib/capture-result";

const snapshot = {
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: [{ ordinal: 0, role: "user", segments: [{ type: "text", content: "Question" }] }],
} as CaptureSnapshotV1;

describe("full capture receipt", () => {
  it.each(["partial", "complete"] as const)("reports the complete archive without asking to recapture a %s source observation", (sourceStatus) => {
    const source = { ...snapshot, completeness: { ...snapshot.completeness, status: sourceStatus, reason: "未能确认首轮" } };
    const receipt = Object.freeze({ completeness: "partial" as const, messageCount: 30, archiveMessageCount: 40, archiveCompleteness: "complete" as const });
    const before = JSON.stringify({ source, receipt });
    const result = fullCaptureResult(source, receipt);
    expect(result).toMatchObject({ status: "complete", messageCount: 30, archiveMessageCount: 40, archiveCompleteness: "complete" });
    expect(result.message).toBe("本次保存 30 条消息，累计归档 40 条（完整）");
    expect(result.message).not.toMatch(/重新完整采集|未能确认首轮|30 条消息已完整归档/);
    expect(result).not.toHaveProperty("baselineContentHash");
    expect(JSON.stringify({ source, receipt })).toBe(before);
  });
  it("does not substitute the source count when the complete archive count is unavailable", () => {
    const result = fullCaptureResult(snapshot, { completeness: "partial", messageCount: 7, archiveCompleteness: "complete" });
    expect(result.status).toBe("complete");
    expect(result.message).toBe("本次保存 7 条消息，累计归档已确认完整");
  });
  it("does not call a queued snapshot archived", () => {
    expect(fullCaptureResult(snapshot).status).toBe("queued");
  });
  it("shows the server's incomplete verdict instead of the collector's complete claim", () => {
    const result = fullCaptureResult(snapshot, { completeness: "partial", messageCount: 29 });
    expect(result).toMatchObject({ status: "partial", messageCount: 29 });
    expect(result.message).toContain("累计归档含历史差异，需要核对");
    expect(result.message).not.toContain("重新完整采集");
    expect(result.message).not.toContain("历史片段缺失");
    expect(result.message).not.toContain("已完整归档");
  });
  it("preserves the page explanation for a known partial capture", () => {
    const result = fullCaptureResult({ ...snapshot, completeness: { ...snapshot.completeness, status: "partial", reason: "页面中间的消息尚未加载" } }, { completeness: "partial" });
    expect(result.message).toContain("页面中间的消息尚未加载");
    expect(result).toMatchObject({ incompleteReason: "页面中间的消息尚未加载" });
  });
});
