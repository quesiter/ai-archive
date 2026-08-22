# AI Conversation Archive

个人自托管的跨平台 AI 会话归档数据库。系统把网页 AI 平台和本地 AI 编程工具里的会话统一归档到自己的 PostgreSQL 中；智能归类、知识沉淀、周报、月报和个人分析是可选能力，不影响核心采集、搜索和备份恢复。

当前服务端源码版本：`V260822-3`（最新发布包仍为 `V260822-2`）。Chrome 插件版本：`V20260817`。

## 当前能力

- 网页自动采集：ChatGPT、Gemini、Grok、腾讯元宝、MiniMax Agent、DeepSeek、千问、Kimi。
- 本地同步：OpenClaw、Codex、Claude Code。
- 历史导入：ChatGPT 官方导出 ZIP、Gemini Takeout ZIP、Chat Memo 多平台导出 ZIP（含 ChatGPT、Gemini、元宝、DeepSeek、千问和豆包）。
- 管理后台：总览、会话、项目知识、报告、导入、设备、日志、设置、备份恢复。
- 总览页展示归档规模、分类分布、近 7 日分类增长、总文本量、估算 token、知识数量、近 24 小时采集健康和最近报告。
- 智能归类默认只处理增量候选：新会话、未归类、低置信度和内容更新的会话；需要时可手动选择完整重评未锁定会话。
- 日志页使用紧凑表格，并支持按范围、级别、AI 平台、状态和关键字筛选；平台下拉会显示 Session 数。

Chrome 插件先做轻量变化检测；未变化时不会滚动页面、不会生成完整快照、不会写入 outbox、不会向服务端上传。首次会话、分支变化、适配器升级和手动重试使用完整采集；已有完整基线后的新增回答优先使用增量采集。

没有配置 OpenAI 兼容模型时，网页采集、本地同步、历史导入、会话搜索、修订查看和备份恢复仍可正常运行。模型只用于可选的智能归类、知识抽取和报告。

## 最新发布包

| 包 | 路径 |
| --- | --- |
| NAS 服务端源码包 | `release/ai-conversation-archive-nas-V260822-2-clean-install.tar.gz` |
| Chrome 插件 | `release/ai-archiveextension-V20260817-chrome.zip` |
| Windows 同步代理 | `release/ai-conversation-archive-windows-sync-V20260817.zip` |
| macOS 同步代理 | `release/ai-conversation-archive-macos-sync-V20260817.tar.gz` |

NAS 更新命令：

```sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V260822-2-clean-install.tar.gz
```

## 文档

| 文档 | 说明 |
| --- | --- |
| [中文文档总览](docs/README-DOCS.md) | 文档入口和阅读建议。 |
| [需求文档](docs/REQUIREMENTS.md) | 产品目标、功能需求、非功能需求、验收标准和边界。 |
| [系统设计文档](docs/SYSTEM-DESIGN.md) | 架构、采集链路、同步代理、AI 运行方式、队列、日志和安全设计。 |
| [数据模型文档](docs/DATA-MODEL.md) | PostgreSQL 表结构、关系、幂等键和数据生命周期。 |
| [API 文档](docs/API.md) | 后台、设备、采集、分类、报告、导入、日志和设置接口。 |
| [用户手册](docs/USER-GUIDE.md) | 日常使用、插件配对、自动采集、本地同步代理、分类和报告。 |
| [部署与使用](docs/DEPLOYMENT.md) | NAS 安装、插件、本地同步、备份恢复。 |
| [运维手册](docs/OPERATIONS.md) | 本地开发、NAS 升级、备份恢复、日志排错和安全检查。 |
| [变更历史](docs/CHANGELOG.md) | 合并后的版本更新记录。 |

旧的 `docs/UPDATE-*.md` 已合并到 [变更历史](docs/CHANGELOG.md)。

## 代码组成

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| 服务端 | `apps/server` | Fastify API、PostgreSQL/Drizzle、pg-boss Worker、导入、分析、邮件和日志。 |
| Web 后台 | `apps/web` | React 单用户管理后台。 |
| Chrome 插件 | `apps/extension` | Manifest V3 自动采集插件。 |
| 本地同步代理 | `apps/openclaw-sync` | 读取 OpenClaw、Codex、Claude Code 本地 JSONL 会话并上传归档。 |
| 共享协议 | `packages/contracts` | 采集快照、设备配对、知识抽取等共享 Schema。 |
| 部署脚本 | `deploy`、`scripts` | Docker Compose、备份、恢复、更新和 API 冒烟测试脚本。 |

## 本地启动

```powershell
Copy-Item .env.example .env
pnpm install
docker compose -f deploy/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm dev:server
pnpm dev:web
```

首次访问 Web 后台时创建管理员账号并绑定 TOTP。随后在“设备”页面生成配对码，在 Chrome 插件或本地同步代理中完成配对。

## 常用命令

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm db:migrate
pnpm dev:server
pnpm dev:web
```

Chrome 插件构建：

```powershell
pnpm --filter @ai-archive/contracts build
pnpm --filter @ai-archive/extension zip
```

本地同步代理构建：

```powershell
pnpm --filter @ai-archive/contracts build
pnpm --filter @ai-archive/openclaw-sync build
```
