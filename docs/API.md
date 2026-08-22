# API 文档

## 1. 通用约定

基础路径：

```text
/api/v1
```

认证方式：

| 调用方 | 认证方式 |
| --- | --- |
| Web 后台 | Cookie Session，登录后由浏览器自动携带。 |
| Chrome 插件 | `Authorization: Bearer <deviceToken>`。 |
| 本地同步代理 | `Authorization: Bearer <deviceToken>`。 |
| 设备配对领取 | 使用一次性配对码，不需要已有登录态。 |

请求格式：

1. 普通 API 使用 JSON。
2. ZIP 上传使用 `multipart/form-data`。
3. 采集上传支持 `Content-Encoding: gzip` 的 JSON。

错误格式：

```json
{
  "error": "错误说明",
  "issues": []
}
```

`issues` 只在 Zod 校验失败等场景返回。

## 2. 认证接口

### 2.1 获取初始化状态

```http
GET /api/v1/auth/status
```

用途：判断系统是否已创建管理员账号。

响应：

```json
{
  "bootstrapped": true
}
```

### 2.2 初始化管理员

```http
POST /api/v1/auth/bootstrap
Content-Type: application/json
```

请求：

```json
{
  "username": "admin",
  "password": "your-password"
}
```

用途：首次部署时创建管理员，并返回 TOTP Secret/URI。初始化后不可重复调用。

### 2.3 登录

```http
POST /api/v1/auth/login
Content-Type: application/json
```

请求：

```json
{
  "username": "admin",
  "password": "your-password",
  "totp": "123456"
}
```

响应：设置 Web Session Cookie。

### 2.4 登出

```http
POST /api/v1/auth/logout
```

用途：清除当前 Web Session。

### 2.5 当前用户

```http
GET /api/v1/auth/me
```

用途：返回当前登录用户信息。

## 3. 设备与配对

### 3.1 领取配对码

```http
POST /api/v1/devices/claim
Content-Type: application/json
```

请求：

```json
{
  "code": "ABCD1234",
  "kind": "chrome_extension"
}
```

`kind` 可选：

```text
chrome_extension, openclaw_sync, importer
```

说明：

1. 设备侧不需要提交设备名称。
2. 设备名称来自后台创建配对码时填写的 `name`。

响应：

```json
{
  "deviceId": "uuid",
  "token": "device-token",
  "name": "Chrome 工作电脑"
}
```

### 3.2 设备列表

```http
GET /api/v1/devices
```

认证：Web 登录。

响应字段：

```json
[
  {
    "id": "uuid",
    "name": "Chrome 工作电脑",
    "kind": "chrome_extension",
    "createdAt": "2026-07-25T00:00:00.000Z",
    "lastSeenAt": "2026-07-25T01:00:00.000Z",
    "revokedAt": null
  }
]
```

### 3.3 创建配对码

```http
POST /api/v1/pairing-codes
Content-Type: application/json
```

认证：Web 登录。

请求：

```json
{
  "name": "MacBook OpenClaw",
  "kind": "openclaw_sync"
}
```

响应：

```json
{
  "code": "ABCD1234",
  "expiresAt": "2026-07-25T01:10:00.000Z"
}
```

### 3.4 编辑设备名称

```http
PATCH /api/v1/devices/:id
Content-Type: application/json
```

认证：Web 登录。

请求：

```json
{
  "name": "新设备名称"
}
```

### 3.5 撤销或删除设备

```http
DELETE /api/v1/devices/:id
```

认证：Web 登录。

行为：

1. 未撤销设备：设置 `revokedAt`，设备令牌失效。
2. 已撤销设备：从设备列表中删除。

### 3.6 下载采集组件

```http
GET /api/v1/device-components
GET /api/v1/device-components/:id/download
```

认证：Web 管理员登录。

`id` 可选：`chrome`、`windows`、`macos`。列表接口返回服务器当前检测到的安装包版本、大小、更新时间和下载地址；下载接口只允许读取配置发布目录中符合命名规则的 ZIP/TAR.GZ 文件。

## 4. 采集上传

### 4.1 上传采集快照

```http
POST /api/v1/captures
Authorization: Bearer <deviceToken>
Content-Type: application/json
Content-Encoding: gzip
Idempotency-Key: <client-generated-key>
```

请求体：`CaptureSnapshotV1` 或 `CaptureDeltaV1`。

示例：

```json
{
  "schemaVersion": 1,
  "provider": "qianwen",
  "sessionId": "63305538ba904a5b9ac04f4086119210",
  "branchFingerprint": "default-branch",
  "title": "示例会话",
  "canonicalUrl": "https://www.qianwen.com/chat/63305538ba904a5b9ac04f4086119210",
  "adapterVersion": "1.3.0",
  "capturedAt": "2026-07-25T04:00:00.000Z",
  "captureMode": "full",
  "triggerReason": "new_session",
  "completeness": {
    "status": "complete",
    "topReached": true,
    "bottomReached": true,
    "stable": true
  },
  "messages": [
    {
      "ordinal": 0,
      "role": "user",
      "segments": [
        {
          "type": "text",
          "content": "你好"
        }
      ]
    }
  ]
}
```

响应：

```json
{
  "conversationId": "uuid",
  "revisionId": "uuid",
  "messageCount": 12,
  "completeness": "complete",
  "captureMode": "full",
  "triggerReason": "new_session",
  "unchanged": false
}
```

增量请求示例：

```json
{
  "schemaVersion": 1,
  "captureMode": "append",
  "provider": "chatgpt",
  "sessionId": "session-id",
  "branchFingerprint": "branch-fingerprint",
  "adapterVersion": "1.2.1",
  "capturedAt": "2026-07-25T04:10:00.000Z",
  "triggerReason": "stream_finished",
  "baseRevisionId": "uuid",
  "baseMessageCount": 12,
  "baseLastMessageId": "message-12",
  "appendedMessages": []
}
```

说明：

1. `complete` 快照必须同时满足 `topReached`、`bottomReached`、`stable`。
2. 服务端按 `provider + sessionId` 定位会话。
3. 内容未变时返回 `unchanged: true`。
4. `append` 会校验最新完整基线、消息数量、最后消息 ID 或正文指纹、ordinal 连续性和重复外部消息 ID。
5. 增量基线不一致时返回 `409`：

```json
{
  "error": "incremental_base_mismatch",
  "message": "Incremental base message count does not match",
  "requiresFullCapture": true
}
```

6. 采集失败会写入 `capture_runs` 和操作日志；无变化跳过不写持久化成功日志。

## 5. 会话接口

### 5.1 会话列表

```http
GET /api/v1/conversations?q=&provider=&source=&completeness=&captureMode=&from=&to=&limit=50&offset=0
```

认证：Web 登录。

参数：

| 参数 | 说明 |
| --- | --- |
| `q` | 搜索标题或修订搜索文本。 |
| `provider` | 平台过滤。 |
| `source` | 来源过滤：`web`、`openclaw`、`codex`、`claude_code`、`historical_import`。 |
| `completeness` | `complete` 或 `partial`。 |
| `captureMode` | `full`、`append`、`import`。 |
| `from` / `to` | ISO 时间范围，按修订采集时间过滤。 |
| `limit` | 1 到 200，默认 50。 |
| `offset` | 偏移量，默认 0。 |

响应：会话摘要数组，包含项目归属、最新修订摘要、来源设备名、采集模式、触发原因；正文搜索命中时包含 `searchHit.messageOrdinal` 和 `searchHit.excerpt`。

### 5.2 平台会话数量

```http
GET /api/v1/conversations/provider-counts
```

认证：Web 登录。

用途：返回未删除会话按 AI 平台汇总的 Session 数，供会话页和日志页的平台筛选下拉使用。

响应：

```json
[
  {
    "provider": "chatgpt",
    "count": 40
  },
  {
    "provider": "codex",
    "count": 128
  }
]
```

### 5.3 会话详情

```http
GET /api/v1/conversations/:id?revisionId=<revision-id>
```

认证：Web 登录。

响应字段：

```json
{
  "conversation": {},
  "projectAssignment": {},
  "revisions": [],
  "selectedRevision": {
    "captureMode": "append",
    "triggerReason": "stream_finished",
    "sourceDevice": {
      "id": "uuid",
      "name": "Windows Chrome",
      "kind": "chrome_extension"
    }
  },
  "messages": []
}
```

### 5.4 删除会话

```http
DELETE /api/v1/conversations/:id
```

认证：Web 登录。

说明：当前实现会硬删除该会话相关归档数据。

## 6. 仪表盘、任务状态与日志

### 6.1 仪表盘

```http
GET /api/v1/dashboard
```

响应：

```json
{
  "counts": {
    "conversations": 100,
    "projects": 8,
    "knowledge": 256,
    "devices": 3
  },
  "textStats": {
    "textUnits": 1680000,
    "estimatedTokens": 988236,
    "latestRevisionCount": 100,
    "latestMessageCount": 2048,
    "tokenEstimateRule": "按 1 token≈1.7 个字符粗估"
  },
  "categoryTotals": {
    "activeCategoryCount": 6,
    "emptyCategoryCount": 2,
    "categorizedConversationCount": 82,
    "unclassifiedConversationCount": 18,
    "growth7d": 12
  },
  "categoryStats": [
    {
      "projectId": "uuid",
      "projectName": "网络运维",
      "description": "网络、VPN、SSH、NAS 访问等问题",
      "conversationCount": 24,
      "growth7d": 5,
      "knowledgeCount": 9,
      "latestActivityAt": "2026-07-26T12:00:00.000Z"
    }
  ],
  "captureStatus24h": {
    "complete": 10,
    "partial": 2,
    "failed": 1
  },
  "captureProviders24h": [],
  "recentReports": []
}
```

### 6.2 任务状态聚合

```http
GET /api/v1/activity?limit=20
```

用途：聚合分类、分析、导入和采集异常状态。

响应：

```json
{
  "generatedAt": "2026-07-25T04:00:00.000Z",
  "summary": {
    "active": 1,
    "failed": 0,
    "warnings": 1
  },
  "items": [
    {
      "id": "uuid",
      "type": "classification",
      "title": "智能归类",
      "status": "running",
      "progress": 42,
      "message": "已处理 42/100",
      "stats": {}
    }
  ]
}
```

### 6.3 操作日志

```http
GET /api/v1/logs?limit=80&scope=&level=&provider=&status=&q=
```

参数：

| 参数 | 说明 |
| --- | --- |
| `limit` | 1 到 200，默认 80。 |
| `scope` | `analysis`、`capture`、`classification`、`device`、`import`、`system`。 |
| `level` | `info`、`warning`、`error`。 |
| `provider` | AI 平台过滤，匹配日志元数据中的 `provider`、`sourceProvider` 或 `conversationProvider`。 |
| `status` | 任意状态字符串。 |
| `q` | 按日志消息模糊搜索。 |

响应：

```json
{
  "items": []
}
```

## 7. 项目、知识与分类

### 7.1 项目列表

```http
GET /api/v1/projects
```

响应：项目数组，含会话数量和知识数量。

### 7.2 项目归类总览

```http
GET /api/v1/projects/overview
```

用途：项目知识页面使用，返回分类统计、项目分组和每个项目下的会话清单。

响应：

```json
{
  "totals": {
    "projectCount": 12,
    "activeProjectCount": 9,
    "categorizedConversationCount": 238,
    "unclassifiedConversationCount": 31,
    "knowledgeCount": 84
  },
  "projects": [
    {
      "id": "uuid",
      "name": "项目名",
      "description": "描述",
      "conversationCount": 18,
      "knowledgeCount": 6,
      "conversations": [
        {
          "id": "uuid",
          "provider": "codex",
          "title": "会话标题",
          "updatedAt": "2026-07-26T08:00:00.000Z",
          "confidence": 0.92,
          "lockedByUser": false,
          "suggestedName": null
        }
      ]
    }
  ],
  "unclassified": []
}
```

### 7.3 创建项目

```http
POST /api/v1/projects
Content-Type: application/json
```

请求：

```json
{
  "name": "项目名",
  "description": "描述"
}
```

### 7.4 编辑项目

```http
PATCH /api/v1/projects/:id
Content-Type: application/json
```

请求：

```json
{
  "name": "新项目名",
  "description": "新描述",
  "archived": false
}
```

### 7.5 设置会话项目

```http
PUT /api/v1/conversations/:id/project
Content-Type: application/json
```

请求：

```json
{
  "projectId": "uuid-or-null",
  "mode": "lock"
}
```

`mode`：

| 值 | 说明 |
| --- | --- |
| `lock` | 用户手动锁定，智能归类不得覆盖。 |
| `auto` | 解除锁定并可入队重新评估。 |

### 7.6 运行智能归类

```http
POST /api/v1/classification/run
Content-Type: application/json
```

请求：

```json
{
  "mode": "economy",
  "scope": "incremental"
}
```

`mode` 可选 `economy` 或 `full`。不传时使用设置中的 `classification.runMode`。

`scope` 可选：

| 值 | 行为 |
| --- | --- |
| `incremental` | 默认日常模式。只处理新会话、未归类、低置信度或最新修订晚于上次归类的候选会话。 |
| `all` | 完整重评所有未人工锁定会话。 |

如果不传 `scope`，`mode=full` 时默认为 `all`，其他情况默认为 `incremental`。

响应：

```json
{
  "jobId": "pg-boss-job-id",
  "task": {
    "id": "uuid",
    "status": "queued",
    "totalCount": 0,
    "processedCount": 0,
    "stats": {
      "scope": "incremental",
      "candidateReasons": {
        "unassigned": 12,
        "changed": 3,
        "low_confidence": 1
      }
    }
  }
}
```

如果已有排队或运行中的批量归类任务，接口返回 202，并带 `reused: true`。

### 7.7 最新分类任务

```http
GET /api/v1/classification/tasks/latest
```

响应：

```json
{
  "task": {}
}
```

### 7.8 指定分类任务

```http
GET /api/v1/classification/tasks/:id
```

### 7.9 知识列表

```http
GET /api/v1/knowledge?projectId=&status=
```

### 7.10 未归类会话

```http
GET /api/v1/unclassified
```

用途：返回当前未绑定项目的会话及 AI 建议。

## 8. 报告与分析

### 8.1 报告列表

```http
GET /api/v1/reports
```

返回最近 100 份报告。

### 8.2 分析运行列表

```http
GET /api/v1/analysis/runs?kind=weekly&limit=20
```

参数：

| 参数 | 说明 |
| --- | --- |
| `kind` | 可选 `weekly` 或 `monthly`。 |
| `limit` | 1 到 100，默认 20。 |

### 8.3 报告详情

```http
GET /api/v1/reports/:id
```

### 8.4 立即生成报告

```http
POST /api/v1/analysis/run
Content-Type: application/json
```

请求：

```json
{
  "kind": "weekly"
}
```

`kind` 可选 `weekly` 或 `monthly`。

响应：

```json
{
  "jobId": "pg-boss-job-id",
  "run": {
    "id": "uuid",
    "kind": "weekly",
    "status": "queued",
    "windowStart": "2026-07-13T16:00:00.000Z",
    "windowEnd": "2026-07-20T16:00:00.000Z"
  }
}
```

## 9. 历史导入

### 9.1 导入任务列表

```http
GET /api/v1/imports
```

返回最近 100 条导入任务。

### 9.2 上传 ZIP 导入

```http
POST /api/v1/imports
Content-Type: multipart/form-data
```

表单字段：上传一个 `.zip` 文件。

限制：

1. 只接受 `.zip`。
2. 单文件最大 2GB。
3. 使用文件 SHA-256 去重。

响应：

```json
{
  "duplicate": false,
  "job": {
    "id": "uuid",
    "status": "queued"
  }
}
```

## 10. 备份与恢复

### 10.1 导出系统备份

```http
GET /api/v1/backups/export
```

认证：Web 登录。

响应：`application/gzip` 附件，文件名形如：

```text
ai-conversation-archive-backup-2026-07-26T08-00-00-000Z.json.gz
```

备份内容：

1. 会话、修订、消息、消息分段和采集记录。
2. 设备、项目、会话项目归属、知识、分析运行、后台任务、报告。
3. 设置、脱敏规则、历史导入记录和操作日志。

不包含：

1. 管理员账号和密码。
2. Web 登录会话。
3. 一次性配对码。

### 10.2 导入系统备份

```http
POST /api/v1/backups/import
Content-Type: multipart/form-data
```

认证：Web 登录。

表单字段：上传一个 `.json`、`.json.gz` 或 `.gz` 备份文件。

行为：

1. 导入会替换当前业务数据。
2. 当前站点的管理员账号和登录能力会保留。
3. 如果备份文件的 `APP_MASTER_KEY` 指纹与当前环境不同，加密设置会被跳过，并在 `warnings` 中提示重新填写 API Key/SMTP 密码。

响应：

```json
{
  "ok": true,
  "importedAt": "2026-07-26T08:00:00.000Z",
  "counts": {
    "conversations": 100,
    "messages": 1200
  },
  "warnings": []
}
```

## 11. 设置与脱敏

### 11.1 获取设置

```http
GET /api/v1/settings
```

响应：

```json
{
  "settings": {},
  "redactionRules": []
}
```

敏感字段会以掩码返回。

### 11.2 更新设置

```http
PUT /api/v1/settings
Content-Type: application/json
```

请求：

```json
{
  "llm.baseUrl": "https://api.example.com/v1",
  "llm.apiKey": "sk-...",
  "llm.model": "model-name",
  "ai.pacingEnabled": "true",
  "ai.requestIntervalSeconds": "82",
  "ai.nightlyMaintenanceEnabled": "true",
  "classification.runMode": "economy",
  "classification.maxConversationChars": "8000"
}
```

支持的键：

```text
llm.baseUrl
llm.apiKey
llm.model
ai.pacingEnabled
ai.requestIntervalSeconds
ai.nightlyMaintenanceEnabled
smtp.host
smtp.port
smtp.secure
smtp.username
smtp.password
smtp.from
smtp.to
reports.weeklyEnabled
reports.monthlyEnabled
classification.autoOnCapture
classification.autoReclassify
classification.runMode
classification.reuseStable
classification.maxConversationChars
```

### 11.3 测试模型配置

```http
POST /api/v1/settings/llm/test
Content-Type: application/json
```

请求：

```json
{
  "baseURL": "https://api.example.com/v1",
  "apiKey": "sk-...",
  "model": "model-name"
}
```

响应成功：

```json
{
  "ok": true,
  "baseURL": "https://api.example.com/v1",
  "model": "model-name",
  "response": "OK"
}
```

响应失败：

```json
{
  "ok": false,
  "error": "失败原因"
}
```

### 11.4 新增脱敏规则

```http
POST /api/v1/redaction-rules
Content-Type: application/json
```

请求：

```json
{
  "pattern": "secret-[a-z0-9]+",
  "replacement": "[SECRET]"
}
```

### 11.5 启用或停用脱敏规则

```http
PATCH /api/v1/redaction-rules/:id
Content-Type: application/json
```

请求：

```json
{
  "enabled": false
}
```

### 11.6 删除脱敏规则

```http
DELETE /api/v1/redaction-rules/:id
```

## 12. 状态码约定

| 状态码 | 说明 |
| --- | --- |
| `200` | 请求成功，或采集内容未变化。 |
| `201` | 创建成功，例如新采集修订、新项目、配对码。 |
| `202` | 异步任务已入队或复用已有任务。 |
| `204` | 删除成功，无响应体。 |
| `400` | 请求体、参数或模型配置校验失败。 |
| `401` | 未登录或设备令牌无效。 |
| `404` | 资源不存在。 |
| `409` | 增量采集基线不一致，或异步任务入队冲突。 |
