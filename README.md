# 知言归藏

知言归藏是个人自托管的 AI 会话归档、历史检索与项目演进系统。它把网页 AI 平台与 OpenClaw、Codex、Claude Code 的会话统一保存到 PostgreSQL，通过 Revision 保留历史，并提供项目、多标签、全文搜索、时间线、Project Context、周报/月报、导出和备份恢复。

当前源码版本：V2.3.0。

## 核心能力

- 跨平台采集：Chrome 插件支持 ChatGPT、Gemini、Grok、腾讯元宝、MiniMax、DeepSeek、千问和 Kimi；本地代理同步 OpenClaw、Codex、Claude Code。协议可表示豆包，但当前 Chrome 没有豆包适配器。
- 版本化归档：完整/增量修订、内容哈希幂等、完整性标记、历史标题/URL和原始消息追溯。
- 项目与标签：一个主项目、多个标签，支持人工锁、自动整理、创建、编辑、归档、合并和筛选。
- 历史搜索：标题与正文命中、附近摘要，以及 Conversation、Revision、Message 精确定位。
- 项目演进：可靠时间线、原始会话导出和按需生成 PROJECT-CONTEXT.md。
- 报告：按实例时区直接基于归档会话、项目与标签生成周报/月报，支持 Markdown 下载和邮件投递状态/重试。
- 可靠性：Adapter Health、Chrome Outbox管理、本地代理心跳、归档完整性检查、搜索重建和发布资格报告。
- 自托管安全：两阶段TOTP与管理员恢复CLI、设备Token哈希、HTTPS安全头、SSRF/DNS Rebinding防护、入库与LLM前双重脱敏、非root只读容器。
- 备份恢复：REPEATABLE READ一致性快照、只验证、异步Restore Job、提交边界持久化、post-commit恢复必需模式、staging保留治理、恢复后搜索重建与完整性检查。

## 快速开始

要求 Node.js 22 或 24 LTS、pnpm 11、PostgreSQL 16+；不使用奇数 Current 版本作为发布环境。安装依赖后：

~~~powershell
pnpm install
pnpm db:migrate
pnpm dev:server
pnpm dev:web
~~~

生产环境使用 `deploy/docker-compose.yml`。部署和升级请先阅读 [08-部署与发布](docs/08-部署与发布.md) 与 [09-运行维护](docs/09-运行维护.md)。

## 工作区

| 路径 | 说明 |
| --- | --- |
| apps/server | API、Worker、迁移与运行监控 |
| apps/web | React 管理后台 |
| apps/extension | Chrome 采集插件 |
| apps/openclaw-sync | Windows/macOS 本地同步代理 |
| packages/contracts | 共享 Zod 协议 |
| deploy | Docker Compose、镜像与群晖环境样例 |
| docs | 当前设计、使用、部署和历史变更 |

## 验证

~~~powershell
pnpm typecheck
pnpm test
pnpm build
docker compose -f deploy/docker-compose.yml config
pnpm release:qualify
~~~

详细文档索引见 [00-文档索引](docs/00-文档索引.md)，历史版本事实见 [13-版本变更记录](docs/13-版本变更记录.md)。
