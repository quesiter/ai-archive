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
import { sql } from "drizzle-orm";
import type {
  CaptureMode,
  CaptureMessage,
  CaptureTriggerReason,
  DeviceKind,
  MessageRole,
  Provider,
  SegmentType,
} from "@ai-archive/contracts";

export type SourceReviewBodyKind = "map_rendering" | "partial_rendering" | "attachment_preview" | "source_text";

export interface SourceReview {
  version: 1;
  source: "chatgpt_source_ui" | "chatgpt_current_branch";
  contentComplete?: boolean | undefined;
  captureComplete?: boolean | undefined;
  sessionId: string;
  verifiedAt: string;
  sourceUrl: string;
  currentMessageIds: string[];
  inactiveMessages: Array<{ messageId: string; replacedByMessageId?: string | undefined }>;
  inactiveAnonymousBodies?: string[] | undefined;
  selectedBodies: Array<{ messageId: string; bodyHash: string }>;
  reviewedBodies: Array<{ messageId: string; bodyHash: string; kind: SourceReviewBodyKind }>;
  invalidatedByCapture?: { capturedAt: string; reason: "order_changed" | "new_branch" };
}

export interface MergeEvidence {
  variants: CaptureMessage[];
  warnings: Array<{ type: string; messageIds: string[] }>;
  sourceReview?: SourceReview;
  manualCompletion?: {
    version: 1;
    source: "user_acceptance";
    sourceVerified: false;
    reason: "source_unavailable_user_accepted";
    confirmedAt: string;
    previousCompleteness: string;
    sourceJobId: string;
    sourceItemId: string;
  };
  localSourceRepair?: {
    version: 1;
    source: "codex_local_jsonl" | "openclaw_local_jsonl";
    sessionId: string;
    verifiedAt: string;
    sourceMessageHash: string;
    files: Array<{ name: string; sha256: string; bytes: number }>;
    previousMessageCount: number;
    historicalObservationCount: number;
    resolvedWarnings: Array<{ type: string; messageIds: string[] }>;
  };
}

/** Small display metadata; historical bodies are fetched separately. */
export interface ArchiveReviewSummary {
  verifiedAt: string;
  fullyApplicable: boolean;
  reviewedOrderApplicable: boolean;
  contentComplete?: boolean;
  captureComplete?: boolean;
  storedMessageCount: number;
  inactiveMessageCount: number;
  resolvedObservationCount: number;
  unresolvedVariantCount: number;
  unresolvedWarnings: MergeEvidence["warnings"];
}

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  singletonKey: integer("singleton_key").notNull().default(1).unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEncrypted: text("totp_secret_encrypted").notNull(),
  pendingTotpSecretEncrypted: text("pending_totp_secret_encrypted"),
  pendingTotpExpiresAt: timestamp("pending_totp_expires_at", { withTimezone: true }),
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
  clientVersion: text("client_version"),
  os: text("os"),
  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  trackedFiles: integer("tracked_files"),
  skippedFiles: integer("skipped_files"),
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
    parentExternalSessionId: text("parent_external_session_id"),
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
    index("conversations_active_updated_idx").on(table.updatedAt.desc(), table.id.desc()).where(sql`${table.deletedAt} IS NULL`),
    index("conversations_title_trgm_idx").using("gin", table.title.op("gin_trgm_ops")),
    index("conversations_parent_session_idx").on(table.provider, table.parentExternalSessionId),
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
    revisionIdentityHash: text("revision_identity_hash"),
    contentIntegrityHash: text("content_integrity_hash"),
    isAccumulated: boolean("is_accumulated").notNull().default(false),
    mergeEvidence: jsonb("merge_evidence").$type<MergeEvidence>().notNull().default({ variants: [], warnings: [] }),
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
    capturedTitle: text("captured_title"),
    capturedCanonicalUrl: text("captured_canonical_url"),
    metadataCaptured: boolean("metadata_captured").notNull().default(true),
    sourceDeviceId: uuid("source_device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull(),
    // Retained as an empty compatibility field for v1 backups.
    searchText: text("search_text").notNull().default(""),
    presentationMessageCount: integer("presentation_message_count"),
    storedMessageCount: integer("stored_message_count"),
    sourceContentPending: boolean("source_content_pending"),
    archiveReview: jsonb("archive_review").$type<ArchiveReviewSummary>(),
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
    uniqueIndex("conversation_revision_identity_uidx").on(
      table.conversationId,
      table.revisionIdentityHash,
    ),
    uniqueIndex("conversation_accumulated_revision_uidx").on(table.conversationId).where(sql`${table.isAccumulated}`),
    index("conversation_revision_snapshot_idx").on(table.conversationId, table.snapshotHash),
    index("conversation_revision_conversation_idx").on(table.conversationId),
    index("conversation_revision_base_idx").on(table.baseRevisionId),
    index("conversation_revision_captured_idx").on(table.capturedAt),
    index("conversation_revision_current_idx").on(table.conversationId, table.isAccumulated.desc(),
      sql`(${table.completeness} = 'complete') DESC`, table.capturedAt.desc(), table.createdAt.desc(), table.id.desc()),
    index("conversation_revision_read_model_pending_idx").on(table.id).where(sql`${table.presentationMessageCount} IS NULL`),
  ],
);

/** References only: a source review may change order or select an observed variant. */
export const conversationRevisionPresentation = pgTable("conversation_revision_presentation", {
  revisionId: uuid("revision_id").notNull().references(() => conversationRevisions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  storedOrdinal: integer("stored_ordinal"),
  variantIndex: integer("variant_index"),
}, (table) => [primaryKey({ columns: [table.revisionId, table.ordinal] })]);

export const conversationRevisionObservations = pgTable("conversation_revision_observations", {
  revisionId: uuid("revision_id").notNull().references(() => conversationRevisions.id, { onDelete: "cascade" }),
  category: text("category").$type<"inactive" | "resolved" | "unresolved">().notNull(),
  ordinal: integer("ordinal").notNull(),
  storedOrdinal: integer("stored_ordinal"),
  variantIndex: integer("variant_index"),
  observationKind: text("observation_kind").$type<SourceReviewBodyKind>(),
}, (table) => [primaryKey({ columns: [table.revisionId, table.category, table.ordinal] })]);

export const conversationSummaries = pgTable("conversation_summaries", {
  conversationId: uuid("conversation_id").primaryKey().references(() => conversations.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull(),
  messageCount: integer("message_count").notNull(),
  archivedTextUnits: bigint("archived_text_units", { mode: "number" }).notNull(),
  reasoningTextUnits: bigint("reasoning_text_units", { mode: "number" }).notNull(),
  toolTextUnits: bigint("tool_text_units", { mode: "number" }).notNull(),
  reportedTotalTokens: bigint("reported_total_tokens", { mode: "number" }),
  reportedReasoningOutputTokens: bigint("reported_reasoning_output_tokens", { mode: "number" }),
  latestActivityAt: timestamp("latest_activity_at", { withTimezone: true }).notNull(),
}, (table) => [index("conversation_summaries_activity_idx").on(table.latestActivityAt.desc())]);

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

export const conversationSearchDocuments = pgTable("conversation_search_documents", {
  conversationId: uuid("conversation_id").primaryKey().references(() => conversations.id, { onDelete: "cascade" }),
  termsReady: boolean("terms_ready").notNull().default(false),
}, table => [index("conversation_search_documents_pending_idx").on(table.conversationId).where(sql`NOT ${table.termsReady}`)]);

export const conversationSearchTerms = pgTable("conversation_search_terms", {
  term: text("term").notNull(),
  conversationId: uuid("conversation_id").notNull().references(() => conversationSearchDocuments.conversationId, { onDelete: "cascade" }),
}, table => [primaryKey({ columns: [table.term, table.conversationId] }),
  index("conversation_search_terms_conversation_idx").on(table.conversationId)]);

export const projectConversationRollups = pgTable("project_conversation_rollups", {
  sourceConversationId: uuid("source_conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  activityAt: timestamp("activity_at", { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.sourceConversationId, table.conversationId] }),
  index("project_rollups_project_idx").on(table.projectId, table.conversationId),
  index("project_rollups_root_idx").on(table.conversationId)]);

export const conversationSearchChunks = pgTable(
  "conversation_search_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => conversationRevisions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("conversation_search_chunks_message_chunk_uidx").on(
      table.messageId,
      table.chunkIndex,
    ),
    index("conversation_search_chunks_revision_idx").on(table.revisionId, table.id),
    index("conversation_search_chunks_message_idx").on(table.messageId),
    index("conversation_search_chunks_content_trgm_idx").using("gin", table.content.op("gin_trgm_ops")),
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
    payloadIdentityHash: text("payload_identity_hash"),
    requestHash: text("request_hash"),
    receipt: jsonb("receipt").$type<{
      conversationId: string;
      revisionId: string;
      unchanged: boolean;
      completeness: "complete" | "partial";
      messageCount: number;
      archiveMessageCount: number;
      archiveCompleteness: "complete" | "partial";
      baselineContentHash?: string;
      captureMode: CaptureMode;
      triggerReason: CaptureTriggerReason | null;
    }>(),
    adapterVersion: text("adapter_version"),
    messageCount: integer("message_count"),
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

export const recaptureJobs = pgTable("recapture_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running"),
  message: text("message"),
  lastRunnerSeenAt: timestamp("last_runner_seen_at", { withTimezone: true }),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("recapture_jobs_active_device").on(table.deviceId).where(sql`${table.status} in ('running', 'paused')`)]);

export const recaptureItems = pgTable("recapture_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => recaptureJobs.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  externalSessionId: text("external_session_id").notNull(),
  title: text("title").notNull(),
  ordinal: integer("ordinal").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  captureId: text("capture_id"),
  message: text("message"),
  messageCount: integer("message_count"),
}, (table) => [uniqueIndex("recapture_items_job_ordinal").on(table.jobId, table.ordinal), index("recapture_items_job_status").on(table.jobId, table.status)]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull().default(""),
    archived: boolean("archived").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    uniqueIndex("projects_normalized_name_uidx").on(table.normalizedName),
    index("projects_name_idx").on(table.name),
  ],
);

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
      .$type<"classification_rebuild" | "storage_redaction" | "archive_integrity">()
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
    emailStatus: text("email_status")
      .$type<"not_configured" | "queued" | "sent" | "failed">()
      .notNull()
      .default("not_configured"),
    emailAttempts: integer("email_attempts").notNull().default(0),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    emailError: text("email_error"),
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

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    query: jsonb("query").$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    uniqueIndex("saved_searches_normalized_name_uidx").on(table.normalizedName),
  ],
);

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
      .$type<"queued" | "processing" | "completed" | "partial" | "failed">()
      .notNull(),
    attempt: integer("attempt").notNull().default(0),
    lastRetryAt: timestamp("last_retry_at", { withTimezone: true }),
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

export const restoreJobs = pgTable(
  "restore_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    filename: text("filename").notNull(),
    stagedPath: text("staged_path").notNull(),
    status: text("status")
      .$type<
        | "queued"
        | "validating"
        | "validated"
        | "restoring"
        | "rebuilding_search"
        | "verifying"
        | "recovery_required"
        | "completed"
        | "failed"
        | "cancelled"
      >()
      .notNull(),
    progress: integer("progress").notNull().default(0),
    phaseMessage: text("phase_message"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    factsCommittedAt: timestamp("facts_committed_at", { withTimezone: true }),
    stagedDeletedAt: timestamp("staged_deleted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    index("restore_jobs_status_updated_idx").on(table.status, table.updatedAt),
    index("restore_jobs_created_idx").on(table.createdAt),
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
