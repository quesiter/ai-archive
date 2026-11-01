import ExcelJS from "exceljs";
import type { CaptureMessage } from "@ai-archive/contracts";
import type { SourceReview } from "../src/schema.js";
import { sourceReviewBodyHash } from "../src/services/source-review.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], loadArchive: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { select: () => {
  const query = {
    from: () => query, leftJoin: () => query, where: () => query, limit: () => query, orderBy: () => query,
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(mocks.rows.shift() ?? []).then(resolve, reject),
  };
  return query;
} } }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCurrentConversationArchive: mocks.loadArchive }));

import {
  exportableMessageContent,
  createConversationTextExport,
  createConversationXlsxExport,
  loadConversationExportData,
  renderConversationCsv,
  renderConversationMarkdown,
  renderConversationXlsx,
  renderConversationXlsxStream,
  safeExportUrl,
  type ConversationExportData,
} from "../src/services/conversation-export.js";

beforeEach(() => { mocks.rows.length = 0; mocks.loadArchive.mockReset(); });

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

  it("exports real repeated turns while hiding metadata-only and duplicate alternate bodies", async () => {
    const capturedAt = new Date("2026-09-14T01:00:00Z");
    const storedBody = { role: "assistant", segments: [{ type: "code", content: "line one\nline two", language: "ts" }] };
    const alternate = { ordinal: 9, role: "assistant", segments: [{ type: "text", content: "Different earlier answer" }] };
    const archive = { revision: { id: "fixed-revision", capturedAt, mergeEvidence: { warnings: [], variants: [
      { ...storedBody, ordinal: 0, model: "other-model", createdAt: "2026-09-14T02:00:00Z",
        segments: [{ type: "code", content: "line one\r\nline two", language: "ts" }] },
      alternate,
      { ...alternate, model: "another-model", createdAt: "2026-09-14T03:00:00Z" },
      { ...storedBody, ordinal: 0, segments: [{ type: "code", content: "line one\nline two", language: "js" }] },
    ] } }, messages: [
      { ...storedBody, id: "turn-one", ordinal: 0, sourceCreatedAt: capturedAt },
      { ...storedBody, id: "turn-two", ordinal: 1, sourceCreatedAt: capturedAt },
    ] };
    const before = JSON.stringify(archive);
    mocks.rows.push([{ id: "conversation", title: "Test", provider: "codex", externalSessionId: "session", canonicalUrl: null, projectName: null }],
      [{ id: "fixed-revision", conversationId: "conversation", capturedAt }]);
    mocks.loadArchive.mockResolvedValue(archive);
    const result = await loadConversationExportData({ conversationId: "conversation" });
    expect(result?.rows).toHaveLength(4);
    expect(result?.rows.slice(0, 2).map(row => row.messageOrdinal)).toEqual([0, 1]);
    expect(result?.rows[0]?.content).toBe(result?.rows[1]?.content);
    const alternatives = result!.rows.filter(row => row.content.startsWith("[其他采集内容"));
    expect(alternatives).toHaveLength(2);
    expect(alternatives.filter(row => row.content.includes("Different earlier answer"))).toHaveLength(1);
    expect(alternatives.filter(row => row.content.includes("line one"))).toHaveLength(1);
    expect(JSON.stringify(archive)).toBe(before);
  });
});

function sourceReviewedFixture() {
  const capturedAt = new Date("2026-09-14T01:00:00Z");
  const messageId = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
  const original: CaptureMessage[] = Array.from({ length: 43 }, (_, ordinal) => ({
    ordinal, externalMessageId: messageId(ordinal), role: ordinal % 2 ? "assistant" : "user",
    createdAt: "2026-09-13T23:00:00.000Z", model: ordinal % 2 ? "observed-model" : "",
    segments: [{ type: "text", content: `Original message ${ordinal}` }],
  }));
  original[0]!.segments[0]!.content = "Original user request with TABLE: preserved attachment preview";
  original[1]!.segments[0]!.content = "Original assistant answer with MAP: preserved display labels";
  original[42]!.segments[0]!.content = "Earlier edited user request";
  const selectedUser = { ...original[0]!, segments: [{ type: "text" as const, content: "Reviewed user request" }] };
  const selectedAssistant = { ...original[1]!, segments: [{ type: "text" as const, content: "Reviewed assistant answer" }] };
  const variants: CaptureMessage[] = [selectedUser, selectedAssistant,
    { ...original[5]!, segments: [{ type: "text", content: "Preserved partial rendered fragment" }] },
    { ...selectedAssistant, model: "another-observed-model", createdAt: "2026-09-14T02:00:00.000Z" },
    { ...original[3]!, segments: [{ type: "text", content: "Preserved reviewed wording" }] },
    { ...original[42]!, segments: [{ type: "text", content: "Earlier edited user wording variant" }] },
  ];
  const selected = original.slice(0, 42).map((message, index) => index === 0 ? selectedUser : index === 1 ? selectedAssistant : message);
  const reference = (message: CaptureMessage) => ({ messageId: message.externalMessageId!, bodyHash: sourceReviewBodyHash(message) });
  const review: SourceReview = {
    version: 1, source: "chatgpt_source_ui", sessionId: "reviewed-session", verifiedAt: "2026-09-14T02:00:00.000Z",
    sourceUrl: "https://chatgpt.com/c/reviewed-session", currentMessageIds: selected.map(message => message.externalMessageId!),
    inactiveMessages: [{ messageId: messageId(42), replacedByMessageId: messageId(40) }], selectedBodies: selected.map(reference),
    reviewedBodies: [
      { ...reference(original[0]!), kind: "attachment_preview" },
      { ...reference(original[1]!), kind: "map_rendering" },
      { ...reference(original[42]!), kind: "source_text" },
      { ...reference(variants[2]!), kind: "partial_rendering" },
      { ...reference(variants[4]!), kind: "source_text" },
      { ...reference(variants[5]!), kind: "source_text" },
    ],
  };
  const archive = {
    revision: { id: "reviewed-revision", capturedAt, contentIntegrityHash: "a".repeat(64),
      mergeEvidence: { variants, warnings: [], sourceReview: review as SourceReview | undefined } },
    messages: original.map((message) => ({ ...message, id: `physical-${message.ordinal}`, createdAt: capturedAt,
      sourceCreatedAt: new Date(message.createdAt!) })),
  };
  const enqueueScope = () => {
    mocks.rows.push([{ id: "reviewed-conversation", title: "Reviewed conversation", provider: "chatgpt",
      externalSessionId: "reviewed-session", canonicalUrl: review.sourceUrl, projectName: null }],
    [{ id: "reviewed-revision", conversationId: "reviewed-conversation", capturedAt }]);
    mocks.loadArchive.mockResolvedValue(archive);
  };
  return { original, variants, selected, archive, enqueueScope };
}

async function streamBuffer(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("source-reviewed conversation export", () => {
  it("exports the reviewed 42-message transcript and preserves every original observation with provenance", async () => {
    const fixture = sourceReviewedFixture();
    const before = JSON.stringify(fixture.archive);
    fixture.enqueueScope();
    const result = (await loadConversationExportData({ conversationId: "reviewed-conversation" }))!;
    const main = result.rows.filter(row => !row.recordType);
    const records = result.rows.filter(row => row.recordType);
    expect(main).toHaveLength(42);
    expect(main.map(row => row.messageOrdinal)).toEqual(Array.from({ length: 42 }, (_, index) => index));
    expect(main[0]!.content).toBe("Reviewed user request");
    expect(main[1]!.content).toBe("Reviewed assistant answer");
    expect(main.some(row => row.content.includes("Earlier edited"))).toBe(false);
    expect(result.rows).toHaveLength(fixture.original.length + fixture.variants.length);
    expect(records.filter(row => row.recordType === "reviewed_edit")).toHaveLength(2);
    expect(records.filter(row => row.recordType === "reviewed_observation")).toHaveLength(5);
    for (const observation of [...fixture.original, ...fixture.variants]) {
      expect(result.rows.some(row => row.content.includes(observation.segments[0]!.content))).toBe(true);
    }
    for (const original of [fixture.original[0]!, fixture.original[1]!, fixture.original[42]!]) {
      expect(records.some(row => row.content.includes(sourceReviewBodyHash(original)))).toBe(true);
    }
    expect(records.every(row => row.content.includes(`原归档哈希 ${"a".repeat(64)}`))).toBe(true);
    expect(records.some(row => row.content.includes("附件/表格预览") && row.content.includes("TABLE:"))).toBe(true);
    expect(records.some(row => row.content.includes("地图显示内容") && row.content.includes("MAP:"))).toBe(true);
    expect(records.some(row => row.model === "another-observed-model" && row.messageAt === "2026-09-14T02:00:00.000Z")).toBe(true);
    expect(JSON.stringify(fixture.archive)).toBe(before);
  });

  it("labels a newly observed unreviewed body without silently accepting the earlier review for it", async () => {
    const fixture = sourceReviewedFixture();
    fixture.variants.push({ ...fixture.original[12]!, segments: [{ type: "text", content: "A new unreviewed wording" }] });
    fixture.enqueueScope();
    const result = (await loadConversationExportData({ conversationId: "reviewed-conversation" }))!;
    const row = result.rows.find(row => row.content.includes("A new unreviewed wording"));
    expect(row?.recordType).toBe("unreviewed_observation");
    expect(row?.content).toContain("未核对差异");
    expect(row?.content).toContain("非连续问答记录");
    expect(result.rows.filter(row => !row.recordType)).toHaveLength(42);
    expect(result.rows.some(row => row.content.includes("Earlier edited user request"))).toBe(true);
  });

  it("keeps the old export behavior when the source review is missing or invalid", async () => {
    const fixture = sourceReviewedFixture();
    const review = fixture.archive.revision.mergeEvidence.sourceReview!;
    fixture.archive.revision.mergeEvidence.sourceReview = undefined;
    fixture.enqueueScope();
    const ordinary = (await loadConversationExportData({ conversationId: "reviewed-conversation" }))!;
    fixture.archive.revision.mergeEvidence.sourceReview = { ...review, sessionId: "wrong-session" };
    fixture.enqueueScope();
    const invalid = (await loadConversationExportData({ conversationId: "reviewed-conversation" }))!;
    expect(invalid.rows).toEqual(ordinary.rows);
    expect(ordinary.rows.every(row => row.recordType === undefined)).toBe(true);
    expect(ordinary.rows.filter(row => !row.content.startsWith("[其他采集内容"))).toHaveLength(43);
    expect(ordinary.rows[0]!.content).toContain("TABLE:");
  });

  it.each(["csv", "md", "xlsx"] as const)("uses the same reviewed rows in streaming %s exports", async (format) => {
    const fixture = sourceReviewedFixture();
    fixture.enqueueScope();
    const exported = format === "xlsx"
      ? await createConversationXlsxExport({ conversationId: "reviewed-conversation" })
      : await createConversationTextExport({ conversationId: "reviewed-conversation" }, format);
    const buffer = await streamBuffer(exported!.stream);
    let contents: string;
    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
      const sheet = workbook.getWorksheet("对话记录")!;
      expect(sheet.rowCount).toBe(50);
      expect(sheet.getCell("K2").value).toBe("Reviewed user request");
      contents = sheet.getColumn("K").values.map(value => String(value ?? "")).join("\n");
    } else contents = buffer.toString("utf8");
    expect(contents).toContain("Reviewed user request");
    expect(contents).toContain("编辑前消息（已核对）");
    expect(contents).toContain("已核对的展示/预览记录");
    expect(contents).toContain("TABLE: preserved attachment preview");
    expect(contents).toContain("MAP: preserved display labels");
    expect(contents).toContain("Earlier edited user request");
    expect(contents).toContain(sourceReviewBodyHash(fixture.original[42]!));
    if (format === "md") {
      expect(contents).toContain("### 原始采集观察（非连续问答）");
      expect(contents.indexOf("### 原始采集观察")).toBeGreaterThan(contents.indexOf("### observed-model · #41"));
      expect(contents).toContain("#### 编辑前消息（已核对）");
    }
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
