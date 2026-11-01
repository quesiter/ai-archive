import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredResponseDiagnostic } from "../src/services/llm.js";

vi.mock("../src/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

vi.mock("../src/services/redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/redaction.js")>();
  return {
    ...actual,
    redactForCloud: vi.fn(actual.redactForCloud),
    loadEnabledCustomRedactionRules: vi.fn(actual.loadEnabledCustomRedactionRules),
  };
});

import { loadEnabledCustomRedactionRules, redactForCloud } from "../src/services/redaction.js";
import {
  MAX_REPORT_DIAGNOSTIC_CHARS,
  prepareReportDiagnostic,
} from "../src/services/report-diagnostics.js";

function diagnostic(content: string, overrides: Partial<StructuredResponseDiagnostic> = {}): StructuredResponseDiagnostic {
  return {
    attempt: 2,
    model: "report-model",
    responseId: "completion-123",
    requestId: "request-456",
    finishReason: "stop",
    usage: { promptTokens: 2_000, completionTokens: 300, totalTokens: 2_300 },
    content,
    responseChars: content.length,
    status: "accepted",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("report response diagnostic storage preparation", () => {
  it("redacts real credentials, connection URLs, private keys and cloud-private text", async () => {
    const content = [
      "本周完成发布。",
      "密钥 sk-diagnosticDemo12345678901234567890",
      "postgresql://archive:DatabaseDemoSecret@db.example.com/archive",
      "https://demo:BrowserDemoSecret@example.com/private",
      "password=PasswordDemoSecret",
      "192.0.2.50:2288\ndemo/HostDemoSecret123",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nPrivateKeyDemoMaterial\n-----END OPENSSH PRIVATE KEY-----",
      "联系 13800138000 或 person@example.com。",
    ].join("\n");
    const input = diagnostic(content);
    const saved = await prepareReportDiagnostic(input);

    expect(redactForCloud).toHaveBeenCalledWith(content);
    expect(saved.content).toContain("本周完成发布。");
    for (const secret of [
      "sk-diagnosticDemo12345678901234567890", "DatabaseDemoSecret", "BrowserDemoSecret",
      "PasswordDemoSecret", "HostDemoSecret123", "PrivateKeyDemoMaterial", "13800138000", "person@example.com",
    ]) {
      expect(JSON.stringify(saved)).not.toContain(secret);
    }
    expect(saved.contentTruncated).toBe(false);
    expect(input.content).toBe(content);
  });

  it("applies log redaction after the cloud redactor returns", async () => {
    vi.mocked(redactForCloud).mockResolvedValueOnce({
      text: "云端脱敏后的内容\nBearer LogLayerDemoSecret123\npostgresql://user:LogDatabaseSecret@db/archive",
      replacements: 1,
    });
    const saved = await prepareReportDiagnostic(diagnostic("原始响应"));
    expect(redactForCloud).toHaveBeenCalledWith("原始响应");
    expect(saved.content).toBe("云端脱敏后的内容\nBearer [REDACTED]\n[DATABASE_URL]");
  });

  it("preserves raw response length, generation metadata, finish reason and token usage", async () => {
    const content = "已返回：password=LongPasswordToRedact12345";
    const input = diagnostic(content, { status: "rejected", finishReason: "length", error: "正文缺少必需章节" });
    const saved = await prepareReportDiagnostic(input);
    expect(saved).toMatchObject({
      attempt: 2,
      model: "report-model",
      responseId: "completion-123",
      requestId: "request-456",
      status: "rejected",
      finishReason: "length",
      usage: { promptTokens: 2_000, completionTokens: 300, totalTokens: 2_300 },
      responseChars: content.length,
      error: "正文缺少必需章节",
      contentTruncated: false,
    });
    expect(saved.content.length).not.toBe(saved.responseChars);
    expect(Number.isFinite(Date.parse(saved.recordedAt))).toBe(true);
  });

  it("sanitizes provider-controlled metadata and diagnostic errors", async () => {
    const saved = await prepareReportDiagnostic(diagnostic("已返回正文", {
      model: "report-model password=ModelMetadataSecret",
      responseId: "completion api_key=ResponseMetadataSecret",
      requestId: "request token=RequestMetadataSecret",
      error: "postgresql://user:ErrorDatabaseSecret@db/archive; Bearer ErrorBearerSecret12345",
      status: "request_failed",
    }));
    for (const secret of ["ModelMetadataSecret", "ResponseMetadataSecret", "RequestMetadataSecret", "ErrorDatabaseSecret", "ErrorBearerSecret12345"]) {
      expect(JSON.stringify(saved)).not.toContain(secret);
    }
    expect(saved.model).toContain("report-model");
  });

  it("retains both ends of oversized responses and marks omitted middle content", async () => {
    const content = `HEAD_MARKER\n${"甲".repeat(95_000)}\nMIDDLE_MARKER_MUST_BE_OMITTED\n${"乙".repeat(40_000)}\nTAIL_MARKER`;
    const saved = await prepareReportDiagnostic(diagnostic(content));
    expect(saved.contentTruncated).toBe(true);
    expect(saved.content.startsWith("HEAD_MARKER")).toBe(true);
    expect(saved.content.endsWith("TAIL_MARKER")).toBe(true);
    expect(saved.content).not.toContain("MIDDLE_MARKER_MUST_BE_OMITTED");
    expect(saved.content).toContain("诊断响应过长，中间部分已省略");
    expect(saved.content.length).toBeLessThanOrEqual(MAX_REPORT_DIAGNOSTIC_CHARS + 100);
    expect(saved.responseChars).toBe(content.length);
  });

  it("redacts complete sensitive blocks before applying any length bound", async () => {
    const content = `HEAD\n-----BEGIN OPENSSH PRIVATE KEY-----\n${"PrivateMaterial".repeat(10_000)}\n-----END OPENSSH PRIVATE KEY-----\nTAIL`;
    expect(content.length).toBeGreaterThan(MAX_REPORT_DIAGNOSTIC_CHARS);
    const saved = await prepareReportDiagnostic(diagnostic(content));
    expect(saved.content).toBe("HEAD\n[PRIVATE_KEY]\nTAIL");
    expect(saved.contentTruncated).toBe(false);
    expect(saved.responseChars).toBe(content.length);
  });

  it("does not fall back to raw content when cloud redaction fails", async () => {
    vi.mocked(redactForCloud).mockRejectedValueOnce(new Error("Redaction settings unavailable"));
    await expect(prepareReportDiagnostic(diagnostic("password=DoNotStoreRawFallback")))
      .rejects.toThrow("Redaction settings unavailable");
  });

  it("redacts host credentials embedded in a JSON response with escaped newlines", async () => {
    const content = JSON.stringify({
      title: "周报",
      summary: "配置已完成。",
      bodyMarkdown: "## 部署\n192.0.2.50:2288\ndemo/EscapedNewlineHostSecret123\n连接检查完成。",
    });
    const saved = await prepareReportDiagnostic(diagnostic(content));
    expect(JSON.stringify(saved)).not.toContain("EscapedNewlineHostSecret123");
    expect(saved.responseChars).toBe(content.length);
  });

  it("redacts closed JSON strings inside fenced or malformed responses", async () => {
    const json = JSON.stringify({ bodyMarkdown: "192.0.2.50:2288\ndemo/FencedHostSecret123" });
    for (const content of [`回复如下：\n\`\`\`json\n${json}\n\`\`\``, json.slice(0, -1)]) {
      const saved = await prepareReportDiagnostic(diagnostic(content));
      expect(saved.content).not.toContain("FencedHostSecret123");
      expect(saved.content).toContain("[SSH_LOGIN]");
    }
  });

  it("decodes unicode-escaped credentials before redacting", async () => {
    const content = '{"bodyMarkdown":"\\u0070assword=UnicodeEscapedSecret123"}';
    const saved = await prepareReportDiagnostic(diagnostic(content));
    expect(saved.content).not.toContain("UnicodeEscapedSecret123");
    expect(saved.content).toContain("[REDACTED]");
  });

  it("redacts decoded JSON string values with custom rules loaded once for all fields", async () => {
    vi.mocked(loadEnabledCustomRedactionRules).mockResolvedValueOnce([
      { pattern: /Custom\s+Confidential\d+/g, replacement: "[CUSTOM_REDACTED]" },
    ]);
    const content = JSON.stringify({
      title: "Custom\nConfidential123",
      summary: "Custom\nConfidential456",
      bodyMarkdown: "Custom\nConfidential789",
    });
    const saved = await prepareReportDiagnostic(diagnostic(content));
    expect(loadEnabledCustomRedactionRules).toHaveBeenCalledTimes(1);
    expect(redactForCloud).toHaveBeenCalledTimes(1);
    expect(saved.content).not.toContain("Confidential");
    expect(saved.content.match(/CUSTOM_REDACTED/g)).toHaveLength(3);
  });

  it("preserves safe JSON syntax, fields and escaped content", async () => {
    const value = { title: "周报", bodyMarkdown: '## 本周主要讨论\n修复“导出”按钮，支持 "Markdown" 与 C:\\Work。' };
    const saved = await prepareReportDiagnostic(diagnostic(JSON.stringify(value)));
    expect(JSON.parse(saved.content)).toEqual(value);
  });

  it("handles a truncated string with many escaped quotes while retaining the response", async () => {
    const content = '{"bodyMarkdown":"' + '\\"quote\\" '.repeat(15_000);
    const saved = await prepareReportDiagnostic(diagnostic(content, { status: "rejected", finishReason: "length" }));
    expect(saved.content.startsWith('{"bodyMarkdown":"')).toBe(true);
    expect(saved.contentTruncated).toBe(true);
    expect(saved.finishReason).toBe("length");
    expect(saved.responseChars).toBe(content.length);
  });
});
