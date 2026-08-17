# 变更历史

本文件合并原 `docs/UPDATE-*.md` 的版本说明。具体部署、升级、备份和排错步骤统一查看 [运维手册](OPERATIONS.md)。

## 2026-08-17 V20260817：会话导出、项目合并、设备下载与安全加固

- 会话详情自动折叠 Codex 工具链、推理过程等内部信息，并隐藏 `<recommended_plugins>`；CSV、Markdown、XLSX 导出同样排除这些内部记录。
- 管理员可按单个会话或单个项目导出全部可见对话，用户可将源项目合并到目标项目。
- Devices 页面集中提供 Windows、macOS 和 Chrome 组件下载，并统一客户端版本标识。
- 增强请求同源校验、认证限流、Token 处理、初始化及配对并发安全、SSRF/DNS 重绑定防护、解压限制、日志脱敏、正则安全和链接协议校验。
- app/worker 使用非 root 用户并移除 Linux capabilities；PostgreSQL 仅保留卷权限调整与切换到 `postgres` 账户所需的最小能力集。修复非法 UUID 返回 500、分类规则误判和若干同步稳定性问题。
- 更新全部生产及开发依赖，依赖审计无已知漏洞。

发布包：`release/ai-conversation-archive-nas-V20260817-clean-install.tar.gz`、`release/ai-archiveextension-V20260817-chrome.zip`、`release/ai-conversation-archive-windows-sync-V20260817.zip`、`release/ai-conversation-archive-macos-sync-V20260817.tar.gz`。

## 2026-07-28 v45：0.2.22 Chat Memo 多平台导入

- 历史导入支持 Chat Memo 导出的文本 ZIP，自动识别 ChatGPT、Gemini、腾讯元宝、DeepSeek、千问和豆包。
- 从 URL 提取真实平台 Session ID，保留标题、原始链接、消息角色和消息时间；相同 Session 与内容通过现有快照哈希幂等去重，不同分支保存为 Revision。
- 混合平台导入任务在导入记录中保存 `providers` 列表；导入页显示实际平台，豆包加入会话平台筛选。
- Chat Memo 导入快照仅在导出消息数量与消息标记一致时标记为完整，否则保留为部分记录。

## 2026-07-28 v44：Chrome 插件 0.4.1 防止 ChatGPT 重复扫描

- 为采集评估增加同步重入锁，避免多个异步轻量检查同时启动完整采集。
- 完整/增量扫描期间暂时断开 MutationObserver，忽略自动滚动和虚拟列表重挂载产生的 DOM 变化。
- 合并待处理触发原因并设置最早执行时间，连续 DOM 变化不会不断延长或重复排队扫描。
- 识别虚拟列表视口缩小，已完成会话不再因可见消息变少而反复做完整扫描；真实生成结束、分支变化和手动重试仍会触发采集。
- 修正本地基线消息数使用完整 payload，而不是轻量可见窗口消息数。

发布包：`release/ai-archiveextension-0.4.1-chrome.zip`。

## 2026-07-27 v43：0.2.21 智能归类增量候选优化

- 手动智能归类默认改为 `scope=incremental`，只处理新会话、未归类、低置信度和最新修订晚于上次归类的候选会话，避免 1200+ 会话每次都重新扫描正文。
- 完整重评保留为显式模式：项目页选择“完整重评未锁定会话”时才跑全部未人工锁定会话。
- 批量归类分片续跑会固定首次筛出的候选 ID 列表和顺序，防止上一批写入结果后导致下一批 offset 跳过剩余候选。
- 归类任务 stats 增加 `scope` 和 `candidateReasons`，Web 端显示本轮是增量候选还是完整重评，并展示未归类、低置信度、内容已更新等候选数量。

## 2026-07-27 v42：0.2.20 导入假死恢复与知识抽取容错

- `import-archive` job 显式设置 6 小时过期时间，避免大 ZIP 解析被 PgBoss 默认 15 分钟超时打断。
- 导入页、Worker 启动和导入目录扫描会识别没有活跃 PgBoss job 的 processing 导入任务；源 ZIP 仍在 inbox 时自动重新入队，源文件缺失时标记失败并写入日志。
- 知识抽取支持顶层数组、`items`/`knowledge`/`results`/`data` 等包装字段，以及 `category/name/content/score/sources` 等常见别名。
- 单条会话知识抽取返回格式异常时改为记录 warning 并跳过该会话，不再拖垮整轮周报/月报。
- 批量智能归类 job 过期时间提升到 6 小时，配合分片续跑降低慢模型和大批量会话导致的超时风险。

## 2026-07-27 v41：0.2.19 智能归类分片续跑与僵尸任务修复

- 批量智能归类改为分片执行：单个 PgBoss job 只处理一批会话或一段软时间，到点后自动入队下一批。
- `reclassify-unlocked` job 显式设置更长过期时间，避免使用 PgBoss 默认 15 分钟导致 `handler execution exceeded 900000ms`。
- 后台任务接口和 Worker 启动时会自动把长时间无进度的 queued/running 归类任务标记为失败，避免 UI 一直显示运行中。
- 续跑时根据 `background_tasks.processed_count` 恢复进度，PgBoss 重试同一批时不会从头累计。

## 2026-07-26 v40：0.2.18 总览与日志展示重构

- 总览页移除旧任务中心模块，改为展示总项目、总会话、已归类会话、未归类会话、文本量和估算 token。
- 新增分类分布与近 7 日分类增长统计，帮助判断智能归类后形成了多少类别、每个类别有多少会话。
- 日志页改为紧凑表格视图，并在平台筛选中显示各 AI 平台 Session 数。
- 新增 `/api/v1/conversations/provider-counts`，供日志页和会话页复用平台会话数量。
- 修复 Web 平台筛选和备份导入警告里的残留乱码。

## 2026-07-26 v39：Windows 同步包 0.2.18 配对码读取修复

- 修复 Windows `.bat` 首次配对时已经输入配对码但仍提示 `Pairing code is required on first run` 的问题。
- 原因是批处理变量在括号代码块中提前展开；脚本改为 delayed expansion。
- 重新生成 Windows 便携同步包。

## 2026-07-26 v38：0.2.17 大数据量备份导出修复

- `/api/v1/backups/export` 改为 PostgreSQL cursor 分批读取、流式 JSON 输出并实时 gzip。
- 设置页“下载备份”改为浏览器原生附件下载，避免大数据量时前端和服务端一次性持有完整文件。
- 修复 NAS 点击备份按钮后 app 容器触发 `JavaScript heap out of memory` 的失败形态。

## 2026-07-26 v37：0.2.16 智能归类颗粒度收敛

- 智能归类提示词改为长期项目/粗类别口径，优先复用已有项目。
- 本地粗分类规则会把过细的一次性咨询收敛到硬件设备、网络运维、财税社保、内容运营、生活出行等大类。
- 过细建议不会自动新建项目，无法收敛时保持待归类。

## 2026-07-26 v36：0.2.15 项目归类结果总览

- 新增 `/api/v1/projects/overview`，一次返回项目、分类、未归类会话和知识条目统计。
- 项目知识页新增分类总览数字条。
- 分类结果改为按项目展开的紧凑分组视图，默认收起服务端分类结果。

## 2026-07-26 v35：0.2.14 日志按 AI 平台筛选

- `/api/v1/logs` 新增 `provider` 查询参数。
- 日志平台筛选兼容 `metadata.provider`、`metadata.sourceProvider` 和 `metadata.conversationProvider`。
- Web 日志页新增 AI 平台下拉筛选。

## 2026-07-26 v34：0.2.13 NAS 升级版本校验

- `/healthz` 新增运行版本号，并在响应头返回 `X-AI-Archive-Version`。
- `scripts/update-server.sh` 默认无缓存构建镜像并强制重建 app/worker。
- 健康检查只有返回目标版本时才判定升级成功。

## 2026-07-26 v33：0.2.12 Codex 搜索索引二次加固

- 修订搜索摘要上限进一步收紧到 2048 字符。
- 新增 `0008_bounded_revision_search_text` 迁移，裁剪历史超长搜索摘要并重建 `pg_trgm` 索引。
- Codex 本地同步 adapter 升级到 `codex-jsonl-v4`。

## 2026-07-26 v32：0.2.11 Codex 长会话搜索索引入库修复

- 搜索摘要改为有上限的受控文本，避免超长 Codex/OpenClaw 会话撑爆 PostgreSQL trigram 索引。
- 完整正文仍保存在 `messages` 和 `message_segments`。
- 服务端数据库异常不再向同步器回显完整 SQL 和超长参数。

## 2026-07-26 v31：0.2.10 智能归类兜底建议增强

- 智能归类遇到敏感输入拒绝或模型只输出 `<think>` 时，尽量保留有意义的低置信度建议。
- 上游 OpenAI 兼容错误识别兼容多种 SDK 响应结构。
- 分类提示词明确禁止输出推理、Markdown、解释和 Schema 示例。

## 2026-07-26 v30：0.2.9 智能归类 JSON 容错与敏感输入兜底

- JSON 提取器跳过 `<think>`/`<reasoning>` 推理块，并从后续合法 JSON 继续解析。
- 单条会话模型失败不再拖垮整批分类任务。
- 分类进度新增 AI 兜底统计。

## 2026-07-26 v29：0.2.8 Web 后台备份与恢复

- 设置页新增“备份与恢复”面板。
- 新增 `/api/v1/backups/export` 和 `/api/v1/backups/import`。
- 备份不包含管理员账号、登录会话和一次性配对码。
- 导入时如 `APP_MASTER_KEY` 不同，会跳过加密设置并提示重新填写密钥类配置。

## 2026-07-26 v28：0.2.7 Windows 同步脚本安全模式

- Windows 源码脚本和便携脚本默认改为近期安全导入加后续监听。
- 新增 `--recent-days`、`--max-files`、`--max-file-mb`、`--max-messages`、`--delay-ms`、`--skip-initial-scan`、`--include-large` 和 `--reset-state`。
- 完整历史导入改为显式 `full-rebuild` 命令。

## 2026-07-26 v27：0.2.6 Codex 超大会话同步超时优化

- 服务端采集入库改为批量写入消息与消息片段。
- Windows 同步器遇到 504 或非 JSON 响应时只显示干净摘要。
- 新增 Windows 便携同步包入口。

## 2026-07-26 v26：0.2.5 Codex 控制字符入库修复

- 本地同步器移除 ANSI 转义、NUL 和 PostgreSQL 不支持的控制字符。
- Codex/OpenClaw/Claude Code adapter 同步升级。
- 服务端增加最终入库清洗。

## 2026-07-26 v25：0.2.4 Codex 大会话入库修复

- `conversation_revisions.search_text` 改为受控搜索摘要。
- 完整消息内容仍保存在消息与分段表中。
- 增加超长工具输出与大量消息的回归测试。

## 2026-07-26 v24：0.2.3 服务器更新脚本

- 新增 `scripts/update-server.sh`，支持 NAS/服务器从新版 `.tar.gz` 源码包更新。
- 更新脚本会保留旧 `deploy/.env`，创建 PostgreSQL 和 imports 数据目录，并完成镜像构建、源码切换和服务重启。

## 2026-07-26 v23：0.2.2 Windows 一键同步脚本

- 新增 `scripts/sync-local-windows.bat`。
- Codex JSONL adapter 升级到 `codex-jsonl-v2`，上传幂等键包含 adapterVersion。
- Windows 脚本默认导入 `%USERPROFILE%\.codex`，保留 `%USERPROFILE%\.openclaw` 扫描，并自动检测 `%USERPROFILE%\.claude`。

## 2026-07-26 v22：0.2.1 Codex 同步代理容错

- Codex 本地同步代理会脱敏和截断截图、base64、二进制内容和内部元数据。
- `rebuild` 遇到单个异常文件时继续导入剩余会话。
- 上传失败时显示 HTTP 状态、服务端错误和最多 10 条校验 issue。

## 2026-07-25 v21：0.2.0 全新安装包与 0.4.0 Chrome 插件

- 项目根包、Contracts、Server、Web 和同步代理版本进入 `0.2.x`。
- Chrome 扩展版本提升到 `0.4.0`。
- NAS 发布包改为全新安装口径，不再包含旧升级脚本。
- 重新生成 Chrome 插件 zip、NAS 源码发布包和 Docker 镜像标签。

## 2026-07-25 v20：轻量变化检测、增量采集与 Claude Code

- Chrome 扩展采集链路改为先轻量检测变化。
- 新增增量采集协议字段，包括 `captureMode`、`triggerReason`、`baseRevisionId` 和 `baseMessageCount`。
- 本地同步代理支持 OpenClaw、Codex、Claude Code。

## 2026-07-25 v19：报告 Schema 容错

- 周报/月报兼容多种 OpenAI 兼容模型 JSON 返回形态。
- 没有项目知识时生成本地占位报告，不再直接失败。
- Web UI 将报告失败信息压缩成可读摘要。

## 2026-07-25 v18：异步表单 reset 修复

- 修复异步表单提交后出现 `Cannot read properties of null (reading 'reset')` 的问题。
- 覆盖项目、导入、设备和设置等页面。

## 2026-07-25 v17：紧凑会话列表

- `/conversations` 从大卡片改为紧凑表格式列表。
- 每行显示平台、标题、Session ID、项目归类、完整性、消息数量和更新时间。
- 会话列表每页请求 100 条，并增加上一页、下一页分页控制。

## 2026-07-25 v16：仪表盘去重与采集健康概览

- 仪表盘不再重复展示同一批不完整采集会话。
- 近 24 小时采集改为按平台展示完整、不完整和失败数量。
- 采集健康面板可直接跳转到过滤后的采集日志。

## 2026-07-25 v15：操作日志

- 新增持久化 `operation_logs` 表。
- 新增 `/api/v1/logs`，支持按范围、级别、状态、关键字和数量过滤。
- 分类、导入、采集、报告和设备操作都会写入日志。

## 2026-07-24 v14 及更早

- 优化 AI 分类节能模式、进度展示、日志、报告任务状态和设置页模型测试。
- 修复千问、腾讯元宝、Grok、MiniMax 等平台的 Session ID、角色识别和消息稳定性问题。
- 增加永久删除归档、标题修复、重复快照判重、项目知识页和报告页等核心能力。
