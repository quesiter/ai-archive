import { describe, expect, it } from "vitest";
import { extractJson } from "../src/services/llm.js";

describe("extractJson", () => {
  it("parses fenced JSON responses", () => {
    expect(extractJson("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
  });

  it("parses the first balanced JSON value from explanatory text", () => {
    expect(extractJson("结果如下：{\"suggestion\":{\"confidence\":\"80%\"}}，请查收")).toEqual({
      suggestion: { confidence: "80%" },
    });
  });

  it("skips reasoning blocks and keeps scanning after malformed braces", () => {
    expect(
      extractJson(
        '<think>candidate shape: {"suggestion": maybe later</think>\n{"suggestion":{"suggestedName":"food","confidence":0.71}}',
      ),
    ).toEqual({
      suggestion: { suggestedName: "food", confidence: 0.71 },
    });
  });

  it("finds a later JSON object when the first brace cannot be balanced", () => {
    expect(
      extractJson(
        'draft {not json\nfinal answer: {"statusUpdates":[],"report":{"title":"ok","summary":"ok","bodyMarkdown":"ok"}}',
      ),
    ).toEqual({
      statusUpdates: [],
      report: { title: "ok", summary: "ok", bodyMarkdown: "ok" },
    });
  });

  it("reports a useful excerpt when JSON is missing", () => {
    expect(() => extractJson("我认为应该归类到项目 A")).toThrow(
      /Model did not return valid JSON; response excerpt:/,
    );
  });
});
