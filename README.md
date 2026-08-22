# 知言归藏

知言归藏是个人自托管的 AI 会话归档、历史检索与项目演进系统。它把网页 AI 平台与 OpenClaw、Codex、Claude Code 的会话统一保存到 PostgreSQL，通过 Revision 保留历史，并提供项目、多标签、全文搜索、时间线、Project Context、周报/月报、导出和备份恢复。

当前源码版本：V2.1.0。

## 核心能力

- 跨平台采集：Chrome 插件支持 ChatGPT、Gemini、Grok、腾讯元宝、豆包、MiniMax、DeepSeek、千问和 Kimi；本地代理同步 OpenClaw、Codex、Claude Code。
- 版本化归档：完整/增量修订、内容哈希幂等、完整性标记和原始消息追溯。
- 项目与标签：一个主项目、多个标签，支持人工锁、自动整理、创建、编辑、归档、合并和筛选。
- 历史搜索：标题与正文命中、附近摘要，以及 Conversation、Revision、Message 精确定位。
- 项目演进：可靠时间线、原始会话导出和按需生成 PROJECT-CONTEXT.md。
- 报告：直接基于归档会话、项目与标签生成周报/月报。
- 自托管安全：TOTP、设备 Token 哈希、HTTPS 安全头、SSRF/DNS Rebinding 防护、入库与 LLM 前双重脱敏、非 root 只读容器。
- 备份兼容：V2.1 备份标签关系；V2.0.2 备份可恢复，旧派生数据忽略并 warning。

## 快速开始

要求 Node.js 22+、pnpm 11、PostgreSQL 16+。安装依赖后：

~~~powershell
pnpm install
pnpm db:migrate
pnpm dev:server
pnpm dev:web
~~~

生产环境使用 infra/docker-compose.yml。部署和升级请先阅读 docs/DEPLOYMENT.md 与 docs/OPERATIONS.md。

## 工作区

| 路径 | 说明 |
| --- | --- |
| apps/server | API、Worker、迁移与运行监控 |
| apps/web | React 管理后台 |
| apps/extension | Chrome 采集插件 |
| apps/openclaw-sync | Windows/macOS 本地同步代理 |
| packages/contracts | 共享 Zod 协议 |
| infra | Docker Compose、镜像与反向代理配置 |
| docs | 当前设计、使用、部署和历史变更 |

## 验证

~~~powershell
pnpm typecheck
pnpm test
pnpm build
docker compose -f deploy/docker-compose.yml config
~~~

详细文档索引见 docs/README-DOCS.md，历史版本事实见 docs/CHANGELOG.md。
