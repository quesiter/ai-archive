# 运维手册

## 1. 运行环境

推荐环境：

| 组件 | 要求 |
| --- | --- |
| Node.js | 22 或更高 |
| 包管理器 | pnpm 11 |
| 数据库 | PostgreSQL |
| 队列 | pg-boss，使用同一个 PostgreSQL |
| 浏览器 | Chrome 或 Chromium 系浏览器 |
| NAS | 群晖 DSM 7.2.2，Container Manager |

## 2. 环境变量

服务端读取 `.env`。主要变量如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时启用生产约束。 |
| `PORT` | `8080` | 应用容器内部监听端口。 |
| `DATABASE_URL` | `postgres://archive:archive@localhost:5432/archive` | PostgreSQL 连接串。 |
| `APP_ORIGIN` | `http://localhost:5173` | Web 外部访问地址，生产远程访问应使用 HTTPS。 |
| `APP_MASTER_KEY` | 开发环境内置派生值 | 32 字节 Base64，生产必须生成真实随机值。 |
| `COOKIE_SECURE` | 跟随生产环境 | Cookie 是否只允许 HTTPS。 |
| `IMPORT_INBOX` | `./data/imports/inbox` | 待处理导入目录。 |
| `IMPORT_PROCESSED` | `./data/imports/processed` | 导入成功归档目录。 |
| `IMPORT_FAILED` | `./data/imports/failed` | 导入失败归档目录。 |
| `TZ` | `Asia/Shanghai` | Worker 定时任务时区。 |
| `LOG_LEVEL` | `info` | 服务日志级别。 |
| `WEB_DIST` | `../web/dist` | Web 静态文件目录。 |

生成生产主密钥：

```sh
openssl rand -base64 32
```

## 3. 本地开发

```powershell
Copy-Item .env.example .env
pnpm install
docker compose -f deploy/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm dev:server
pnpm dev:web
```

常用命令：

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e-api
pnpm db:migrate
```

## 4. NAS 部署

推荐目录：

```text
/volume1/docker/ai-conversation-archive/source
/volume1/docker/ai-conversation-archive/data
/volume1/backup/ai-conversation-archive
```

全新安装详见 [部署与使用](DEPLOYMENT.md)。启动后用以下命令检查：

```sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env ps
curl -fsS http://127.0.0.1:18080/healthz
```

## 5. 升级流程

常规升级：

```sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-0.2.20-clean-install.tar.gz
```

测试环境可跳过升级前数据库备份：

```sh
SKIP_BACKUP=1 sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-0.2.20-clean-install.tar.gz
```

升级后检查：

```sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=120 app worker
curl -fsS http://127.0.0.1:18080/healthz
```

`/healthz` 应返回当前版本，例如 `0.2.20`。如果健康检查版本仍是旧号，通常是 Docker 镜像缓存、反向代理指向旧容器，或没有强制重建 app/worker。

## 6. Chrome 插件运维

最新插件包：

```text
release/ai-archiveextension-0.4.0-chrome.zip
```

升级插件：

1. 解压新版 zip。
2. 打开 `chrome://extensions`。
3. 开启开发者模式。
4. 加载新版解压目录，或点击旧扩展的刷新按钮。
5. 如果服务器地址或设备令牌变化，重新配对。

Chrome 的无痕模式和工具栏固定不能由普通插件自动打开。插件已声明 `incognito` 支持；需要用户在扩展详情页启用，或由企业策略统一配置。

## 7. 本地同步代理运维

Windows 便携包：

```text
release/ai-conversation-archive-windows-sync-0.2.18.zip
```

macOS 同步包：

```text
release/ai-conversation-archive-macos-sync-0.2.20.tar.gz
```

默认配置文件：

```text
~/.config/ai-archive/openclaw-sync.json
```

Windows 可用 `AI_ARCHIVE_SYNC_CONFIG` 指定配置路径。服务地址或设备被撤销后需要重新配对；只是升级同步器代码通常不需要重新配对。

常用命令：

```sh
node openclaw-sync.cjs pair --server https://ai-archive.gyee.tech:18443 --code ABCD1234
node openclaw-sync.cjs run
node openclaw-sync.cjs rebuild
node openclaw-sync.cjs full-rebuild
```

## 8. 数据库迁移

迁移文件位于：

```text
apps/server/migrations
```

本地执行：

```powershell
pnpm db:migrate
```

容器部署会在启动流程中执行迁移。升级后应查看 app/worker 日志，确认没有迁移失败。

## 9. 备份与恢复

Web 业务备份适合“清空生产环境、重新部署网站、再导入原业务数据”。路径为“设置 > 备份与恢复”。

业务备份包含会话、修订、消息、设备、项目、知识、报告、设置、导入记录和操作日志；不包含管理员账号、登录会话和一次性配对码。

数据库脚本备份适合 NAS 灾备：

```sh
POSTGRES_USER=archive POSTGRES_DB=archive \
BACKUP_ROOT=/volume1/backup/ai-conversation-archive \
sh /volume1/docker/ai-conversation-archive/source/scripts/backup.sh
```

恢复前先停止服务，并优先在测试环境演练：

```sh
sh /volume1/docker/ai-conversation-archive/source/scripts/restore.sh
```

## 10. Worker 与队列

Worker 负责：

| 队列 | 说明 |
| --- | --- |
| `analysis-weekly` | 周报生成。 |
| `analysis-monthly` | 月报生成。 |
| `classify-conversation` | 单会话归类。 |
| `reclassify-unlocked` | 批量智能归类。 |
| `import-archive` | 历史 ZIP 导入。 |
| `email-report` | 报告邮件发送。 |

定时任务：

| 任务 | 时间 |
| --- | --- |
| 周报 | 每周一 07:30，使用 `TZ` 时区。 |
| 月报 | 每月 1 日 08:00，使用 `TZ` 时区。 |
| 自动重归类 | 每周日 06:15，需要开启 `classification.autoReclassify`。 |
| 导入目录扫描 | 每 5 分钟。 |

分类、导入或报告一直不动时，优先检查 Worker 容器是否运行。批量智能归类会分片续跑；如果某个 `background_tasks` 记录长时间没有进度更新，Worker 启动和任务状态接口会自动把它标记为失败，用户可在升级或修复模型配置后重新点击“智能归类”。历史导入会额外检查 PgBoss 中是否仍有对应的活跃 `import-archive` job：没有活跃 job 且源 ZIP 仍在 inbox 时自动重新入队，源文件缺失时标记失败。

## 11. 模型与邮件配置

OpenAI 兼容模型配置项：

1. `llm.baseUrl`
2. `llm.apiKey`
3. `llm.model`

设置页提供“测试”按钮。测试成功后再运行分类、周报或月报。

常见失败：

| 失败 | 可能原因 |
| --- | --- |
| Base URL 无法访问 | NAS 网络、代理、防火墙或 URL 错误。 |
| 401/403 | API Key 错误或无权限。 |
| 模型不存在 | 模型名不匹配。 |
| 空响应 | 上游模型异常或接口不兼容。 |
| JSON 校验失败 | 模型未遵循结构化输出，查看分析日志。 |

SMTP 未配置时，报告仍保存到后台，只是不发送邮件。

## 12. 日志与排错

后台“日志”页支持按范围、级别、AI 平台、状态和关键字筛选。平台筛选会显示 Session 数，例如 `ChatGPT（40）`。

容器日志：

```sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env logs --tail=200 app
docker compose --env-file .env logs --tail=200 worker
docker compose --env-file .env logs --tail=200 postgres
```

常见问题检查：

- 插件没有采集：检查当前域名、Session ID、配对状态、站点权限、悬浮窗状态和 `scope=capture` 日志。
- 插件重复采集：检查是否已升级轻量变化检测，服务端是否返回 `incremental_base_mismatch`。
- 元宝会话串号：确认 URL 为 `/chat/<app>/<conversation>`，后台 `externalSessionId` 应保存两段 ID。
- 千问无法采集：确认 URL 为 `https://www.qianwen.com/chat/<id>` 或 `https://qianwen.com/chat/<id>`，并检查扩展权限。
- 智能归类失败：先测试模型连接，再看 Worker、`classification.maxConversationChars` 和 `scope=classification` 错误日志。
- 周报/月报失败：检查模型测试、报告运行状态、项目知识数量和 `scope=analysis level=error` 日志。
- 导入任务不动：检查 Worker、ZIP 大小、重复导入、导入目录权限和 `scope=import` 日志。

## 13. 安全检查清单

生产部署前确认：

1. `APP_MASTER_KEY` 是真实随机值。
2. `APP_ORIGIN` 是 HTTPS 外部地址。
3. `COOKIE_SECURE=true` 或 `NODE_ENV=production`。
4. PostgreSQL 不暴露到公网。
5. DSM 管理端口不暴露到公网。
6. 只暴露一个 HTTPS 反向代理入口。
7. 管理员 TOTP 已绑定。
8. 不使用过期或测试设备令牌。
9. 定期备份数据库和 `.env`。
10. LLM API Key 使用最小权限和可撤销密钥。

## 14. 发布包检查

每次交付至少包含：

1. NAS 源码包。
2. Chrome 插件包。
3. Windows/macOS 同步代理包。
4. 对应版本说明。
5. 如改动数据库，明确迁移文件编号。

打包时不要包含 `node_modules`、`.env`、数据库数据目录、临时导入文件、本地日志、浏览器本地状态和历史 release 目录。
