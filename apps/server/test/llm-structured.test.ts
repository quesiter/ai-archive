import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

vi.mock("../src/services/settings.js", () => ({
  getSetting: async (key: string) => ({
    "llm.baseUrl": "https://llm.example.test/v1",
    "llm.apiKey": "configured-secret-key",
    "llm.model": "configured-model",
  })[key],
  getBooleanSetting: async () => false,
  getNumberSetting: async () => 0,
}));

vi.mock("../src/services/network-target.js", () => ({
  withPinnedNetworkDispatcher: async (_url: string, run: (dispatcher: unknown) => unknown) => run({}),
}));

import {
  completeStructured,
  StructuredResponseDiagnosticError,
  type StructuredResponseDiagnostic,
} from "../src/services/llm.js";

const schema = z.object({
  bodyMarkdown: z.string().min(80, "bodyMarkdown must include substantive report content"),
});
const fullReport = { bodyMarkdown: "Verified project progress and follow-up actions. ".repeat(6) };
const input = { system: "Generate a complete report as JSON.", user: "Original report materials", schema };

function response(content: string | null, finishReason = "stop") {
  return {
    id: "completion-123",
    _request_id: "request-456",
    model: "resolved-model",
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 120, completion_tokens: 90, total_tokens: 210 },
  };
}

beforeEach(() => {
  mocks.create.mockReset();
});

describe("completeStructured quality validation and diagnostics", () => {
  it("uses the report timeout without multiplying long requests through SDK retries", async () => {
    mocks.create.mockResolvedValue(response(JSON.stringify(fullReport)));
    await completeStructured({ ...input, timeoutMs: 480_000 });
    expect(mocks.create.mock.calls[0]![1]).toEqual({ timeout: 480_000, maxRetries: 0 });
  });
  it("retries an incomplete body with specific correction and records both raw responses", async () => {
    const placeholder = JSON.stringify({ bodyMarkdown: "...", ignoredField: "previous-output-only" });
    mocks.create
      .mockResolvedValueOnce(response(placeholder))
      .mockResolvedValueOnce(response(JSON.stringify(fullReport)));
    const diagnostics: StructuredResponseDiagnostic[] = [];

    await expect(completeStructured({ ...input, maxAttempts: 3, onDiagnostic: async (item) => { diagnostics.push(item); } }))
      .resolves.toEqual(fullReport);

    expect(mocks.create).toHaveBeenCalledTimes(2);
    const messages = mocks.create.mock.calls[1]![0].messages;
    expect(messages.slice(0, 2)).toEqual([
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ]);
    expect(messages[2].content).toContain("bodyMarkdown must include substantive report content");
    expect(JSON.stringify(messages)).not.toContain("previous-output-only");
    expect(diagnostics).toEqual([
      expect.objectContaining({ attempt: 1, status: "rejected", content: placeholder, responseChars: placeholder.length }),
      expect.objectContaining({ attempt: 2, status: "accepted", content: JSON.stringify(fullReport) }),
    ]);
  });

  it("keeps the default at one attempt and caps opted-in attempts at three", async () => {
    mocks.create.mockResolvedValue(response('{"bodyMarkdown":"..."}'));
    await expect(completeStructured(input)).rejects.toThrow("expected schema");
    expect(mocks.create).toHaveBeenCalledTimes(1);

    mocks.create.mockClear();
    const onDiagnostic = vi.fn();
    await expect(completeStructured({ ...input, maxAttempts: 20, onDiagnostic })).rejects.toThrow("expected schema");
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(onDiagnostic.mock.calls.map(([item]) => item.attempt)).toEqual([1, 2, 3]);
    expect(onDiagnostic.mock.calls.every(([item]) => item.status === "rejected")).toBe(true);
  });

  it.each(["length", "content_filter", "tool_calls"])("rejects a %s finish reason even when its JSON passes the schema", async (finishReason) => {
    mocks.create.mockResolvedValue(response(JSON.stringify(fullReport), finishReason));
    const onDiagnostic = vi.fn();
    await expect(completeStructured({ ...input, onDiagnostic })).rejects.toThrow(`finish_reason=${finishReason}`);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", finishReason }));
  });

  it.each([null, "   ", "This is not JSON"])("retries empty or invalid JSON content: %s", async (content) => {
    mocks.create.mockResolvedValueOnce(response(content)).mockResolvedValueOnce(response(JSON.stringify(fullReport)));
    const onDiagnostic = vi.fn();
    await expect(completeStructured({ ...input, maxAttempts: 3, onDiagnostic })).resolves.toEqual(fullReport);
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ status: "rejected", content: content ?? "" });
  });

  it("tries later JSON candidates after an example fails the schema", async () => {
    const content = `Example: \`\`\`json\n{"bodyMarkdown":"..."}\n\`\`\`\nComplete report: \`\`\`json\n${JSON.stringify(fullReport)}\n\`\`\``;
    mocks.create.mockResolvedValue(response(content));
    await expect(completeStructured(input)).resolves.toEqual(fullReport);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("diagnoses and retries an HTTP-success response with no completion message", async () => {
    mocks.create.mockResolvedValueOnce({ id: "malformed-envelope" }).mockResolvedValueOnce(response(JSON.stringify(fullReport)));
    const onDiagnostic = vi.fn();
    await expect(completeStructured({ ...input, maxAttempts: 3, onDiagnostic })).resolves.toEqual(fullReport);
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({
      attempt: 1, status: "rejected", responseId: "malformed-envelope", content: "", error: "Model returned an empty response",
    });
  });

  it("never accepts schema-valid JSON examples from reasoning blocks", async () => {
    const content = `<reasoning>Example: \`\`\`json\n${JSON.stringify(fullReport)}\n\`\`\`</reasoning>\n{"bodyMarkdown":"..."}`;
    mocks.create.mockResolvedValue(response(content));
    await expect(completeStructured(input)).rejects.toThrow("expected schema");
  });

  it.each([401, 403, 429])("preserves HTTP %s errors without a quality retry or response_format fallback", async (status) => {
    const error = Object.assign(new Error("response_format unsupported with configured-secret-key"), {
      status,
      request_id: "failed-request-789",
      headers: { Authorization: "Bearer configured-secret-key" },
    });
    mocks.create.mockRejectedValue(error);
    const onDiagnostic = vi.fn();

    await expect(completeStructured({ ...input, maxAttempts: 3, onDiagnostic })).rejects.toBe(error);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      model: "configured-model",
      requestId: "failed-request-789",
      status: "request_failed",
      content: "",
      responseChars: 0,
      error: expect.stringContaining(`HTTP ${status}`),
    }));
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("configured-secret-key");
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("Authorization");
  });

  it("records provider response metadata and exact content before accepting", async () => {
    const content = `\n ${JSON.stringify(fullReport)} \n`;
    mocks.create.mockResolvedValue(response(content));
    const onDiagnostic = vi.fn();
    await completeStructured({ ...input, onDiagnostic });
    expect(onDiagnostic).toHaveBeenCalledWith({
      attempt: 1,
      model: "resolved-model",
      responseId: "completion-123",
      requestId: "request-456",
      finishReason: "stop",
      usage: { promptTokens: 120, completionTokens: 90, totalTokens: 210 },
      content,
      responseChars: content.length,
      status: "accepted",
    });
  });

  it("records response_format fallback failures and does not reintroduce the unsupported option on retry", async () => {
    const unsupported = Object.assign(new Error("response_format json_object unsupported"), { status: 400 });
    mocks.create
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce(response('{"bodyMarkdown":"..."}'))
      .mockResolvedValueOnce(response(JSON.stringify(fullReport)));
    const onDiagnostic = vi.fn();
    await expect(completeStructured({ ...input, maxAttempts: 3, onDiagnostic })).resolves.toEqual(fullReport);
    expect(mocks.create.mock.calls[0]![0]).toHaveProperty("response_format");
    expect(mocks.create.mock.calls[1]![0]).not.toHaveProperty("response_format");
    expect(mocks.create.mock.calls[2]![0]).not.toHaveProperty("response_format");
    expect(onDiagnostic.mock.calls.map(([item]) => [item.attempt, item.status])).toEqual([
      [1, "request_failed"], [1, "rejected"], [2, "accepted"],
    ]);
  });

  it("records a failing fallback request and preserves that error", async () => {
    const unavailable = Object.assign(new Error("upstream unavailable"), { status: 503 });
    mocks.create
      .mockRejectedValueOnce(new Error("response_format unsupported"))
      .mockRejectedValueOnce(unavailable);
    const onDiagnostic = vi.fn();
    await expect(completeStructured({ ...input, maxAttempts: 3, onDiagnostic })).rejects.toBe(unavailable);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(onDiagnostic.mock.calls.map(([item]) => item.status)).toEqual(["request_failed", "request_failed"]);
  });

  it.each(["accepted", "rejected", "request_failed"])("surfaces a diagnostic write failure for %s without a model quality retry", async (status) => {
    if (status === "request_failed") mocks.create.mockRejectedValue(new Error("response_format unsupported"));
    else mocks.create.mockResolvedValue(response(JSON.stringify(status === "accepted" ? fullReport : { bodyMarkdown: "..." })));
    const storageError = new Error("diagnostic database unavailable");
    const onDiagnostic = vi.fn(async () => { throw storageError; });
    const completion = completeStructured({ ...input, maxAttempts: 3, onDiagnostic });
    await expect(completion).rejects.toBeInstanceOf(StructuredResponseDiagnosticError);
    await expect(completion).rejects.toMatchObject({ cause: storageError });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });
});
