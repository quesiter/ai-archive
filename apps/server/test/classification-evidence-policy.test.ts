import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const ids = vi.hoisted(() => ({
  conversation: "00000000-0000-4000-8000-000000000010",
  product: "00000000-0000-4000-8000-000000000001",
  other: "00000000-0000-4000-8000-000000000002",
  generic: "00000000-0000-4000-8000-000000000003",
  created: "00000000-0000-4000-8000-000000000004",
}));
const mocks = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; description: string }>,
  assignment: null as null | { projectId: string | null; confidence: number; suggestedName: string | null; lockedByUser: boolean; updatedAt: Date },
  writes: [] as Array<{ table: unknown; values: Record<string, unknown>; conflict?: unknown }>,
  parentSessionId: null as string | null,
  title: "CloudLedger 资产收发",
  messages: [] as Array<{ ordinal: number; role: string; content: string }>,
  archivedNameConflict: false,
  complete: vi.fn(),
  tags: vi.fn(),
  lineage: vi.fn(),
  redact: vi.fn(),
}));

vi.mock("../src/db.js", async () => {
  const schema = await import("../src/schema.js");
  return { db: {
    select: (fields?: Record<string, unknown>) => ({ from: (table: unknown) => {
      const rows = table === schema.conversations ? [{ id: ids.conversation,
        title: mocks.title, provider: "codex", externalSessionId: "test-session",
        parentExternalSessionId: mocks.parentSessionId, archiveUpdatedAt: new Date("2026-10-26T00:00:00Z") }]
        : table === schema.projects ? mocks.projects
        : table === schema.conversationProjects && !fields && mocks.assignment ? [{ ...mocks.assignment }]
        : [];
      const query: Record<string, unknown> = {};
      for (const method of ["where", "orderBy", "innerJoin"]) query[method] = () => query;
      query.limit = async () => rows;
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return query;
    } }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      const write: typeof mocks.writes[number] = { table, values };
      mocks.writes.push(write);
      return { onConflictDoUpdate: (conflict: unknown) => {
        write.conflict = conflict;
        return {
          returning: async () => table === schema.projects && !mocks.archivedNameConflict ? [{ id: ids.created }] : [],
          then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      } };
    } }),
  } };
});
vi.mock("../src/services/settings.js", () => ({
  getSetting: async () => null, getBooleanSetting: async () => false,
  getNumberSetting: async (_key: string, fallback: number) => fallback,
}));
vi.mock("../src/services/revision-storage.js", () => ({ loadCurrentConversationArchive: async () => ({
  revision: { id: "revision", capturedTitle: mocks.title, metadataCaptured: true, capturedAt: new Date("2026-10-26T00:00:00Z") },
  messages: mocks.messages.map((message) => ({ ...message, createdAt: new Date("2026-10-26T00:00:00Z"),
    segments: [{ type: "text", content: message.content }] })),
}) }));
vi.mock("../src/services/redaction.js", () => ({
  loadEnabledCustomRedactionRules: async () => [],
  redactForCloud: mocks.redact,
}));
vi.mock("../src/services/llm.js", async (original) => ({
  ...await original<typeof import("../src/services/llm.js")>(), completeStructured: mocks.complete,
}));
vi.mock("../src/services/tags.js", async (original) => ({
  ...await original<typeof import("../src/services/tags.js")>(), persistAutoTags: mocks.tags,
}));
vi.mock("../src/services/classification-lineage-context.js", () => ({ loadClassificationLineageContext: mocks.lineage }));

import {
  classifyConversation,
  cleanClassificationText,
  loadConversationMaterial,
  projectRelevanceScore,
  hasIndependentSubtaskEvidence,
  userNamesClassificationTopic,
} from "../src/services/analysis.js";
import { conversationProjects, projects } from "../src/schema.js";

const classify = () => classifyConversation(ids.conversation, "full");
const prompt = () => JSON.parse(mocks.complete.mock.calls[0]![0].user);
const assignmentWrite = () => mocks.writes.find((write) => write.table === conversationProjects)?.values;
const response = (projectId: string | null, confidence: number, suggestedProjectName?: string) => ({
  project: { projectId, confidence, suggestedProjectName, rationale: "用户要求“CloudLedger 资产收发的入库流程”，这是独立的资产业务任务。" }, tags: [],
});
const setPrior = (projectId = ids.product) => { mocks.assignment = {
  projectId, confidence: 0.95, suggestedName: "以前错误的另一项目建议", lockedByUser: false,
  updatedAt: new Date("2026-10-25T00:00:00Z"),
}; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects = [{ id: ids.product, name: "CloudLedger 资产收发", description: "人员、资产发放归还与采购" }];
  mocks.assignment = null;
  mocks.writes = [];
  mocks.title = "CloudLedger 资产收发";
  mocks.parentSessionId = null;
  mocks.archivedNameConflict = false;
  mocks.messages = [{ ordinal: 0, role: "user", content: "CloudLedger 资产收发的入库流程与人员归还需要修正。" }];
  mocks.complete.mockResolvedValue(response(ids.product, 0.9));
  mocks.tags.mockResolvedValue([]);
  mocks.lineage.mockResolvedValue(null);
  mocks.redact.mockImplementation(async (text: string) => ({ text: text.replace(/private-evidence/g, "[MASKED]"), replacements: 0 }));
});

describe("classification evidence policy", () => {
  it("cleans runtime and AGENTS blocks before the classification budget, while leaving report material intact", async () => {
    const envelope = `# AGENTS.md instructions for F:\\repo\n<INSTRUCTIONS>${"Codex metadata ".repeat(1000)}</INSTRUCTIONS>\n<environment_context><cwd>F:\\repo</cwd></environment_context>\n<skills_instructions>OpenAI tools</skills_instructions>`;
    mocks.messages[0]!.content = `${envelope}\n请修正CloudLedger的真实入库流程，文件在F:\\repo\\src\\stock.ts。`;
    const raw = await loadConversationMaterial(ids.conversation);
    expect(raw?.text).toContain("Codex metadata");
    await classify();
    expect(prompt().conversation.content).not.toMatch(/Codex metadata|environment_context|skills_instructions|AGENTS/);
    expect(prompt().conversation.content).toContain("请修正CloudLedger的真实入库流程");
    expect(prompt().conversation.content).toContain("F:\\repo\\src\\stock.ts");
  });

  it("keeps actual answers and ordinary instruction text instead of removing every INSTRUCTIONS block", () => {
    const text = "保留这段文档：<INSTRUCTIONS>真实用户要审查的规则</INSTRUCTIONS>\n<send_user_message_question_reply>人工答复：归入CloudLedger</send_user_message_question_reply>";
    expect(cleanClassificationText(text)).toContain("真实用户要审查的规则");
    expect(cleanClassificationText(text)).toContain("人工答复");
  });

  it("skips an envelope-only capture without inventing a project", async () => {
    mocks.messages = [{ ordinal: 0, role: "user", content: "<environment_context><cwd>F:\\repo</cwd></environment_context>" }];
    expect(await classify()).toMatchObject({ skipped: true, reason: "empty" });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });

  it("does not give archive or network buckets relevance merely for platform and transport words", () => {
    expect(projectRelevanceScore({ title: "Codex NAS_Network", text: "OpenAI SSH 工作" }, { id: ids.generic, name: "AI 对话归档", description: "" })).toBe(0);
    expect(projectRelevanceScore({ title: "Codex", text: "SSH TLS" }, { id: ids.generic, name: "网络安全与系统运维", description: "" })).toBe(0);
  });

  it.each(["知言归藏 AI-archive 系统开发", "个人工作台workbench Web与Android全栈产品开发"])("retains the existing long-term product %s as a candidate", async (name) => {
    mocks.projects = [{ id: ids.product, name, description: "真实已有产品" }];
    mocks.title = "检查产品完善度";
    mocks.messages[0]!.content = `请继续改进${name}的实际功能。`;
    await classify();
    expect(prompt().projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids.product, name })]));
    expect(assignmentWrite()).toMatchObject({ projectId: ids.product });
  });

  it("keeps a valid prior outside the 80 relevance candidates and keeps its suggestion consistent", async () => {
    mocks.projects.push(...Array.from({ length: 85 }, (_, i) => ({ id: `gpu-${i}`, name: `GPU算力研究${i}`, description: "GPU" })));
    mocks.title = "GPU cluster";
    mocks.messages[0]!.content = "GPU性能比较";
    setPrior();
    mocks.complete.mockResolvedValue(response("gpu-0", 0.81, "新的错误建议"));
    expect(await classify()).toMatchObject({ projectId: ids.product, reason: "kept_prior", confidence: 0.95, suggestedName: "CloudLedger 资产收发" });
    expect(prompt().projects.some((p: { id: string }) => p.id === ids.product)).toBe(true);
    expect(assignmentWrite()).toMatchObject({ projectId: ids.product, suggestedName: "CloudLedger 资产收发", confidence: 0.95 });
  });

  it.each([0.819, 0.82])("requires 0.82 evidence confidence for an existing project (%s)", async (confidence) => {
    mocks.complete.mockResolvedValue(response(ids.product, confidence));
    const result = await classify();
    expect(result.projectId).toBe(confidence >= 0.82 ? ids.product : null);
    expect(mocks.writes.some((write) => write.table === projects)).toBe(false);
  });

  it.each([0.879, 0.88])("requires 0.88 for a new project when an active catalog exists (%s)", async (confidence) => {
    mocks.title = "NovaCapture 浏览器采集";
    mocks.messages[0]!.content = "NovaCapture 会话归档支持浏览器采集和服务端保存。";
    mocks.complete.mockResolvedValue(response(null, confidence, "NovaCapture 会话归档"));
    expect((await classify()).projectId).toBe(confidence >= 0.88 ? ids.created : null);
  });

  it.each([0.849, 0.85])("requires 0.85 for a new project in an empty catalog (%s)", async (confidence) => {
    mocks.projects = [];
    mocks.title = "NovaCapture 浏览器采集";
    mocks.messages[0]!.content = "NovaCapture 会话归档支持浏览器采集和服务端保存。";
    mocks.complete.mockResolvedValue(response(null, confidence, "NovaCapture 会话归档"));
    expect((await classify()).projectId).toBe(confidence >= 0.85 ? ids.created : null);
  });

  it.each(["AI 对话归档", "网络安全与系统运维", "应用开发"])("does not create the fallback bucket %s or replace a valid prior with it", async (name) => {
    setPrior();
    mocks.messages[0]!.content += ` 这里提到了${name}这个名词。`;
    mocks.complete.mockResolvedValue(response(null, 0.99, name));
    expect(await classify()).toMatchObject({ projectId: ids.product, suggestedName: "CloudLedger 资产收发", confidence: 0.95, reason: "kept_prior" });
    expect(mocks.writes.some((write) => write.table === projects)).toBe(false);
  });

  it("leaves a rejected over-specific suggestion unclassified instead of coarsening Codex into archive", async () => {
    mocks.title = "Codex 修正一个报错";
    mocks.messages[0]!.content = "请用Codex修正今天的CloudLedger入库和资产归还错误。";
    mocks.complete.mockResolvedValue(response(null, 0.99, "CloudLedger入库和资产归还错误修复实施任务"));
    expect(await classify()).toMatchObject({ projectId: null, suggestedName: null });
    expect(mocks.writes.some((write) => write.table === projects)).toBe(false);
  });

  it.each(["user", "assistant", "environment"])("does not use a %s mention to infer a historical generic bucket", async (source) => {
    mocks.projects.push({ id: ids.generic, name: "AI 对话归档", description: "Codex和OpenAI工具" });
    const mention = source === "user" ? "请把错误项目AI 对话归档拆分重组。"
      : source === "assistant" ? "项目名称为AI 对话归档。"
      : "<environment_context>项目名称为AI 对话归档。</environment_context>";
    mocks.messages.push({ ordinal: 1, role: source === "assistant" ? "assistant" : "user", content: mention });
    mocks.complete.mockResolvedValue(response(ids.generic, 0.99));
    expect((await classify()).projectId).toBeNull();
  });

  it("allows an existing independent generic topic explicitly named in the actual user request", async () => {
    mocks.projects.push({ id: ids.generic, name: "金融市场与投资研究", description: "长期基金研究" });
    mocks.messages = [{ ordinal: 0, role: "user", content: "我的研究主题名称为金融市场与投资研究。请继续整理长期基金观察记录。" }];
    mocks.complete.mockResolvedValue(response(ids.generic, 0.82));
    expect((await classify()).projectId).toBe(ids.generic);
    expect(userNamesClassificationTopic("请拆分项目名称为金融市场与投资研究的错误会话。", "金融市场与投资研究")).toBe(false);
  });

  it.each([
    "请核对下面历史摘录：“项目名称是网络安全与系统运维”。",
    "这是一段历史摘录：\n项目名称是网络安全与系统运维。",
    "> 项目名称是网络安全与系统运维。",
    "```text\n项目名称是网络安全与系统运维。\n```",
    "“项目名称是网络安全与系统运维”。",
  ])("does not open a generic-topic exception for quoted historical text: %s", (text) => {
    expect(userNamesClassificationTopic(text, "网络安全与系统运维")).toBe(false);
  });

  it("does not revive an archived project through a normalized-name conflict", async () => {
    mocks.projects = [];
    mocks.archivedNameConflict = true;
    mocks.title = "NovaCapture 浏览器采集";
    mocks.messages[0]!.content = "NovaCapture 会话归档支持浏览器采集和服务端保存。";
    mocks.complete.mockResolvedValue(response(null, 0.99, "NovaCapture 会话归档"));
    expect(await classify()).toMatchObject({ projectId: null, reason: "archived_project_name_conflict" });
    const conflict = mocks.writes.find((write) => write.table === projects)!.conflict as { setWhere: Parameters<PgDialect["sqlToQuery"]>[0] };
    expect(new PgDialect().sqlToQuery(conflict.setWhere)).toMatchObject({ sql: '"projects"."archived" = $1', params: [false] });
    expect(assignmentWrite()).toMatchObject({ projectId: null });
  });

  it("keeps the prior on model errors without guessing from a title or a project name in the body", async () => {
    setPrior();
    mocks.complete.mockRejectedValue(Object.assign(new Error("input new_sensitive"), { status: 422 }));
    expect(await classify()).toMatchObject({ projectId: ids.product, suggestedName: "CloudLedger 资产收发", reason: "ai_fallback_kept_prior" });
    expect(mocks.writes).toEqual([]);
    mocks.assignment = null;
    expect((await classify()).projectId).toBeNull();
    expect(mocks.writes).toEqual([]);
  });

  it("adds redacted parent evidence and candidates while allowing a separately evidenced child product", async () => {
    mocks.parentSessionId = "parent-session";
    mocks.projects.push({ id: ids.other, name: "OtherProduct 独立产品", description: "外部真实目标" });
    mocks.lineage.mockResolvedValue({ evidenceOnly: true, root: null, rootIsParent: true, rootResolution: "complete", candidateProjectIds: [ids.other],
      parent: { conversationId: "parent", title: "private-evidence", assignmentLockedByUser: true,
        project: { id: ids.other, name: "OtherProduct 独立产品", description: "private-evidence", lockedByUser: true },
        userRequests: ["private-evidence"], latestAssistantExcerpt: "private-evidence" } });
    await classify();
    expect(mocks.lineage).toHaveBeenCalledWith(ids.conversation);
    expect(prompt().lineageContext.parent.project.id).toBe(ids.other);
    expect(prompt().lineageContext.parent.userRequests).toEqual(["[MASKED]"]);
    expect(JSON.stringify(prompt().lineageContext)).not.toContain("private-evidence");
    expect(prompt().projects.some((p: { id: string }) => p.id === ids.other)).toBe(true);
    expect(assignmentWrite()).toMatchObject({ projectId: ids.product });
    expect(mocks.complete.mock.calls[0]![0].system).toContain("不要求整树同项目");
  });

  it("does not divert a child away from ancestor projects without independent task rationale", async () => {
    mocks.parentSessionId = "parent-session";
    mocks.lineage.mockResolvedValue({ evidenceOnly: true, root: null, rootIsParent: true, rootResolution: "complete", candidateProjectIds: [ids.other],
      parent: { conversationId: "parent", title: "Parent", assignmentLockedByUser: false, project: null, userRequests: [], latestAssistantExcerpt: null } });
    mocks.complete.mockResolvedValue({ project: { projectId: ids.product, confidence: 0.99 }, tags: [] });
    expect(await classify()).toMatchObject({ projectId: null, reason: "missing_independent_task_evidence" });
  });

  it.each(["", "根据子任务独立判断", "用户说“这段原文从未出现在请求中”"])("does not create a child project without a verified user quote (%s)", async (rationale) => {
    mocks.parentSessionId = "parent-session";
    mocks.lineage.mockResolvedValue({ evidenceOnly: true, root: null, rootIsParent: true, rootResolution: "complete", candidateProjectIds: [ids.other],
      parent: { conversationId: "parent", title: "Parent", assignmentLockedByUser: false, project: null, userRequests: [], latestAssistantExcerpt: null } });
    mocks.title = "NovaCapture 浏览器采集";
    mocks.messages[0]!.content = "NovaCapture 会话归档支持浏览器采集和服务端保存。";
    mocks.complete.mockResolvedValue({ project: { projectId: null, suggestedProjectName: "NovaCapture 会话归档", confidence: 0.99, rationale }, tags: [] });
    expect(await classify()).toMatchObject({ projectId: null, reason: "missing_independent_task_evidence" });
    expect(mocks.writes.some((write) => write.table === projects)).toBe(false);
  });

  it("allows a newly named independent child project with a real recent request quote", async () => {
    mocks.parentSessionId = "parent-session";
    mocks.lineage.mockResolvedValue({ evidenceOnly: true, root: null, rootIsParent: true, rootResolution: "complete", candidateProjectIds: [ids.other],
      parent: { conversationId: "parent", title: "Parent", assignmentLockedByUser: false, project: null, userRequests: [], latestAssistantExcerpt: null } });
    mocks.title = "NovaCapture 浏览器采集";
    mocks.messages[0]!.content = "NovaCapture 会话归档支持浏览器采集和服务端保存。";
    mocks.complete.mockResolvedValue({ project: { projectId: null, suggestedProjectName: "NovaCapture 会话归档", confidence: 0.99,
      rationale: "用户要求“NovaCapture 会话归档支持浏览器采集”，这是与父产品不同的独立产品。" }, tags: [] });
    expect((await classify()).projectId).toBe(ids.created);
    expect(hasIndependentSubtaskEvidence("只写“Codex OpenAI SSH 工具”", "Codex OpenAI SSH 工具")).toBe(false);
  });
});
