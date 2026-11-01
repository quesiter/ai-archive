import type { CaptureMode, CaptureTriggerReason, MessageRole, SegmentType, Provider } from "@ai-archive/contracts";
import type { ConversationArchiveReviewSummary } from "./conversation-archive.js";
import type { ChildConversation, RelatedConversation } from "./conversation-lineage.js";

export interface PaginationData { total: number; limit: number; offset: number; hasMore: boolean }
export interface PageEnvelope<T> { items: T[]; pagination: PaginationData }
export interface ProjectOption { id: string; name: string; description?: string | null; archived: boolean; conversationCount?: number }
export interface Tag { id: string; name: string; source?: string; confidence?: number | null; lockedByUser?: boolean; conversationCount?: number }
export interface ProviderCount { provider: Provider; count: number }
export interface SavedSearch { id: string; name: string; query: Record<string, string | number> }
export interface ArchivedSegment {
  id?: string; messageId?: string; ordinal?: number; type: SegmentType; content: string;
  href?: string | null | undefined; language?: string | null | undefined;
}
export interface ArchivedMessage {
  id: string;
  ordinal: number;
  storedOrdinal?: number | null;
  externalMessageId?: string | null;
  role: MessageRole;
  model?: string | null | undefined;
  sourceCreatedAt?: string | null;
  createdAt?: string;
  segments: ArchivedSegment[];
}
export interface ArchivedRevision {
  id: string;
  messageCount: number;
  storedMessageCount?: number;
  sourceContentPending?: boolean;
  completeness: string;
  completenessReason?: string | null;
  capturedAt: string;
  captureMode: CaptureMode;
  triggerReason?: CaptureTriggerReason | null;
  sourceDeviceName?: string | null;
  sourceDevice?: { name: string } | null;
  adapterVersion: string;
  mergeEvidence?: { manualCompletion?: { version?: number; source?: string; sourceVerified?: boolean; reason?: string; confirmedAt?: string } };
}
export interface Conversation {
  id: string;
  provider: Provider;
  externalSessionId: string;
  parentExternalSessionId?: string | null;
  title: string | null;
  canonicalUrl?: string | null;
  updatedAt: string;
  deletedAt?: string | null;
  childCount?: number;
  projectName?: string | null;
  projectConfidence?: number | null;
  projectLocked?: boolean;
  suggestedProjectName?: string | null;
  tags?: Tag[];
  latestRevision?: ArchivedRevision | null;
  searchHit?: { messageOrdinal?: number | null; reason: string; excerpt?: string } | null;
}
export interface ConversationDetailResponse {
  conversation: Conversation;
  parentConversation?: RelatedConversation | null;
  childConversations?: ChildConversation[];
  projectAssignment: { projectId: string | null; projectName?: string | null; lockedByUser: boolean } | null;
  tags: Tag[];
  selectedRevision: ArchivedRevision | null;
  messages: ArchivedMessage[];
  messagePagination: PaginationData;
  archiveReview?: ConversationArchiveReviewSummary;
}
export interface ConversationEvidenceItem {
  kind: "variant" | "inactive" | "resolved";
  message: ArchivedMessage;
  reviewKind?: string;
}
export interface ConversationEvidenceResponse {
  warningCount?: number;
  items: ConversationEvidenceItem[];
  pagination: PaginationData;
  warnings: Array<{ type: string; messageIds: string[] }>;
}
export interface TimelineItem {
  conversationId: string;
  provider: Provider;
  title: string | null;
  capturedAt: string;
  childCount: number;
  tags: Tag[];
}
export interface Device {
  id: string; name: string; kind: string; os?: string | null; clientVersion?: string | null;
  trackedFiles?: number | null; skippedFiles?: number | null; lastSeenAt: string | null;
  lastSuccessfulSyncAt?: string | null; lastErrorCode?: string | null; revokedAt: string | null;
}
export interface DeviceComponent {
  id: string; name: string; platform: string; description: string; available: boolean;
  version?: string | null; sizeBytes?: number | null; archiveType?: string; downloadUrl?: string | null;
}
export interface AdapterHealth {
  provider: Provider; adapterVersion: string; lastCaptureAt?: string; averageMessageCount24h?: number;
  rates24h?: { success?: number; partial?: number; failed?: number };
  consecutiveFailures?: number; status: string; [key: string]: unknown;
}


export interface TaskStats {
  stage?: string; retryAt?: string; retryWindow?: string; retryBufferMs?: number;
  scope?: string; classified?: number; tagAssignments?: number; replacements?: number;
  candidateReasons?: Record<string, number>;
  failureSamples?: Array<{ conversationId?: string; title?: string; error?: string }>;
  snapshots?: number; imported?: number; unchanged?: number; failed?: number;
  totalConversations?: number; processedConversations?: number; analyzedConversations?: number; tagCount?: number;
}
export interface BackgroundTask {
  id: string; status: string; message?: string | null; error?: string | null;
  processedCount?: number; totalCount?: number; failedCount?: number;
  createdAt: string; updatedAt?: string; stats?: TaskStats | null;
}
export interface AnalysisRun extends BackgroundTask { kind: string; windowStart?: string; windowEnd?: string }
export interface Report {
  id: string; title: string; kind: string; summary: string; createdAt: string;
  periodStart: string; periodEnd: string; bodyMarkdown?: string;
  emailStatus: string; emailError?: string | null;
}
export interface ProjectConversation extends Conversation { lockedByUser?: boolean; confidence?: number | null; suggestedName?: string | null }
export interface ProjectGroup extends ProjectOption {
  growth7d?: number; growth30d?: number;
  conversations?: ProjectConversation[];
  commonTags?: Array<Tag & { count: number }>;
}
export interface ProjectTotals {
  projectCount?: number; archivedProjectCount?: number; activeProjectCount?: number;
  categorizedConversationCount?: number; unclassifiedConversationCount?: number; tagCount?: number;
}
export interface ProjectOverview { totals: ProjectTotals }
export interface ProjectMergeResult { sourceProjectIds: string[]; targetProjectName: string; movedConversationCount?: number; movedReportCount?: number }
export interface ImportJob extends BackgroundTask { provider?: Provider | null; filename?: string; fileName?: string; sizeBytes?: number }
export interface LogEntry {
  id: string; createdAt: string; entityType?: string | null; entityId?: string | null;
  scope: string; level: string; status?: string | null; message: string;
  device?: { name: string; kind: string } | null;
  metadata?: Record<string, unknown> | null;
}
export interface ActivityEntry { id: string; type: string; title: string; href?: string; message?: string; updatedAt: string; progress?: number; status: string; error?: string | null }
export interface ActivityResponse extends PageEnvelope<ActivityEntry> { summary: { active: number; failed: number; warnings: number } }
export interface ProjectCategory { projectId: string; projectName: string; description?: string | null; conversationCount: number; growth7d: number; tagCount: number; latestActivityAt: string | null }
export interface CategoryTotals { recentActiveCategoryCount?: number; activeCategoryCount?: number; emptyCategoryCount?: number; categorizedConversationCount?: number; unclassifiedConversationCount?: number; growth7d?: number }
export interface DashboardOrganization { conversationCount?: number; categoryStats?: ProjectCategory[]; categoryTotals?: CategoryTotals }
export interface DashboardTextStats {
  textUnits?: number; estimatedTokens?: number; calibratedEstimatedTokens?: number;
  calibratedEstimatedTokensLow?: number; calibratedEstimatedTokensHigh?: number;
  calibrationSampleCount?: number; usageBackedConversationCount?: number; tokenEstimateRule?: string;
}
export interface CaptureStatus { complete?: number; partial?: number; failed?: number }
export interface DashboardResponse extends DashboardOrganization {
  counts: { projects?: number; tags?: number; devices?: number; conversations?: number };
  captureProviders24h: Array<CaptureStatus & { provider: Provider }>;
  captureStatus24h: CaptureStatus;
  textStats?: DashboardTextStats;
  recentReports: Report[];
}
export interface ReliabilitySummary { needsAttention: number; items: Array<{ key: string; href: string; label: string; count: number }> }

export interface AuthSession { id: string; current: boolean; createdAt: string; expiresAt: string }
export interface TotpSetup { secret: string; otpauthUrl: string; expiresAt: string }
export interface RedactionRule { id: string; name?: string | null; pattern: string; replacement: string; enabled: boolean }
export interface SettingsResponse { settings: Record<string, string>; securityPack: { fullyEnabled: boolean }; redactionRules: RedactionRule[] }
export interface BackupVerification { ok: boolean; schemaVersion?: number; counts?: Record<string, number>; errors?: string[]; warnings?: string[] }
export interface RestoreJob { id: string; filename: string; phaseMessage?: string; status: string; updatedAt: string; error?: string | null; progress: number; warnings?: string[]; stagedAvailable: boolean }
export interface RedactionPreview { text: string; replacements: number }
export interface SystemAlert { level: string; metric: string; message: string }
export interface HostSample { collectedAt: string; cpuPercent: number; memoryPercent: number }
export interface HostResource { totalBytes: number; usedBytes: number; percent: number }
export type HostStatus = {
  history?: HostSample[]; alerts?: SystemAlert[]; error?: string;
} & ({ available: false } | { available: true; collectedAt: string; cpuPercent: number; memory: HostResource; swap: HostResource });
export interface ProjectStorage {
  usedBytes: number; budgetBytes: number | null; percent: number | null; databaseBytes: number;
  importBytes: number; importFiles: number; restoreBytes: number; restoreFiles: number;
  restoreFailedRetentionDays: number; importRetentionDays: { processed: number; failed: number };
  importBreakdown: Record<"inbox" | "processed" | "failed", { bytes: number; files: number }>;
  incomplete: boolean; alert?: SystemAlert | null;
}
export interface DatabaseStatus {
  sizeBytes: number; uptimeSeconds: number; connections: number; maxConnections: number;
  activeConnections: number; longestQuerySeconds: number; lastBackupAt: string | null; lastBackupFailureAt: string | null;
}
export interface SystemStatusResponse {
  collectedAt: string; host: HostStatus; database: DatabaseStatus; projectStorage: ProjectStorage;
  services: { app: { online: boolean; version: string; uptimeSeconds: number }; hostMonitor: { online: boolean }; postgres: { online: boolean } };
}
