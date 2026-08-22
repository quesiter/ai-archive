# 知言归藏 V2.1 运维手册

## 1. 运行基线

| 组件 | 要求 |
| --- | --- |
| Node.js | 22 或更高 |
| pnpm | 11 |
| PostgreSQL | 17 |
| 队列 | PgBoss，共用 PostgreSQL |
| 时区 | Asia/Shanghai |
| 浏览器 | Chrome/Chromium |
| NAS | DSM 7.2.2 与 Container Manager |

## 2. 本地开发与验证

~~~powershell
Copy-Item .env.example .env
pnpm install
docker compose -f deploy/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm dev:server
pnpm dev:web
~~~

提交或发布前：

~~~powershell
pnpm typecheck
pnpm test
pnpm build
docker compose -f deploy/docker-compose.yml config
pnpm test:e2e-api
~~~

e2e-api 默认期望 /healthz 返回 V2.1.0，需要正在运行的测试服务。

## 3. 日常状态检查

~~~sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=120 app worker host-monitor postgres
curl -fsS http://127.0.0.1:18080/healthz
~~~

正常状态：

- /healthz 返回 ok=true 与 V2.1.0。
- app、postgres、host-monitor 为 healthy；worker 为 Up。
- host-monitor 只在 Compose 网络暴露 9091。
- “设置 → 系统状态”能读取数据库、项目容器和存储指标。

## 4. 升级

先备份，再执行：

~~~sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.1.0-clean-install.tar.gz
~~~

脚本会保留 deploy/.env 并核对新版本。健康检查仍返回旧号时，检查镜像缓存、反向代理目标和 app/worker/host-monitor 是否被强制重建。

V2.1 首次升级应在 app 日志确认 migration 0012 成功。可用只读 SQL 核对 tags、conversation_tags 已创建，旧派生表已移除，以及 conversations、conversation_revisions、projects、conversation_projects、reports 行数与升级前备份一致。

## 5. 队列

| 队列 | 说明 |
| --- | --- |
| analysis-weekly | 周报 |
| analysis-monthly | 月报 |
| classify-conversation | 单会话项目与标签整理 |
| reclassify-unlocked | 批量项目与标签整理 |
| nightly-ai-maintenance | 夜间增量整理编排 |
| import-archive | 历史 ZIP 导入 |
| email-report | 报告邮件 |
| redact-storage | 历史入库脱敏清理 |

定时任务：

| 时间 | 任务 |
| --- | --- |
| 周一 07:30 | 周报 |
| 每月 1 日 08:00 | 月报 |
| 周日 06:15 | 可选自动重评 |
| 每天 22:00 | 可选夜间增量项目与标签整理 |
| 每 5 分钟 | 延迟报告恢复与导入目录扫描 |

夜间任务只有 classification 与 wait_classification 两阶段；无候选时直接结束。

批量任务最多按固定候选列表分片续跑。candidate ids 和 offset 随续跑 job 保存，避免前一片更新状态后跳过后续会话。项目锁不会阻止自动补标签。

## 6. 模型与额度

设置键包括 llm.baseUrl、llm.apiKey、llm.model。先在设置页测试连接。

- batch：项目/标签批量整理、周报、月报，使用固定节流。
- interactive：模型测试和 Project Context，不使用 batch 固定间隔。
- 429、MiniMax Token Plan 等错误优先解析刷新时间或查询额度窗口。
- 后台任务 stats 保存 retryAt、quotaResetAt、source 和 resumeOffset。
- 刷新时间后加入缓冲并重新入队；额度接口不可用时使用兜底延迟。

额度等待是 queued/deferred 状态，不应重复触发任务。先看页面倒计时，再查 worker 日志。

LLM 与 SMTP 默认禁止回环、RFC1918、链路本地、云元数据和保留地址，并固定到已验证 DNS 结果。只对可信内网服务设置 ALLOW_PRIVATE_NETWORK_TARGETS=true。

## 7. 报告排错

周报/月报只依赖会话最新完整 Revision、项目、标签与正文。失败时检查：

1. 模型连接测试。
2. analysis_runs 的状态、窗口、error 和 stats。
3. Worker 是否运行。
4. 周期内是否有 complete Revision。
5. 是否处于额度延迟。
6. scope=analysis 的过滤后日志。

标签为空不会阻止报告；旧派生表不存在是 V2.1 正常状态。

## 8. 备份与恢复

Web 业务备份用于重建站点后的逻辑恢复。数据库脚本备份用于 NAS 灾备：

~~~sh
POSTGRES_USER=archive POSTGRES_DB=archive BACKUP_ROOT=/volume1/backup/ai-conversation-archive sh /volume1/docker/ai-conversation-archive/source/scripts/backup.sh
~~~

恢复前停止写入并优先在隔离环境演练：

~~~sh
sh /volume1/docker/ai-conversation-archive/source/scripts/restore.sh
~~~

业务备份 V2.1 包含 tags 和 conversationTags。导入 V2.0.2 备份时应看到旧派生数据未导入的 warning；这不是失败。不同 APP_MASTER_KEY 时加密设置会跳过，需要重新填写。

## 9. 导入排错

任务不动时检查 Worker、ZIP 大小、导入卷 UID 1000 权限、PgBoss 活跃 job 和 IMPORT_INBOX 文件是否还存在。Worker 启动扫描会重新入队仍为 queued 且源文件存在的任务；源文件缺失则标记失败。

## 10. 采集排错

- 插件无采集：检查域名适配、Session ID、设备配对、站点权限和 scope=capture 日志。
- 重复采集：检查客户端轻量变化检测和服务端 contentHash 幂等。
- 会话不完整：在详情切换最新 complete Revision，核对 completeness reason。
- 本地工具缺回答：升级同步代理并对近期数据执行 rebuild；不要删除旧 Revision。
- 搜索未定位消息：核对返回 searchHit 的 revisionId、messageOrdinal 和 Web 锚点。

## 11. 标签与项目排错

- 大小写/全半角重复：检查 normalizedName 唯一索引和 NFKC 归一化。
- 增量整理不补标签：确认 conversation_tags 为空时会成为 missing_tags 候选，且模型可用。
- 人工标签被替换：检查 source=manual 或 lockedByUser=true。
- 项目锁被改变：检查 conversation_projects.lockedByUser=true。
- 合并标签冲突：目标关系应保留最高 confidence，并对 manual/locked 取保护并集。
- 删除标签后会话仍应存在；只检查关联是否删除。

## 12. 安全检查

1. APP_MASTER_KEY 为真实随机值并已离线备份。
2. APP_ORIGIN 为 HTTPS，生产 Cookie 为 Secure。
3. PostgreSQL、DSM 管理端口、应用 HTTP 和 host-monitor 不暴露公网。
4. TRUST_PROXY 只配置真实跳数。
5. EXTENSION_ORIGINS 只含可信扩展 ID。
6. 默认保持 ALLOW_PRIVATE_NETWORK_TARGETS=false。
7. app/worker/host-monitor 为非 root、只读、no-new-privileges、cap_drop ALL。
8. 导入目录只授予 UID 1000 必要权限。
9. host-monitor 不挂 Docker Socket。
10. 定期撤销不用的设备并轮换外部 API Key。
11. 历史脱敏清理前先备份；该操作不可逆。
12. 发布前执行依赖、镜像漏洞与敏感信息扫描。

## 13. 发布一致性

根包、server、web、contracts、Chrome Manifest 和同步代理必须同时为 2.1.0/V2.1.0。CHANGELOG 顶部新增本次事实，不改写历史版本。交付包不得包含 node_modules、.env、数据库、导入临时文件、本地日志、浏览器状态或旧 release 目录。
