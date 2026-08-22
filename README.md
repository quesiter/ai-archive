# 知言归藏

> 汇智能之言，成项目之知。

“知言归藏”是个人自托管的跨平台 AI 会话归档与项目知识系统。它把网页 AI 平台和本地 AI 编程工具中的会话统一保存到 PostgreSQL，并在不影响原始归档的前提下提供项目归类、中文知识沉淀、周报、月报、检索、导出和备份恢复。

当前发布版本：服务端与 Web `V260822-4`；Chrome 插件与本地同步代理 `V260822-4`。

## 已实现能力

- 网页采集：ChatGPT、Gemini、Grok、腾讯元宝、MiniMax Agent、DeepSeek、千问、Kimi。
- 本地同步：OpenClaw、Codex、Claude Code；支持近期安全扫描、文件监听、尾部增量、失败重试和全量重建。
- 历史导入：ChatGPT 官方导出 ZIP、Gemini Takeout ZIP、Chat Memo 多平台导出 ZIP。
- 会话归档：按平台与外部 Session 去重，保存完整/增量修订、消息角色、正文、代码、引用、推理和工具状态；支持正文搜索、筛选、修订切换、永久删除以及 CSV、Markdown、XLSX 导出。
- 项目归类：项目创建、编辑、归档、人工锁定、自动重评、项目合并、项目级会话导出；批量任务显示进度并支持断点续跑。
- 项目知识：从已归类会话提炼中文决策、需求、事实、想法、任务、风险、资源和待解问题，保留原始会话、修订及消息序号作为依据；支持项目级合并、去重和重建。
- 报告：生成上一完整周和上一自然月的报告，周报使用准确的起止日期；报告页分别只展示最新一次周报和月报生成状态。
- AI 额度治理：所有结构化 AI 调用共用可配置节流；识别 MiniMax Token Plan/速率限制，优先读取实际刷新时间，增加 10 分钟缓冲后自动续跑，无法读取时一小时后重试；每天 22:00 可自动串行执行增量归类和知识分析。
- 安全：单用户密码与 TOTP 登录、设备配对与撤销、HTTPS/同源检查、敏感设置加密、网络目标校验、上传限额和速率限制。
- 脱敏：密码、API Token、Authorization、私钥、数据库连接串、带认证 URL 和 SSH/SFTP 登录信息在消息入库前不可逆打码；支持自定义规则、一键安全规则包、规则预览和历史数据清理。
- 运维：Docker Compose 部署、自动迁移、健康检查、业务备份导入导出、PostgreSQL 脚本备份恢复、操作日志和 API 冒烟测试。

未配置 OpenAI 兼容模型时，网页采集、本地同步、历史导入、会话搜索、修订查看、导出和备份恢复仍可使用；模型只影响归类、知识和报告等可选能力。

## 发布包

| 包 | 路径 |
| --- | --- |
| NAS 服务端源码包 | `release/ai-conversation-archive-nas-V260822-4-clean-install.tar.gz` |
| Chrome 插件 | `release/ai-archiveextension-V260822-4-chrome.zip` |
| Windows 同步代理 | `release/ai-conversation-archive-windows-sync-V260822-4.zip` |
| macOS 同步代理 | `release/ai-conversation-archive-macos-sync-V260822-4.tar.gz` |

既有英文目录名、包名、环境变量和备份格式名属于兼容性标识，本次品牌更新不改变这些接口。

NAS 更新：

```sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V260822-4-clean-install.tar.gz
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档总览](docs/README-DOCS.md) | 文档范围、版本和阅读顺序。 |
| [项目需求文档](docs/REQUIREMENTS.md) | 已实现产品范围、功能需求、非功能需求、验收标准和明确边界。 |
| [系统设计文档](docs/SYSTEM-DESIGN.md) | 架构、数据流、队列、AI 调度、失败恢复和安全设计。 |
| [界面设计文档](docs/UI-DESIGN.md) | Web、Chrome 插件和本地同步客户端的信息架构、页面状态与交互。 |
| [数据库设计文档](docs/DATA-MODEL.md) | PostgreSQL 表、关系、约束、幂等和数据生命周期。 |
| [API 文档](docs/API.md) | 当前服务端已注册的 HTTP API。 |
| [用户手册](docs/USER-GUIDE.md) | Web、插件、同步代理、导入、归类、知识、报告与脱敏操作。 |
| [部署文档](docs/DEPLOYMENT.md) | 群晖 NAS、反向代理、服务端和客户端安装升级。 |
| [运维手册](docs/OPERATIONS.md) | 监控、备份、恢复、迁移、发布、排障和安全检查。 |
| [Windows 同步](docs/WINDOWS-SYNC.md) | Windows 便携包、后台任务和路径配置。 |
| [macOS 同步](docs/MACOS-SYNC.md) | macOS 便携包、LaunchAgent 和路径配置。 |
| [变更历史](docs/CHANGELOG.md) | 已发布版本的客观变更记录。 |

## 代码组成

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| 服务端 | `apps/server` | Fastify API、认证、采集入库、Drizzle/PostgreSQL、pg-boss Worker、分析、脱敏、备份、邮件和日志。 |
| Web | `apps/web` | React 单用户管理后台。 |
| Chrome 插件 | `apps/extension` | Manifest V3 网页适配、轻量变化检测、完整/增量采集、本地 outbox 和悬浮状态。 |
| 本地同步代理 | `apps/openclaw-sync` | OpenClaw、Codex、Claude Code JSONL 解析、增量读取、监听和上传。 |
| 共享协议 | `packages/contracts` | 采集、配对、知识等 Zod Schema 与 TypeScript 类型。 |
| 部署与脚本 | `deploy`、`scripts` | Compose、更新、备份、恢复、客户端安装和冒烟测试。 |

## 本地开发

要求 Node.js 22、pnpm 11、PostgreSQL 17 或 Docker。

```powershell
Copy-Item .env.example .env
pnpm install
docker compose -f deploy/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm dev:server
pnpm dev:web
```

首次访问 Web 时创建唯一管理员并绑定 TOTP；随后在“设备”页生成配对码，连接 Chrome 插件或本地同步代理。

常用校验：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

客户端构建：

```powershell
pnpm --filter @ai-archive/contracts build
pnpm --filter @ai-archive/extension zip
pnpm --filter @ai-archive/openclaw-sync build
```
