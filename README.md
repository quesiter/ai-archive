# 知言归藏

知言归藏是个人自托管的 AI 会话归档、历史检索与项目演进系统。它把网页 AI 平台与 OpenClaw、Codex、Claude Code 的会话统一保存到 PostgreSQL，每个会话持续积累一份正文，并提供项目、多标签、全文搜索、时间线、Project Context、周报/月报、导出和备份恢复。

当前源码版本：V2.5.2。

## 核心能力

- 跨平台采集：Chrome 插件支持 ChatGPT、Gemini、Grok、腾讯元宝、豆包、MiniMax、DeepSeek、千问和 Kimi；本地代理同步 OpenClaw、Codex、Claude Code、Grok Build CLI/Desktop。Chrome 已补充豆包适配、站点权限与新旧 DOM 提取。
- 持续积累归档：完整与增量采集合并到同一份正文，保留已有消息、差异内容和顺序待核对证据，支持内容哈希幂等、完整性标记和原始消息追溯。
- 长会话补采：手动完整采集等待正文挂载稳定并校验视窗重叠，无法确认连续性时标记部分归档；服务端识别相同首尾、正文匹配却缺少中间消息的快照，扩展按服务端回执显示完整性。批量补采页分别显示任务操作与进度刷新错误，短暂失败恢复后清除对应提示，设备版本以实际心跳上报为准。
- Codex 父子会话：根据原始子代理父 ID 归组，主列表、项目时间线和会话数量统一按主入口展示；子代理各自保留独立正文和身份。升级同步代理后自动读取全部历史 session_meta 头部补齐关系，无需删除状态或扩大正文同步窗口。
- 项目与标签：一个主项目、多个标签，支持人工锁、自动整理、创建、编辑、归档和筛选；主动发现可能属于同一项目的多项目候选组，支持逐项勾选、AI 补充分析、人工审阅和保持独立的判断，空项目不参与推荐；项目可按名称跨页搜索，并将多个源项目一次合并到一个目标项目。
- 历史搜索：标题与正文命中、附近摘要，以及当前累计正文中的消息定位。
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
pnpm release:check
docker compose -f deploy/docker-compose.yml config
pnpm release:qualify
~~~

详细文档索引见 [00-文档索引](docs/00-文档索引.md)，历史版本事实见 [13-版本变更记录](docs/13-版本变更记录.md)。

### 豆包与 Grok Build 采集

Chrome 扩展现支持 `https://www.doubao.com/chat/<会话ID>`（以及 `doubao.com`），按页面消息ID采集可见正文、思考和代码，并沿用现有长会话扫描与完整性标记。安装或升级后须授予豆包站点权限；站点首页没有会话ID时不会被当作同一个会话归档。网页适配已覆盖新版消息气泡及旧版 `send_message` / `receive_message` DOM 的测试样本；登录态长会话仍需真实页面验收。

本地代理新增 Grok Build CLI / Desktop：采集官方 `~/.grok/sessions/**/updates.jsonl`，来源显示为 **Grok Build**，与网页 Grok 分开筛选。启动器自动发现本机 `.grok`，自定义目录用 `AI_ARCHIVE_GROK_BUILD_ROOT`；底层配置使用 `grokBuildRoots`。升级后重启代理生效。配置、数据边界和格式依据见 [Windows 同步说明](docs/11-Windows本地同步代理.md) 与 [macOS 同步说明](docs/12-macOS本地同步代理.md)。
