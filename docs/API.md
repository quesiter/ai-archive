# 知言归藏 V2.1 API

## 1. 约定

API 基础路径为 /api/v1。除健康检查、认证初始化/登录和设备认领外，Web API 需要有效 Cookie Session；采集 API 使用设备 Bearer Token。请求和响应为 JSON，文件导出除外。所有动态响应设置 Cache-Control: no-store。

UUID 路径参数和查询参数由 Zod 校验；非法值返回 400。未认证返回 401，不存在返回 404，冲突返回 409。

## 2. 健康与认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /healthz | 数据库可用时返回 ok、version V2.1.0 和 time |
| GET | /api/v1/auth/status | 是否已初始化 |
| POST | /api/v1/auth/bootstrap | 首次创建用户与 TOTP |
| POST | /api/v1/auth/login | 密码与六位 TOTP 登录 |
| POST | /api/v1/auth/logout | 注销 Cookie Session |
| GET | /api/v1/auth/me | 当前用户 |

## 3. 采集

POST /api/v1/captures

设备认证接口。接收 CapturePayloadSchema：provider、externalSessionId、canonicalUrl、title、capturedAt、captureMode、completeness、messages 等。服务端执行入库脱敏、会话身份幂等、完整/追加修订保存和自动整理入队。响应包含 conversationId、revisionId、duplicate 和 captureRunId。

## 4. 会话与搜索

### GET /api/v1/conversations

查询参数：

| 参数 | 说明 |
| --- | --- |
| q | 标题与正文关键词，最长 500 |
| provider | 平台 |
| source | web、openclaw、codex、claude_code、historical_import |
| completeness | complete 或 partial |
| captureMode | full、append 或 import |
| projectId | 主项目 UUID |
| tagIds | 逗号分隔标签 UUID；多个标签采用 AND |
| from / to | 带时区 ISO 时间 |
| limit / offset | 分页，limit 最大 200 |

每项包含会话、主项目、标签、最新修订。搜索命中另含 searchHit：

- reason：标题命中或正文命中。
- revisionId：应打开的修订。
- messageOrdinal：正文命中的消息序号。
- excerpt：附近摘要。

### 其他会话接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/v1/conversations/provider-counts | 平台数量 |
| GET | /api/v1/conversations/:id?revisionId= | 详情、全部修订、选中修订消息、项目与标签 |
| GET | /api/v1/conversations/:id/export?format=csv|md|xlsx | 原始会话导出 |
| DELETE | /api/v1/conversations/:id | 永久删除会话及级联关系 |

Web 定位路径为 /conversations/:id?revisionId=:revisionId#message-:ordinal。

## 5. 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/v1/projects | 项目列表，含归档状态、真实会话量、近 7/30 日增长和常见标签 |
| GET | /api/v1/projects/overview | 项目与标签页聚合数据、归档项目及统计 |
| POST | /api/v1/projects | 创建项目 |
| PATCH | /api/v1/projects/:id | 编辑名称、描述或 archived |
| POST | /api/v1/projects/:id/merge | 合并到 targetProjectId |
| GET | /api/v1/projects/:id/export?format=csv|md|xlsx | 项目原始会话导出 |
| GET | /api/v1/unclassified | 待归类会话 |
| PUT | /api/v1/conversations/:id/project | 指定或解锁主项目 |

PUT 项目请求：

~~~json
{
  "projectId": "uuid-or-null",
  "mode": "lock"
}
~~~

mode=lock 将 lockedByUser 设为 true；mode=auto 解锁并重新入队整理。归档项目继续可查询和导出，但不能作为新的 projectId；恢复后才可再次分配。

### 时间线

GET /api/v1/projects/:id/timeline?limit=100&offset=0

响应包含 project、total 和 items。item 含 conversationId、revisionId、capturedAt、provider、title、tags 和 href。每个会话选最新完整修订。

### Context

POST /api/v1/projects/:id/context

请求：

~~~json
{ "ai": true }
~~~

返回 text/markdown 附件 PROJECT-CONTEXT.md。ai 默认 true 并使用 interactive 优先级；false 只生成确定性项目索引和来源。

## 6. 标签

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/v1/tags?q= | 标签列表、搜索及 conversationCount |
| POST | /api/v1/tags | 创建或按 normalizedName 复用 |
| PATCH | /api/v1/tags/:id | 重命名 |
| POST | /api/v1/tags/:id/merge | 合并到 targetTagId |
| DELETE | /api/v1/tags/:id | 删除标签及关系，不删除会话 |
| POST | /api/v1/conversations/:id/tags | 人工新增标签 |
| PATCH | /api/v1/conversations/:id/tags/:tagId | 修改 lockedByUser |
| DELETE | /api/v1/conversations/:id/tags/:tagId | 移除会话标签 |

人工新增请求为 name 和可选 lockedByUser；默认锁定、source=manual、confidence=1。合并会保留两边最高置信度，任一为 manual/locked 时保留保护状态。

## 7. 项目与标签自动整理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/v1/classification/run | 启动或复用整理任务 |
| GET | /api/v1/classification/tasks/latest | 最新任务 |
| GET | /api/v1/classification/tasks/:id | 指定任务 |

运行请求可带 mode=economy|full 与 scope=incremental|all。响应 202，包含 jobId、task 和可选 reused。任务 stats 包含 classified、tagAssignments、scope、mode，以及额度延迟时的 retryAt、quotaResetAt 和 resumeOffset。

## 8. 报告

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/v1/reports | 报告列表 |
| GET | /api/v1/reports/:id | 报告详情 |
| GET | /api/v1/analysis/runs | 周报/月报运行 |
| POST | /api/v1/analysis/run | 生成 weekly 或 monthly |

报告直接从周期内最新完整会话修订、项目、标签和正文生成；月报还可使用周报。分析运行支持额度延迟续跑。

## 9. 备份与导入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/v1/backups/export | 下载 gzip JSON 业务备份 |
| POST | /api/v1/backups/import | 上传并恢复业务备份 |
| GET | /api/v1/imports | 历史归档导入任务 |
| POST | /api/v1/imports | 上传官方导出 ZIP |

V2.1 备份包含 tags 和 conversationTags。V2.0.2 备份中的 knowledgeItems 或 knowledge_items 被允许、忽略并在 warnings 返回说明；旧 knowledge_rebuild task 被过滤。

## 10. 设备与组件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/v1/pairing-codes | 创建一次性配对码 |
| POST | /api/v1/devices/claim | 用配对码领取设备 Token |
| GET | /api/v1/devices | 设备列表 |
| GET | /api/v1/devices/:id | 设备详情 |
| PATCH | /api/v1/devices/:id | 重命名 |
| DELETE | /api/v1/devices/:id | 撤销 |
| GET | /api/v1/device-components | 客户端组件下载状态 |

## 11. 设置、脱敏与状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / PUT | /api/v1/settings | 读取或保存设置 |
| POST | /api/v1/settings/llm/test | interactive 模型连接测试 |
| POST | /api/v1/redaction-rules | 新建规则 |
| PATCH / DELETE | /api/v1/redaction-rules/:id | 修改或删除规则 |
| POST | /api/v1/redaction-rules/test | 测试脱敏 |
| POST | /api/v1/redaction-rules/security-pack | 安装安全规则包 |
| POST / GET | /api/v1/redaction/storage-cleanup | 启动/查看历史入库清理 |
| GET | /api/v1/dashboard | Dashboard 聚合 |
| GET | /api/v1/activity | 后台活动 |
| GET | /api/v1/logs | 操作日志 |
| GET | /api/v1/system/status | 应用、队列、数据库、容器和资源状态 |
