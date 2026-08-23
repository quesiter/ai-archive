import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CaptureMode,
  CaptureTriggerReason,
  DeviceKind,
  MessageRole,
  Provider,
  SegmentType,
} from "@ai-archive/contracts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  singletonKey: integer("singleton_key").notNull().default(1).unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEncrypted: text("totp_secret_encrypted").notNull(),
  createdAt,
});

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [index("web_sessions_user_idx").on(table.userId)],
);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<DeviceKind>().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt,
});

export const pairingCodes = pgTable("pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  requestedName: text("requested_name").notNull(),
  requestedKind: text("requested_kind").$type<DeviceKind>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt,
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").$type<Provider>().notNull(),
    externalSessionId: text("external_session_id").notNull(),
    title: text("title"),
    canonicalUrl: text("canonical_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex("conversations_provider_session_uidx").on(
      table.provider,
      table.externalSessionId,
    ),
    index("conversations_updated_idx").on(table.updatedAt),
  ],
);

export const conversationRevisions = pgTable(
  "conversation_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    branchFingerprint: text("branch_fingerprint").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    completeness: text("completeness").$type<"complete" | "partial">().notNull(),
    topReached: boolean("top_reached").notNull(),
    bottomReached: boolean("bottom_reached").notNull(),
    stable: boolean("stable").notNull(),
    completenessReason: text("completeness_reason"),
    captureMode: text("capture_mode").$type<CaptureMode>().notNull().default("full"),
    triggerReason: text("trigger_reason").$type<CaptureTriggerReason>(),
    baseRevisionId: uuid("base_revision_id"),
    baseMessageCount: integer("base_message_count"),
    storageKind: text("storage_kind")
      .$type<"snapshot" | "delta">()
      .notNull()
      .default("snapshot"),
    adapterVersion: text("adapter_version").notNull(),
    sourceDeviceId: uuid("source_device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull(),
    searchText: text("search_text").notNull(),
    archivedTextUnits: bigint("archived_text_units", { mode: "number" })
      .notNull()
      .default(0),
    reasoningTextUnits: bigint("reasoning_text_units", { mode: "number" })
      .notNull()
      .default(0),
    toolTextUnits: bigint("tool_text_units", { mode: "number" })
      .notNull()
      .default(0),
    reportedInputTokens: bigint("reported_input_tokens", { mode: "number" }),
    reportedCachedInputTokens: bigint("reported_cached_input_tokens", {
      mode: "number",
    }),
    reportedCacheWriteInputTokens: bigint(
      "reported_cache_write_input_tokens",
      { mode: "number" },
    ),
    reportedOutputTokens: bigint("reported_output_tokens", { mode: "number" }),
    reportedReasoningOutputTokens: bigint(
      "reported_reasoning_output_tokens",
      { mode: "number" },
    ),
    reportedTotalTokens: bigint("reported_total_tokens", { mode: "number" }),
    createdAt,
  },
  (table) => [
    uniqueIndex("conversation_revision_snapshot_uidx").on(
      table.conversationId,
      table.snapshotHash,
    ),
    index("conversation_revision_conversation_idx").on(table.conversationId),
    index("conversation_revision_base_idx").on(table.baseRevisionId),
    index("conversation_revision_captured_idx").on(table.capturedAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => conversationRevisions.id, { onDelete: "cascade" }),
    externalMessageId: text("external_message_id"),
    ordinal: integer("ordinal").notNull(),
    role: text("role").$type<MessageRole>().notNull(),
    model: text("model"),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex("messages_revision_ordinal_uidx").on(
      table.revisionId,
      table.ordinal,
    ),
  ],
);

export const messageSegments = pgTable(
  "message_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    type: text("type").$type<SegmentType>().notNull(),
    content: text("content").notNull(),
    href: text("href"),
    language: text("language"),
    createdAt,
  },
  (table) => [
    uniqueIndex("message_segments_message_ordinal_uidx").on(
      table.messageId,
      table.ordinal,
    ),
  ],
);

export const captureRuns = pgTable(
  "capture_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    provider: text("provider").$type<Provider>().notNull(),
    externalSessionId: text("external_session_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    snapshotHash: text("snapshot_hash"),
    captureMode: text("capture_mode").$type<CaptureMode>().notNull().default("full"),
    triggerReason: text("trigger_reason").$type<CaptureTriggerReason>(),
    baseRevisionId: uuid("base_revision_id"),
    baseMessageCount: integer("base_message_count"),
    status: text("status").$type<"complete" | "partial" | "failed">().notNull(),
    error: text("error"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("capture_runs_device_idempotency_uidx").on(
      table.deviceId,
      table.idempotencyKey,
    ),
    index("capture_runs_created_idx").on(table.createdAt),
  ],
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  archived: boolean("archived").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt,
});

export const conversationProjects = pgTable("conversation_projects", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  confidence: doublePrecision("confidence"),
  lockedByUser: boolean("locked_by_user").notNull().default(false),
  suggestedName: text("suggested_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    uniqueIndex("tags_normalized_name_uidx").on(table.normalizedName),
    index("tags_name_idx").on(table.name),
  ],
);

export const conversationTags = pgTable(
  "conversation_tags",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    confidence: doublePrecision("confidence"),
    source: text("source").$type<"auto" | "manual">().notNull(),
    lockedByUser: boolean("locked_by_user").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    primaryKey({
      name: "conversation_tags_pk",
      columns: [table.conversationId, table.tagId],
    }),
    index("conversation_tags_tag_idx").on(table.tagId),
    index("conversation_tags_conversation_idx").on(table.conversationId),
  ],
);

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"weekly" | "monthly" | "manual">().notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    error: text("error"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    uniqueIndex("analysis_runs_kind_window_uidx").on(
      table.kind,
      table.windowStart,
      table.windowEnd,
    ),
    index("analysis_runs_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

export const backgroundTasks = pgTable(
  "background_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind")
      .$type<"classification_rebuild" | "storage_redaction">()
      .notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull(),
    totalCount: integer("total_count").notNull().default(0),
    processedCount: integer("processed_count").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    message: text("message"),
    error: text("error"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    index("background_tasks_kind_created_idx").on(table.kind, table.createdAt),
    index("background_tasks_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"weekly" | "monthly">().notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("reports_kind_period_uidx").on(
      table.kind,
      table.periodStart,
      table.periodEnd,
    ),
    index("reports_period_idx").on(table.periodEnd),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  encrypted: boolean("encrypted").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const redactionRules = pgTable("redaction_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  pattern: text("pattern").notNull(),
  replacement: text("replacement").notNull().default("[CUSTOM_REDACTED]"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt,
});

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    filename: text("filename").notNull(),
    fileHash: text("file_hash").notNull().unique(),
    provider: text("provider").$type<Provider>(),
    status: text("status")
      .$type<"queued" | "processing" | "completed" | "failed">()
      .notNull(),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    index("import_jobs_created_idx").on(table.createdAt),
    index("import_jobs_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

export type OperationLogLevel = "info" | "warning" | "error";
export type OperationLogScope =
  | "analysis"
  | "capture"
  | "classification"
  | "device"
  | "import"
  | "system";

export const operationLogs = pgTable(
  "operation_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").$type<OperationLogScope>().notNull(),
    level: text("level").$type<OperationLogLevel>().notNull().default("info"),
    message: text("message").notNull(),
    status: text("status"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt,
  },
  (table) => [
    index("operation_logs_scope_created_idx").on(table.scope, table.createdAt),
    index("operation_logs_level_created_idx").on(table.level, table.createdAt),
    index("operation_logs_entity_idx").on(table.entityType, table.entityId),
  ],
);
