import { describe, expect, it } from "vitest";
import {
  coarseProjectNameFromMaterial,
  fallbackSuggestedNameFromTitle,
  isLikelyOverSpecificProjectName,
  isRecoverableClassificationAiError,
  localProjectGuess,
  parseClassificationSuggestion,
  shouldReuseClassification,
} from "../src/services/analysis.js";

const projectRows = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "腾讯元宝采集",
    description: "",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    name: "OpenClaw 同步",
    description: "",
  },
];

describe("parseClassificationSuggestion", () => {
  it("accepts a top-level suggestion object and resolves project names", () => {
    const result = parseClassificationSuggestion(
      {
        existingProjectId: "腾讯元宝采集",
        confidence: "80%",
        rationale: "同一采集问题",
      },
      projectRows,
    );

    expect(result.existingProjectId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.confidence).toBe(0.8);
  });

  it("accepts string suggestions from OpenAI-compatible models", () => {
    const result = parseClassificationSuggestion(
      { suggestion: "OpenClaw 同步" },
      projectRows,
    );

    expect(result.suggestedName).toBe("OpenClaw 同步");
    expect(result.existingProjectId).toBe("22222222-2222-2222-2222-222222222222");
    expect(result.confidence).toBe(0.65);
  });

  it("keeps suggested names even when there is no existing project match", () => {
    const result = parseClassificationSuggestion(
      {
        suggestion: {
          suggested_project_name: "千问采集修复",
          score: 0.52,
        },
      },
      projectRows,
    );

    expect(result.suggestedName).toBe("千问采集修复");
    expect(result.existingProjectId).toBeNull();
    expect(result.confidence).toBe(0.52);
  });
});

describe("localProjectGuess", () => {
  it("assigns by project name in the conversation title without using AI", () => {
    const result = localProjectGuess(
      {
        title: "腾讯元宝采集仍然识别错误",
        text: "",
      },
      projectRows,
    );

    expect(result?.projectId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result?.reason).toBe("local_title_match");
    expect(result?.usedAi).toBe(false);
  });

  it("assigns by project name in compact conversation content", () => {
    const result = localProjectGuess(
      {
        title: "同步代理配置",
        text: "本地 MacBook 上的 OpenClaw 同步代理需要导入 Codex 会话。",
      },
      projectRows,
    );

    expect(result?.projectId).toBe("22222222-2222-2222-2222-222222222222");
    expect(result?.reason).toBe("local_content_match");
    expect(result?.usedAi).toBe(false);
  });
});

describe("fallbackSuggestedNameFromTitle", () => {
  it("falls back to coarse categories instead of one-off titles", () => {
    expect(fallbackSuggestedNameFromTitle("盐水鸭搭配建议")).toBe(
      "生活消费与饮食出行",
    );
    expect(fallbackSuggestedNameFromTitle("SSH密钥交换算法不匹配问题")).toBe(
      "网络安全与系统运维",
    );
  });

  it("ignores empty, untitled, and opaque id-like titles", () => {
    expect(fallbackSuggestedNameFromTitle("  ")).toBeNull();
    expect(fallbackSuggestedNameFromTitle("无标题")).toBeNull();
    expect(fallbackSuggestedNameFromTitle("019f9d356f96761081f88f75c90b6b4e")).toBeNull();
  });
});

describe("project granularity", () => {
  it("detects over-specific one-off project names", () => {
    expect(
      isLikelyOverSpecificProjectName(
        "ThinkPad跨代型号CPU与内存性能对比咨询",
        "ThinkPad跨代型号CPU与内存性能对比咨询",
      ),
    ).toBe(true);
    expect(isLikelyOverSpecificProjectName("网络安全与系统运维")).toBe(false);
  });

  it("maps detailed titles into reusable coarse categories", () => {
    expect(coarseProjectNameFromMaterial("微信零钱通与定期理财产品咨询")).toBe(
      "金融市场与投资研究",
    );
    expect(coarseProjectNameFromMaterial("微信公众号文章配图与发布管理")).toBe(
      "内容运营与公众号",
    );
  });
});

describe("shouldReuseClassification", () => {
  const revisionCapturedAt = new Date("2026-07-25T00:00:00.000Z");

  it("reuses a stable economy-mode assignment captured after the latest revision", () => {
    expect(
      shouldReuseClassification({
        mode: "economy",
        reuseStable: true,
        projectId: "11111111-1111-1111-1111-111111111111",
        confidence: 0.8,
        assignmentUpdatedAt: new Date("2026-07-25T00:01:00.000Z"),
        revisionCapturedAt,
      }),
    ).toBe(true);
  });

  it("does not reuse when confidence is low, reuse is disabled, or full mode is requested", () => {
    const stableInput = {
      mode: "economy" as const,
      reuseStable: true,
      projectId: "11111111-1111-1111-1111-111111111111",
      confidence: 0.77,
      assignmentUpdatedAt: new Date("2026-07-25T00:01:00.000Z"),
      revisionCapturedAt,
    };

    expect(shouldReuseClassification(stableInput)).toBe(false);
    expect(
      shouldReuseClassification({ ...stableInput, confidence: 0.8, reuseStable: false }),
    ).toBe(false);
    expect(
      shouldReuseClassification({ ...stableInput, confidence: 0.8, mode: "full" }),
    ).toBe(false);
  });
});

describe("isRecoverableClassificationAiError", () => {
  it("treats provider sensitive-input rejections as recoverable for one conversation", () => {
    const error = Object.assign(new Error("422 input new_sensitive (1026)"), {
      status: 422,
    });

    expect(isRecoverableClassificationAiError(error)).toBe(true);
  });

  it("reads sensitive-input rejections from OpenAI-compatible response bodies", () => {
    expect(
      isRecoverableClassificationAiError({
        response: {
          status: 400,
          data: { error: { code: 1026, message: "input new_sensitive" } },
        },
      }),
    ).toBe(true);
  });

  it("treats malformed model JSON as recoverable for classification", () => {
    expect(
      isRecoverableClassificationAiError(
        new Error("Model did not return valid JSON; response excerpt: <think>..."),
      ),
    ).toBe(true);
  });

  it("does not hide unrelated configuration failures", () => {
    expect(
      isRecoverableClassificationAiError(
        new Error("OpenAI-compatible analysis model is not configured"),
      ),
    ).toBe(false);
  });
});
