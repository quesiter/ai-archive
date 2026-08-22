# 知言归藏 V2.1 数据模型

## 1. 原则

Conversation、Revision、Message、Message Segment 是事实来源。Project 与 Tag 是可修改的组织关系；Report 是周期输出；Project Context 在请求时生成，不保存为长期实体。

## 2. 关系概览

- devices 一对多 conversations。
- conversations 一对多 conversation_revisions。
- conversation_revisions 一对多 messages。
- messages 一对多 message_segments。
- conversations 一对零或一 conversation_projects；projects 一对多 conversation_projects。
- conversations 多对多 tags，通过 conversation_tags。
- reports 可选关联 projects。
- background_tasks、analysis_runs、capture_runs、import_jobs 和 operation_logs 保存运行记录。

## 3. 核心归档表

### conversations

稳定会话身份。关键字段：id、provider、externalSessionId、canonicalUrl、title、sourceDeviceId、source、updatedAt、deletedAt、createdAt。provider 与 externalSessionId 唯一。

### conversation_revisions

不可变修订元数据。关键字段：id、conversationId、capturedAt、captureMode、completeness、messageCount、contentHash、searchText、baseRevisionId、createdAt。完整修订在搜索、整理、报告和时间线中优先。

### messages

修订内逻辑消息。关键字段：id、revisionId、ordinal、role、sourceMessageId、sourceCreatedAt、createdAt。revisionId 与 ordinal 唯一。

### message_segments

消息内容分段。关键字段：id、messageId、ordinal、type、content、href、createdAt。messageId 与 ordinal 唯一。

### capture_runs

每次采集运行与结果统计，不参与业务组织。

## 4. 项目

### projects

字段：

| 字段 | 说明 |
| --- | --- |
| id | UUID 主键 |
| name | 项目名称，唯一 |
| description | 项目说明 |
| archived | 是否归档 |
| updatedAt / createdAt | 时间戳 |

### conversation_projects

| 字段 | 说明 |
| --- | --- |
| conversationId | 主键及会话外键 |
| projectId | 可空项目外键 |
| confidence | 自动判断置信度 |
| suggestedName | 未创建项目时的建议名 |
| lockedByUser | 人工项目锁 |
| updatedAt | 最后更新 |

一个会话只有一行项目关系。人工锁只保护 projectId、confidence 和 suggestedName，不阻止标签整理。

## 5. 标签

### tags

| 字段 | 说明 |
| --- | --- |
| id | UUID 主键 |
| name | 展示名称 |
| normalizedName | NFKC、空白折叠、大小写归一后的唯一名称 |
| updatedAt / createdAt | 时间戳 |

索引：

- tags_normalized_name_uidx：normalizedName 唯一。
- tags_name_idx：名称浏览与排序。

### conversation_tags

| 字段 | 说明 |
| --- | --- |
| conversationId | 会话外键，级联删除关系 |
| tagId | 标签外键，级联删除关系 |
| confidence | 自动置信度；人工标签可空 |
| source | auto 或 manual |
| lockedByUser | 是否禁止自动覆盖 |
| updatedAt / createdAt | 时间戳 |

conversationId 与 tagId 为复合主键。删除 Tag 只级联删除 conversation_tags，不删除 Conversation。

## 6. 分析、报告与任务

### analysis_runs

保存周报/月报运行窗口、状态、错误和统计。窗口按 Asia/Shanghai 计算。

### reports

字段包括 kind、projectId、periodStart、periodEnd、title、summary、bodyMarkdown、emailedAt 和 createdAt。历史报告在 V2.1 migration 中完整保留。

### background_tasks

通用后台任务。V2.1 当前 kind 包括 classification_rebuild 与 storage_redaction；报告和导入沿用各自运行表/队列记录。旧 knowledge_rebuild 行在 migration 和旧备份恢复时清理。

### settings

保存分类、AI、报告、邮件、备份和安全相关设置。加密值使用 APP_MASTER_KEY。

## 7. Migration 0012

执行顺序：

1. 创建 tags、normalizedName 唯一索引和名称索引。
2. 创建 conversation_tags、复合主键、外键、source/confidence 检查与查询索引。
3. 将遗留后台任务标记后删除，避免新 Worker 恢复未知任务。
4. 删除旧 knowledge_items 表。

Migration 不更新或删除 conversations、conversation_revisions、messages、message_segments、projects、conversation_projects 和 reports。原项目关系及 lockedByUser 原样保留。

## 8. 备份映射

V2.1 导出表包含：

devices、conversations、conversationRevisions、messages、messageSegments、captureRuns、projects、conversationProjects、tags、conversationTags、analysisRuns、backgroundTasks、reports、settings、redactionRules、importJobs、operationLogs。

旧备份额外出现 knowledgeItems 或 knowledge_items 时，解析器允许该键，恢复预处理会删除数据并返回 warning；不创建替代表。没有 tags/conversationTags 的旧备份按空表恢复，用户之后可运行项目与标签整理。
