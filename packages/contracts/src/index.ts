import { z } from "zod";

export const providers = [
  "chatgpt",
  "gemini",
  "grok",
  "yuanbao",
  "doubao",
  "minimax_agent",
  "deepseek",
  "qianwen",
  "kimi",
  "openclaw",
  "codex",
  "claude_code",
] as const;

export const ProviderSchema = z.enum(providers);
export type Provider = z.infer<typeof ProviderSchema>;

export const providerLabels: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
  yuanbao: "腾讯元宝",
  doubao: "豆包",
  minimax_agent: "MiniMax Agent",
  deepseek: "DeepSeek",
  qianwen: "千问",
  kimi: "Kimi",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
};

export const MessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "unknown",
]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

const INTERNAL_CONVERSATION_BLOCK_TAGS = [
  "recommended_plugins",
  "environment_context",
  "app-context",
  "skills_instructions",
  "permissions instructions",
  "apps_instructions",
  "plugins_instructions",
  "collaboration_mode",
  "multi_agent_mode",
] as const;

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes product/runtime envelopes that can be stored in the same message as
 * the user's actual prompt. The original archived content remains unchanged.
 */
export function stripInternalConversationMetadata(value: string): string {
  let output = value.replace(/\r\n/g, "\n");
  for (const tag of INTERNAL_CONVERSATION_BLOCK_TAGS) {
    const escaped = escapedRegExp(tag);
    output = output.replace(
      new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}\\s*>`, "gi"),
      "",
    );
  }
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

export const SegmentTypeSchema = z.enum([
  "text",
  "reasoning",
  "code",
  "citation",
  "tool_status",
]);
export type SegmentType = z.infer<typeof SegmentTypeSchema>;

const HttpUrlSchema = z
  .string()
  .url()
  .max(8_192)
  .refine((value) => /^https?:\/\//i.test(value), "Only HTTP(S) links are allowed");

export const MessageSegmentSchema = z.object({
  type: SegmentTypeSchema,
  content: z.string().min(1).max(2_000_000),
  href: HttpUrlSchema.optional(),
  language: z.string().max(64).optional(),
});
export type MessageSegment = z.infer<typeof MessageSegmentSchema>;

export const CaptureMessageSchema = z.object({
  externalMessageId: z.string().min(1).max(512).optional(),
  ordinal: z.number().int().nonnegative(),
  role: MessageRoleSchema,
  model: z.string().max(256).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  segments: z.array(MessageSegmentSchema).min(1).max(10_000),
});
export type CaptureMessage = z.infer<typeof CaptureMessageSchema>;

export const CompletenessSchema = z.object({
  status: z.enum(["complete", "partial"]),
  topReached: z.boolean(),
  bottomReached: z.boolean(),
  stable: z.boolean(),
  reason: z.string().max(1_000).optional(),
});
export type Completeness = z.infer<typeof CompletenessSchema>;

export const CaptureModeSchema = z.enum(["full", "append", "import"]);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export const CaptureSnapshotModeSchema = z.enum(["full", "import"]);
export type CaptureSnapshotMode = z.infer<typeof CaptureSnapshotModeSchema>;

export const CaptureTriggerReasonSchema = z.enum([
  "new_session",
  "new_messages",
  "stream_finished",
  "branch_changed",
  "adapter_upgraded",
  "manual_retry",
  "incremental_base_mismatch",
  "historical_import",
  "local_file_appended",
  "local_file_rewritten",
]);
export type CaptureTriggerReason = z.infer<typeof CaptureTriggerReasonSchema>;

export const CaptureSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    provider: ProviderSchema,
    sessionId: z.string().min(1).max(1_024),
    branchFingerprint: z.string().min(8).max(256),
    title: z.string().max(2_048).optional(),
    canonicalUrl: HttpUrlSchema.optional(),
    adapterVersion: z.string().min(1).max(64),
    capturedAt: z.string().datetime({ offset: true }),
    captureMode: CaptureModeSchema.default("full"),
    triggerReason: CaptureTriggerReasonSchema.optional(),
    baseRevisionId: z.string().uuid().optional(),
    baseMessageCount: z.number().int().nonnegative().optional(),
    baseLastMessageId: z.string().min(1).max(512).optional(),
    baseLastMessageTextHash: z.string().min(16).max(128).optional(),
    completeness: CompletenessSchema,
    messages: z.array(CaptureMessageSchema).min(1).max(100_000),
  })
  .superRefine((snapshot, context) => {
    const ordinals = snapshot.messages.map((message) => message.ordinal);
    if (new Set(ordinals).size !== ordinals.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "message ordinals must be unique",
      });
    }
    if (
      snapshot.completeness.status === "complete" &&
      (!snapshot.completeness.topReached ||
        !snapshot.completeness.bottomReached ||
        !snapshot.completeness.stable)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completeness"],
        message: "complete captures require top, bottom, and stability evidence",
      });
    }
    if (
      snapshot.messages.some((message, index) => message.ordinal !== index)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "snapshot messages must contain contiguous message ordinals from zero",
      });
    }
  });
export type CaptureSnapshotV1 = z.infer<typeof CaptureSnapshotV1Schema>;

export const CaptureDeltaV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    captureMode: z.literal("append"),
    provider: ProviderSchema,
    sessionId: z.string().min(1).max(1_024),
    branchFingerprint: z.string().min(8).max(256),
    title: z.string().max(2_048).optional(),
    canonicalUrl: HttpUrlSchema.optional(),
    adapterVersion: z.string().min(1).max(64),
    capturedAt: z.string().datetime({ offset: true }),
    triggerReason: CaptureTriggerReasonSchema.default("new_messages"),
    baseRevisionId: z.string().uuid().optional(),
    baseMessageCount: z.number().int().positive(),
    baseLastMessageId: z.string().min(1).max(512).optional(),
    baseLastMessageTextHash: z.string().min(16).max(128).optional(),
    appendedMessages: z.array(CaptureMessageSchema).min(1).max(10_000),
  })
  .superRefine((delta, context) => {
    if (!delta.baseLastMessageId && !delta.baseLastMessageTextHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseLastMessageId"],
        message: "append captures require a base last message ID or text hash",
      });
    }
    const ordinals = delta.appendedMessages.map((message) => message.ordinal);
    if (new Set(ordinals).size !== ordinals.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appendedMessages"],
        message: "message ordinals must be unique",
      });
    }
    const expected = delta.baseMessageCount;
    if (
      ordinals.length &&
      [...ordinals].sort((left, right) => left - right).some(
        (ordinal, index) => ordinal !== expected + index,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appendedMessages"],
        message: "append message ordinals must be contiguous after the base",
      });
    }
  });
export type CaptureDeltaV1 = z.infer<typeof CaptureDeltaV1Schema>;

export const CapturePayloadV1Schema = z.union([
  CaptureDeltaV1Schema,
  CaptureSnapshotV1Schema,
]);
export type CapturePayloadV1 = z.infer<typeof CapturePayloadV1Schema>;

export const DeviceKindSchema = z.enum([
  "chrome_extension",
  "openclaw_sync",
  "importer",
]);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const PairingClaimSchema = z.object({
  code: z.string().min(6).max(32),
  name: z.string().min(1).max(128).optional(),
  kind: DeviceKindSchema,
});
export type PairingClaim = z.infer<typeof PairingClaimSchema>;

export const KnowledgeTypeSchema = z.enum([
  "decision",
  "requirement",
  "fact",
  "idea",
  "task",
  "risk",
  "resource",
  "open_question",
]);
export type KnowledgeType = z.infer<typeof KnowledgeTypeSchema>;

export const SourceReferenceSchema = z.object({
  conversationId: z.string().uuid(),
  revisionId: z.string().uuid(),
  messageOrdinal: z.number().int().nonnegative(),
});
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const ExtractedKnowledgeSchema = z.object({
  type: KnowledgeTypeSchema,
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  confidence: z.number().min(0).max(1),
  sourceMessageOrdinals: z.array(z.number().int().nonnegative()).min(1),
});
export type ExtractedKnowledge = z.infer<typeof ExtractedKnowledgeSchema>;

export const ProjectSuggestionSchema = z.object({
  existingProjectId: z.string().uuid().nullable(),
  suggestedName: z.string().min(1).max(200).nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2_000),
});
export type ProjectSuggestion = z.infer<typeof ProjectSuggestionSchema>;

export function flattenMessageText(message: CaptureMessage): string {
  return message.segments
    .map((segment) =>
      segment.href ? `${segment.content} (${segment.href})` : segment.content,
    )
    .join("\n");
}

export function analysisMessageText(message: CaptureMessage): string {
  return message.segments
    .filter((segment) => !["reasoning", "tool_status"].includes(segment.type))
    .map((segment) =>
      segment.href ? `${segment.content} (${segment.href})` : segment.content,
    )
    .join("\n");
}
