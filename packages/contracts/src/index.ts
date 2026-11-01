import { z } from "zod";
import { providers } from "./presentation.js";
export { providers, providerLabels, stripInternalConversationMetadata } from "./presentation.js";
export type { RecaptureItemStatus, RecaptureItem, RecaptureJob, RecaptureTask, RecaptureNext, RecaptureReport } from "./recapture.js";

export const ProviderSchema = z.enum(providers);
export type Provider = z.infer<typeof ProviderSchema>;

export const MessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "unknown",
]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

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

// Database UUIDs retain the canonical hex format accepted by PostgreSQL and
// Zod 3; z.guid() also accepts older identifiers without RFC version bits.
const DatabaseUuidSchema = z.guid();

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

const TokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Normalized model-provider usage. Snapshot values cover the whole source
 * session; append captures may carry either a cumulative value or a delta.
 */
export const TokenUsageSchema = z.object({
  scope: z.enum(["cumulative", "incremental"]),
  inputTokens: TokenCountSchema,
  cachedInputTokens: TokenCountSchema,
  cacheWriteInputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  reasoningOutputTokens: TokenCountSchema,
  totalTokens: TokenCountSchema,
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const CaptureSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    provider: ProviderSchema,
    sessionId: z.string().min(1).max(1_024),
    parentSessionId: z.string().min(1).max(1_024).optional(),
    branchFingerprint: z.string().min(8).max(256),
    title: z.string().max(2_048).optional(),
    canonicalUrl: HttpUrlSchema.optional(),
    sourceKind: z.literal("chatgpt_current_branch").optional(),
    adapterVersion: z.string().min(1).max(64),
    capturedAt: z.string().datetime({ offset: true }),
    captureMode: CaptureModeSchema.default("full"),
    triggerReason: CaptureTriggerReasonSchema.optional(),
    tokenUsage: TokenUsageSchema.optional(),
    baseRevisionId: DatabaseUuidSchema.optional(),
    baseMessageCount: z.number().int().nonnegative().optional(),
    baseLastMessageId: z.string().min(1).max(512).optional(),
    baseLastMessageTextHash: z.string().min(16).max(128).optional(),
    completeness: CompletenessSchema,
    messages: z.array(CaptureMessageSchema).min(1).max(100_000),
  })
  .superRefine((snapshot, context) => {
    if (snapshot.sourceKind && (snapshot.provider !== "chatgpt" || snapshot.captureMode !== "full" ||
        !snapshot.completeness.topReached || !snapshot.completeness.bottomReached || !snapshot.completeness.stable ||
        snapshot.messages.some(message => !message.externalMessageId || /^(?:fallback-)?(?:turn|conversation-turn)-\d+/i.test(message.externalMessageId)) ||
        new Set(snapshot.messages.map(message => message.externalMessageId)).size !== snapshot.messages.length)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceKind"], message: "native branch evidence requires a stable full ChatGPT chain with unique source IDs" });
    }
    if (snapshot.parentSessionId === snapshot.sessionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentSessionId"], message: "a conversation cannot be its own parent" });
    }
    if (snapshot.tokenUsage?.scope === "incremental") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenUsage", "scope"],
        message: "snapshot token usage must be cumulative",
      });
    }
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
    parentSessionId: z.string().min(1).max(1_024).optional(),
    branchFingerprint: z.string().min(8).max(256),
    title: z.string().max(2_048).optional(),
    canonicalUrl: HttpUrlSchema.optional(),
    adapterVersion: z.string().min(1).max(64),
    capturedAt: z.string().datetime({ offset: true }),
    triggerReason: CaptureTriggerReasonSchema.default("new_messages"),
    tokenUsage: TokenUsageSchema.optional(),
    baseRevisionId: DatabaseUuidSchema.optional(),
    baseMessageCount: z.number().int().positive(),
    baseContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    baseLastMessageId: z.string().min(1).max(512).optional(),
    baseLastMessageTextHash: z.string().min(16).max(128).optional(),
    appendedMessages: z.array(CaptureMessageSchema).max(10_000),
  })
  .superRefine((delta, context) => {
    if (delta.parentSessionId === delta.sessionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentSessionId"], message: "a conversation cannot be its own parent" });
    }
    if (!delta.appendedMessages.length && !delta.tokenUsage && !delta.parentSessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appendedMessages"],
        message: "append captures require new messages, token usage, or a parent session",
      });
    }
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

export const ProjectSuggestionSchema = z.object({
  existingProjectId: DatabaseUuidSchema.nullable(),
  suggestedName: z.string().min(1).max(200).nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2_000),
});
export type ProjectSuggestion = z.infer<typeof ProjectSuggestionSchema>;

export const TagSuggestionSchema = z.object({
  name: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
});
export type TagSuggestion = z.infer<typeof TagSuggestionSchema>;

export const ConversationOrganizationSuggestionSchema = z.object({
  project: z.object({
    projectId: DatabaseUuidSchema.nullable(),
    suggestedProjectName: z.string().min(1).max(200).nullable(),
    confidence: z.number().min(0).max(1),
  }),
  tags: z.array(TagSuggestionSchema).max(10),
});
export type ConversationOrganizationSuggestion = z.infer<
  typeof ConversationOrganizationSuggestionSchema
>;

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
