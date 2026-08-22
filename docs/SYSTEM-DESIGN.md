# 知言归藏 V2.1 系统设计

## 1. 架构目标

系统围绕原始 AI 会话构建。PostgreSQL 中的 Conversation、Revision、Message 和 Segment 是事实来源；项目和标签只提供可修改的组织视图，报告与 Context 是按需生成的输出。

数据流：

Chrome 或本地同步代理 → Fastify API → PostgreSQL 版本化归档 → 项目与标签整理 → 搜索、时间线、报告与 Context 导出。

## 2. 运行组件

- apps/server：Fastify API、数据库迁移、Web 静态资源和交互式 Context 请求。
- apps/server worker：PgBoss 批量整理、周报、月报、邮件与维护任务。
- apps/server host-monitor：只读读取容器 cgroup 指标。
- apps/web：React 管理后台。
- apps/extension：Chrome 会话采集、断点与本地上传队列。
- apps/openclaw-sync：Windows/macOS 上扫描 OpenClaw、Codex、Claude Code 文件并同步。
- packages/contracts：客户端与服务端共享 Zod 协议。
- PostgreSQL：业务数据和 PgBoss 队列。

## 3. 归档模型

Conversation 以 provider 与 externalSessionId 保持稳定身份。每次捕获创建或复用 Revision；完整快照和追加修订通过 revision-storage 重构成逻辑完整消息序列。内容哈希保证相同快照幂等，旧修订永久可追溯。

任何项目、标签、搜索、报告或 Context 逻辑都不能修改消息正文。

## 4. 项目与标签

conversation_projects 保存每条会话的单一主项目、置信度、建议名和项目锁。projects 支持归档，不删除原始会话。

tags 使用 normalizedName 唯一。conversation_tags 使用 conversationId 与 tagId 复合主键，并保存 confidence、source 和 lockedByUser。

自动整理流程：

1. 读取最新优先完整修订。
2. 读取未归档项目、近期项目示例和已有标签。
3. 对正文执行云端脱敏。
4. 请求结构化项目与标签结果。
5. 校验项目粒度、标签稳定性、置信度和上限。
6. 保留项目锁；保留人工或锁定标签；只替换未锁定自动标签。
7. 记录后台任务进度，遇额度限制保存断点并延迟续跑。

增量候选包括未归类、低置信度、修订变化和无标签会话。续跑把候选 id 列表与 offset 固定下来，避免已处理行状态变化导致跳项。

## 5. AI 优先级

completeStructured 接收 priority：

- interactive：用户主动测试模型或生成项目 Context，不施加批处理固定间隔。
- batch：自动整理、周报和月报，继续使用全局节流与 Token Plan 调度。

两类请求共用模型配置、结构化 JSON 校验、错误识别和脱敏。额度错误可解析 retryAt 或 quotaResetAt；后台任务保存 resumeOffset 后重新入队。

## 6. 搜索

列表查询先用 Conversation 标题和 Revision searchText 缩小范围，再在消息段中定位正文命中，返回 revisionId、messageOrdinal、命中原因和附近摘要。

项目过滤连接 conversation_projects。多标签过滤先收集 conversation_tags，再按会话统计是否覆盖所有请求标签，语义为 AND。其他过滤保留 provider、source、completeness、captureMode 和日期范围。

## 7. 时间线

项目时间线读取项目下所有未删除会话，并为每个会话选择：

1. complete 优先于 partial；
2. capturedAt 较新优先；
3. createdAt 较新优先；
4. id 作为稳定决胜。

响应包含标题、provider、修订、时间、标签及可直接打开的会话路径。时间线不调用 AI。

## 8. Project Context

POST /api/v1/projects/:id/context 在请求时生成 Markdown。确定性部分由数据库构建：项目说明、规模、标签、活动、历史索引和原始来源。默认以 interactive 优先级让模型生成一段项目级整体上下文；请求可关闭 AI，只导出确定性内容。结果作为附件返回，不引入持久化实体或定时重建。

## 9. 报告

报告服务按窗口选取发生变化的会话，并仅采用最新完整修订。输入包含项目、标签和必要消息正文。周报直接从会话生成；月报还可引用同月周报。生成结果只写 reports。

## 10. 队列与定时任务

现有队列保留 capture、classification、report、email、storage-redaction、import 和 nightly-ai-maintenance 等任务。夜间任务在 Asia/Shanghai 22:00 运行增量项目与标签整理；无候选时直接完成。

Worker 启动恢复仍处理当前有效任务，未知或已移除的旧任务在 migration/restore 时被清理。

## 11. 备份恢复

新备份流式或内存导出当前业务表，包括 tags 与 conversationTags。恢复按反向依赖顺序清空、按依赖顺序批量插入并恢复日期字段。

解析器允许旧 knowledgeItems 与 knowledge_items 键；预处理阶段删除它们并返回 warning。旧 knowledge_rebuild background task 同样被过滤。APP_MASTER_KEY 指纹不一致时跳过加密设置。

## 12. 安全边界

- Web 使用密码、TOTP 和 HttpOnly Cookie Session。
- 设备使用只存哈希的 Bearer Token。
- 外部目标通过协议、地址和 DNS 结果检查，阻止 SSRF 与 DNS Rebinding。
- 入库前清理常见密钥、认证头、私网地址和自定义规则。
- 发给模型前再次脱敏；会话内容被视为不可信数据。
- Fastify 设置 HSTS、CSP、COOP、Permissions Policy 和 no-store。
- 容器以 node 用户、只读根文件系统、no-new-privileges 和 capability drop 运行。
- 操作日志和后台错误进入存储前再次过滤。

## 13. 兼容性

旧 /classification 前端路径只做重定向到 /projects；当前信息架构和 API 以项目与标签为准。数据库 migration 0012 不改写 Conversation、Revision、Message、Project Assignment、项目锁或 Report。
