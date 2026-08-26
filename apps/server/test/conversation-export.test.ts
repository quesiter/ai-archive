import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  exportableMessageContent,
  renderConversationCsv,
  renderConversationMarkdown,
  renderConversationXlsx,
  renderConversationXlsxStream,
  safeExportUrl,
  type ConversationExportData,
} from "../src/services/conversation-export.js";

const data: ConversationExportData = {
  scope: "conversation",
  scopeId: "conversation-1",
  scopeName: "导出测试",
  generatedAt: "2026-08-17T08:00:00.000Z",
  rows: [
    {
      projectName: "项目 A",
      conversationId: "conversation-1",
      conversationTitle: "导出测试",
      provider: "codex",
      externalSessionId: "session-1",
      canonicalUrl: "",
      revisionId: "revision-1",
      capturedAt: "2026-08-17T07:00:00.000Z",
      messageOrdinal: 0,
      role: "user",
      model: "",
      messageAt: "",
      content: "真正的用户需求",
    },
  ],
};

describe("conversation export filtering", () => {
  it("removes internal envelopes and all tool/reasoning segments", () => {
    const content = exportableMessageContent({
      role: "user",
      segments: [
        {
          type: "text",
          content:
            "<recommended_plugins>secret plugin list</recommended_plugins>\n" +
            "<environment_context><cwd>/repo</cwd></environment_context>\n" +
            "真正的用户需求",
        },
        { type: "tool_status", content: "tool invocation" },
        { type: "reasoning", content: "private reasoning" },
      ],
    });
    expect(content).toBe("真正的用户需求");
    expect(content).not.toContain("recommended_plugins");
    expect(content).not.toContain("tool invocation");
    expect(content).not.toContain("private reasoning");
  });

  it("excludes system and tool messages", () => {
    expect(
      exportableMessageContent({
        role: "tool",
        segments: [{ type: "text", content: "must not export" }],
      }),
    ).toBe("");
    expect(
      exportableMessageContent({
        role: "system",
        segments: [{ type: "text", content: "must not export" }],
      }),
    ).toBe("");
  });

  it("drops unsafe or malformed links from legacy rows", () => {
    expect(safeExportUrl("javascript:alert(1)")).toBe("");
    expect(safeExportUrl("file:///etc/passwd")).toBe("");
    expect(safeExportUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(
      exportableMessageContent({
        role: "assistant",
        segments: [
          { type: "citation", content: "不安全引用", href: "javascript:alert(1)" },
        ],
      }),
    ).toBe("不安全引用");
  });
});

describe("conversation export formats", () => {
  it("renders UTF-8 CSV and Markdown", () => {
    const csv = renderConversationCsv(data).toString("utf8");
    const markdown = renderConversationMarkdown(data).toString("utf8");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("真正的用户需求");
    expect(markdown).toContain("# 会话：导出测试");
    expect(markdown).toContain("真正的用户需求");
  });

  it("creates a readable XLSX workbook", async () => {
    const buffer = await renderConversationXlsx(data);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer);
    const worksheet = workbook.getWorksheet("对话记录");
    expect(worksheet?.getCell("K2").value).toBe("真正的用户需求");
  });

  it("streams XLSX rows from an async source", async () => {
    async function* rows() {
      yield data.rows[0]!;
      await Promise.resolve();
      yield { ...data.rows[0]!, messageOrdinal: 1, content: "流式导出内容" };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of renderConversationXlsxStream({
      generatedAt: data.generatedAt,
      rows: rows(),
    })) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer);
    const worksheet = workbook.getWorksheet("对话记录");
    expect(worksheet?.getCell("K2").value).toBe("真正的用户需求");
    expect(worksheet?.getCell("K3").value).toBe("流式导出内容");
  });
});
