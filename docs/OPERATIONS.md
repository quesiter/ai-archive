# 知言归藏运维手册

## 1. 运行环境

推荐环境：

| 组件 | 要求 |
| --- | --- |
| Node.js | 22 或更高 |
| 包管理器 | pnpm 11 |
| 数据库 | PostgreSQL 17 |
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
| `TRUST_PROXY` | `false` | 是否信任代理转发头；推荐填写可信代理跳数，例如 `1`。 |
| `EXTENSION_ORIGINS` | 官方 Chrome 扩展来源 | 允许跨域调用 API 的固定 Chrome 扩展来源，多个值用逗号分隔。 |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `false` | 是否允许 LLM/SMTP 访问内网；默认启用 SSRF 和 DNS 重绑定防护。 |
| `IMPORT_INBOX` | `./data/imports/inbox` | 待处理导入目录。 |
| `IMPORT_PROCESSED` | `./data/imports/processed` | 导入成功归档目录。 |
| `IMPORT_FAILED` | `./data/imports/failed` | 导入失败归档目录。 |
| `COMPONENT_RELEASE_DIR` | 自动发现 `release` | 设备页可下载客户端组件的发布目录。 |
| `HOST_MONITOR_URL` | 空 | app 读取项目容器监测指标的内部地址；Compose 固定为 `http://host-monitor:9091`。 |
| `ARCHIVE_CGROUP_PARENT` | `ai-conversation-archive` | 项目各容器共享的父 cgroup；所有服务必须保持一致。 |
| `ARCHIVE_STORAGE_BUDGET_GB` | 空 | 可选项目数据软预算；留空时不计算存储百分比和容量告警。 |
| `HOST_SAMPLE_INTERVAL_MS` | `10000` | Compose 项目容器监测采样间隔，最低有效值 5000 毫秒。 |
| `HOST_HISTORY_LIMIT` | `27` | 内存趋势采样点数量，服务端限制为 10–120。 |
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

正常状态为 app、postgres、host-monitor 均为 healthy，worker 为 Up。`host-monitor` 不应显示宿主端口；它只在 Compose 内部网络监听 9091。Web 登录后可在“设置 → 系统状态”核对项目容器、项目存储和数据库指标。

## 5. 升级流程

常规升级：

```sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.0.2-clean-install.tar.gz
```

测试环境可跳过升级前数据库备份：

```sh
SKIP_BACKUP=1 sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.0.2-clean-install.tar.gz
```

升级后检查：

```sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=120 host-monitor app worker
curl -fsS http://127.0.0.1:18080/healthz
```

`/healthz` 应返回当前版本 `V2.0.2`。如果健康检查版本仍是旧号，通常是 Docker 镜像缓存、反向代理指向旧容器，或没有强制重建 host-monitor/app/worker。升级脚本兼容直接 Docker 权限和免交互 `sudo docker`；当宿主账户不能进入 UID 1000 的导入目录时，会通过本机应用镜像维护目录权限。

## 6. Chrome 插件运维

最新插件包：

```text
release/ai-archiveextension-V2.0.2-chrome.zip
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
release/ai-conversation-archive-windows-sync-V2.0.2.zip
```

Windows 后台运行：

```bat
sync-local-windows.bat install
sync-local-windows.bat uninstall
```

后台任务复用 `%USERPROFILE%\.config\ai-archive\openclaw-sync.json`，升级同步器代码通常不需要重新配对。后台日志位于 `%LOCALAPPDATA%\AIArchive\Sync\Logs`。

macOS 同步包：

```text
release/ai-conversation-archive-macos-sync-V2.0.2.tar.gz
```

默认配置文件：

```text
~/.config/ai-archive/openclaw-sync.json
```

macOS 后台运行：双击 `AI-Archive-Sync.command`，按菜单安装或卸载 LaunchAgent。后台日志位于 `~/Library/Logs/AIArchive`。

Windows 和 macOS 都可用 `AI_ARCHIVE_SYNC_CONFIG` 指定配置路径。服务地址或设备被撤销后需要重新配对；只是升级同步器代码通常不需要重新配对。

常用命令：

```sh
./AI-Archive-Sync.command
./AI-Archive-Sync.command install
./AI-Archive-Sync.command uninstall
./AI-Archive-Sync.command rebuild
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
| `rebuild-knowledge` | 项目知识重建。 |
| `nightly-ai-maintenance` | 夜间增量归类与知识分析编排。 |
| `import-archive` | 历史 ZIP 导入。 |
| `email-report` | 报告邮件发送。 |
| `redact-storage` | 历史敏感信息不可逆清理。 |

定时任务：

| 任务 | 时间 |
| --- | --- |
| 周报 | 每周一 07:30，使用 `TZ` 时区。 |
| 月报 | 每月 1 日 08:00，使用 `TZ` 时区。 |
| 自动重归类 | 每周日 06:15，需要开启 `classification.autoReclassify`。 |
| 夜间智能维护 | 每天 22:00，需要开启 `ai.nightlyMaintenanceEnabled`；先增量归类，再知识分析。 |
| 延迟报告恢复检查 | 每 5 分钟。 |
| 导入目录扫描 | 每 5 分钟。 |

分类、导入或报告一直不动时，优先检查 Worker 容器是否运行。批量智能归类默认先在数据库里筛增量候选，只处理新会话、未归类、低置信度和内容更新的会话；完整重评是显式操作。归类会分片续跑，续跑时使用首次筛出的固定候选列表，避免 offset 因已处理记录更新而跳过后续会话。如果某个 `background_tasks` 记录长时间没有进度更新，Worker 启动和任务状态接口会自动把它标记为失败，用户可在升级或修复模型配置后重新点击“智能归类”。历史导入会额外检查 PgBoss 中是否仍有对应的活跃 `import-archive` job：没有活跃 job 且源 ZIP 仍在 inbox 时自动重新入队，源文件缺失时标记失败。

## 11. 模型与邮件配置

OpenAI 兼容模型配置项：

1. `llm.baseUrl`
2. `llm.apiKey`
3. `llm.model`

设置页提供“测试”按钮。测试成功后再运行分类、周报或月报。

所有结构化 AI 请求共用进程级节流，默认起始间隔 82 秒。MiniMax Token Plan/速率限制会优先从错误或 `/v1/token_plan/remains` 获取五小时/周额度刷新时间，在刷新后增加 10 分钟缓冲并创建延迟续跑；无法查询刷新时间时一小时后重试。任务的 `stats` 中记录 `retryAt`、`quotaResetAt`、窗口和来源，Web 显示倒计时。不要把额度等待误判为 Worker 停止。

常见失败：

| 失败 | 可能原因 |
| --- | --- |
| Base URL 无法访问 | NAS 网络、代理、防火墙或 URL 错误。 |
| 401/403 | API Key 错误或无权限。 |
| 模型不存在 | 模型名不匹配。 |
| 空响应 | 上游模型异常或接口不兼容。 |
| JSON 校验失败 | 模型未遵循结构化输出，查看分析日志。 |

SMTP 未配置时，报告仍保存到后台，只是不发送邮件。

LLM Base URL 和 SMTP Host 默认禁止回环、RFC1918 内网、链路本地、云元数据与保留地址，并把实际连接固定到验证过的 IP，避免 DNS 重绑定。需要访问可信的局域网模型或邮件服务器时，可显式设置 `ALLOW_PRIVATE_NETWORK_TARGETS=true`；启用后应同时依靠网络 ACL、防火墙和独立服务账号限制访问范围。

## 12. 日志与排错

后台“日志”页支持按范围、级别、AI 平台、状态和关键字筛选。平台筛选会显示 Session 数，例如 `ChatGPT（40）`。

容器日志：

```sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env logs --tail=200 app
docker compose --env-file .env logs --tail=200 worker
docker compose --env-file .env logs --tail=200 host-monitor
docker compose --env-file .env logs --tail=200 postgres
```

常见问题检查：

- 插件没有采集：检查当前域名、Session ID、配对状态、站点权限、悬浮窗状态和 `scope=capture` 日志。
- 插件重复采集：检查是否已升级轻量变化检测，服务端是否返回 `incremental_base_mismatch`。
- 元宝会话串号：确认 URL 为 `/chat/<app>/<conversation>`，后台 `externalSessionId` 应保存两段 ID。
- 千问无法采集：确认 URL 为 `https://www.qianwen.com/chat/<id>` 或 `https://qianwen.com/chat/<id>`，并检查扩展权限。
- Codex 只有问题没有答案：先在会话详情切换最新修订。`V2.0.1` 会以修订创建时间解决同采集时间排序，合并扫描期间收到的文件变化，并按 LF 读取含独立 CR 空白的 JSONL；升级服务端和本地同步代理后，运行一次近期 `rebuild` 可补齐受影响会话。
- 智能归类失败：先测试模型连接，再看 Worker、`classification.maxConversationChars` 和 `scope=classification` 错误日志。
- 周报/月报失败：检查模型测试、报告运行状态、项目知识数量和 `scope=analysis level=error` 日志。
- 导入任务不动：检查 Worker、ZIP 大小、重复导入、导入目录权限和 `scope=import` 日志。
- Token Plan 等待过久：查看任务统计中的 `source`、`quotaResetAt` 和 `retryAt`；`source=fallback` 表示额度接口不可用，按一小时兜底。
- 系统状态无项目容器指标：检查 `host-monitor` 是否 healthy，`/proc` 与 `/sys/fs/cgroup` 只读挂载是否存在，并确认所有服务使用相同的 `ARCHIVE_CGROUP_PARENT`；不要通过暴露 9091 或挂载 Docker Socket 绕过问题。

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
11. `TRUST_PROXY` 只填写实际可信的代理跳数，不使用无边界的 `true`。
12. `EXTENSION_ORIGINS` 只包含当前发布扩展的固定 ID。
13. 除可信内网模型/SMTP 外，保持 `ALLOW_PRIVATE_NETWORK_TARGETS=false`。
14. app/worker 使用非 root 和只读根文件系统运行，只有导入卷与受限 `/tmp` 可写；导入数据目录只授予 UID 1000 所需读写权限。生产镜像不包含 npm/corepack、esbuild、Vite、TypeScript 和测试工具。PostgreSQL 仅恢复官方入口脚本启动所需的 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`SETGID`、`SETUID` 能力。
15. 在设置页启用安全规则包，并在首次启用前完成数据库备份；历史清理完成后检查任务失败数为 0。
16. host-monitor 不映射宿主端口、不挂载 Docker Socket，保持只读根文件系统、只读指标挂载和全部 capabilities 移除。
17. 发布镜像执行依赖与镜像 CVE 扫描；High/Critical 可修复漏洞不为 0 时不得部署。

## 14. 发布包检查

当前产品版本基线为 `V2.0.2`。后续每次发布只增加补丁号，即 `V2.0.3`、`V2.0.4`……；根包、服务端、Web、共享协议、Chrome Manifest 和同步代理版本必须在同一次发布中保持一致。每次发布都应在 `docs/CHANGELOG.md` 顶部新增日期、版本、主题和客观变更，该文件会直接构建到 Web 的独立更新记录页。

每次交付至少包含：

1. NAS 源码包。
2. Chrome 插件包。
3. Windows/macOS 同步代理包。
4. 对应版本说明。
5. 如改动数据库，明确迁移文件编号。

打包时不要包含 `node_modules`、`.env`、数据库数据目录、临时导入文件、本地日志、浏览器本地状态和历史 release 目录。
