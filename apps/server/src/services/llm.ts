import OpenAI from "openai";
import { z, ZodError } from "zod";
import { getSetting } from "./settings.js";
import { withPinnedNetworkDispatcher } from "./network-target.js";

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LlmConfigInput {
  baseURL?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
}

const STRUCTURED_COMPLETION_TIMEOUT_MS = 120_000;
const TEST_COMPLETION_TIMEOUT_MS = 30_000;
export const TOKEN_PLAN_RETRY_DELAY_MS = 5 * 60 * 60_000;

async function loadLlmConfig(input: LlmConfigInput = {}): Promise<LlmConfig> {
  const [baseURL, apiKey, model] = await Promise.all([
    getSetting("llm.baseUrl"),
    getSetting("llm.apiKey"),
    getSetting("llm.model"),
  ]);
  const requestedApiKey = input.apiKey?.trim();
  const resolved = {
    baseURL: input.baseURL?.trim() || baseURL || "",
    apiKey:
      requestedApiKey && requestedApiKey !== "********" ? requestedApiKey : apiKey || "",
    model: input.model?.trim() || model || "",
  };
  if (!resolved.baseURL || !resolved.apiKey || !resolved.model) {
    throw new Error("OpenAI-compatible analysis model is not configured");
  }
  return resolved;
}

function excerpt(value: string, limit = 700): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}...`;
}

function stripClosedReasoningBlocks(value: string): string {
  return value.replace(/<(?:think|reasoning)>[\s\S]*?<\/(?:think|reasoning)>/gi, "");
}

function balancedJsonSliceFrom(value: string, startIndex: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char !== "{" && char !== "[" && stack.length === 0) return null;
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return value.slice(startIndex, index + 1);
    }
  }
  return null;
}

function jsonSlices(value: string): string[] {
  const slices: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "{" && char !== "[") continue;
    const slice = balancedJsonSliceFrom(value, index);
    if (slice) slices.push(slice);
  }
  return slices;
}

export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const withoutReasoning = stripClosedReasoningBlocks(trimmed).trim();
  const afterReasoning = trimmed.includes("</think>")
    ? trimmed.slice(trimmed.lastIndexOf("</think>") + "</think>".length).trim()
    : "";
  const candidates = [
    trimmed,
    withoutReasoning,
    afterReasoning,
    ...Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) =>
      match[1]?.trim() ?? "",
    ),
    ...jsonSlices(withoutReasoning || trimmed),
    ...jsonSlices(trimmed),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate before reporting the original model output.
    }
  }
  throw new Error("Model did not return valid JSON");
}

function schemaErrorMessage(error: ZodError): string {
  const issues = error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Model JSON did not match expected schema: ${issues}`;
}

export function isRetryableRateLimitError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("token plan") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    message.includes("insufficient_quota") ||
    message.includes("quota exceeded")
  );
}

function parseStructured<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  content: string,
): T {
  const parsed = extractJson(content);
  try {
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) throw new Error(schemaErrorMessage(error));
    throw error;
  }
}

export async function completeStructured<T>(input: {
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}): Promise<T> {
  const llm = await loadLlmConfig();
  return withPinnedNetworkDispatcher(llm.baseURL, async (dispatcher) => {
    const client = new OpenAI({
      apiKey: llm.apiKey,
      baseURL: llm.baseURL,
      fetchOptions: { dispatcher },
    });
    const baseRequest = {
      model: llm.model,
      temperature: 0,
      messages: [
        { role: "system" as const, content: input.system },
        { role: "user" as const, content: input.user },
      ],
    };
    let response;
    try {
      response = await client.chat.completions.create(
        {
          ...baseRequest,
          response_format: { type: "json_object" },
        },
        { timeout: STRUCTURED_COMPLETION_TIMEOUT_MS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/response_format|json_object|unsupported/i.test(message)) throw error;
      response = await client.chat.completions.create(
        baseRequest,
        { timeout: STRUCTURED_COMPLETION_TIMEOUT_MS },
      );
    }
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("Model returned an empty response");
    return parseStructured(input.schema, content);
  });
}

export async function testLlmConnection(input: LlmConfigInput = {}): Promise<{
  baseURL: string;
  model: string;
  response: string;
}> {
  const llm = await loadLlmConfig(input);
  return withPinnedNetworkDispatcher(llm.baseURL, async (dispatcher) => {
    const client = new OpenAI({
      apiKey: llm.apiKey,
      baseURL: llm.baseURL,
      fetchOptions: { dispatcher },
    });
    const request = {
      model: llm.model,
      temperature: 0,
      messages: [{ role: "user" as const, content: "Reply with OK." }],
    };
    let response;
    try {
      response = await client.chat.completions.create(
        {
          ...request,
          max_tokens: 8,
        },
        { timeout: TEST_COMPLETION_TIMEOUT_MS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/max_tokens|unsupported|not support/i.test(message)) throw error;
      response = await client.chat.completions.create(
        request,
        { timeout: TEST_COMPLETION_TIMEOUT_MS },
      );
    }
    const content = response.choices[0]?.message.content?.trim();
    if (!content) throw new Error("Model returned an empty response");
    return {
      baseURL: llm.baseURL,
      model: llm.model,
      response: content.slice(0, 200),
    };
  });
}
