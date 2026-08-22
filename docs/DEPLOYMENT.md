# 知言归藏 V2.1 部署文档

本文面向群晖 NAS、Chrome 插件和 Windows/macOS 同步代理。当前源码组件版本统一为 V2.1.0。构建交付包后应以实际发布的 SHA-256 清单为准；不要沿用旧版本摘要验证新包。

## 1. 群晖 NAS 全新安装

推荐 DSM 7.2.2、Container Manager 和 x86-64。目录示例：

~~~sh
mkdir -p /volume1/docker/ai-conversation-archive/source
mkdir -p /volume1/docker/ai-conversation-archive/data/postgres
mkdir -p /volume1/docker/ai-conversation-archive/data/imports/inbox
mkdir -p /volume1/docker/ai-conversation-archive/data/imports/processed
mkdir -p /volume1/docker/ai-conversation-archive/data/imports/failed
chown -R 1000:1000 /volume1/docker/ai-conversation-archive/data/imports
chmod -R u+rwX,go-rwx /volume1/docker/ai-conversation-archive/data/imports
~~~

把 V2.1.0 源码包解压到 source。进入 source 后：

~~~sh
cp deploy/.env.synology.example deploy/.env
openssl rand -hex 24
openssl rand -base64 32
~~~

把结果分别填入 deploy/.env 的 POSTGRES_PASSWORD 和 APP_MASTER_KEY，并设置实际 HTTPS APP_ORIGIN。APP_MASTER_KEY 必须长期保存；丢失后无法解密已保存设置。

启动：

~~~sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
curl -fsS http://127.0.0.1:18080/healthz
~~~

app 启动时先执行数据库 migration。健康响应应包含 version=V2.1.0；app、host-monitor、postgres 为 healthy，worker 为 Up。

首次访问 Web 后创建管理员和 TOTP。TOTP Secret/URI 只在初始化时妥善保存。

## 2. 关键环境变量

| 变量 | 说明 |
| --- | --- |
| APP_ORIGIN | 用户实际访问 Web 的 HTTPS Origin |
| APP_MASTER_KEY | 32 字节 Base64 主密钥 |
| POSTGRES_PASSWORD | 随机数据库密码 |
| ARCHIVE_DATA_DIR | PostgreSQL 与导入数据根目录 |
| ARCHIVE_PORT | 只绑定 127.0.0.1 的应用端口 |
| TRUST_PROXY | 可信反向代理跳数；默认 false |
| EXTENSION_ORIGINS | 允许的固定 Chrome 扩展 Origin |
| ALLOW_PRIVATE_NETWORK_TARGETS | 是否允许 LLM/SMTP 访问内网，默认 false |
| ARCHIVE_CGROUP_PARENT | 四个服务共享的父 cgroup |
| ARCHIVE_STORAGE_BUDGET_GB | 可选项目数据软预算 |
| LOG_LEVEL | 日志等级 |

只有应用确实位于可信反向代理后才设置 TRUST_PROXY=1。自行重签扩展后必须把 EXTENSION_ORIGINS 改为新扩展 ID。只有明确使用可信内网模型或 SMTP 时才允许私网目标，并同时使用防火墙和最小权限账号。

## 3. 反向代理

建议公网只开放一个 HTTPS 入口，例如：

| 项目 | 值 |
| --- | --- |
| 来源 | HTTPS ai-archive.example.com:18443 |
| 目标 | HTTP 127.0.0.1:18080 |

不要向公网暴露 DSM 管理端口、PostgreSQL 15432、应用内部 HTTP 端口或 host-monitor 9091。APP_ORIGIN 必须与外部 HTTPS Origin 一致。

## 4. V2.0.2 升级到 V2.1

升级前同时创建数据库灾备和 Web 业务备份。常规脚本用法：

~~~sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.1.0-clean-install.tar.gz
~~~

脚本保留 deploy/.env、尝试备份数据库、解压源码、构建镜像、切换版本、强制重建 app/worker/host-monitor，并核对 /healthz。只在可丢弃的测试环境使用 SKIP_BACKUP=1。

Migration 0012 会：

1. 创建 tags 与 conversation_tags。
2. 保留所有 Conversation、Revision、Message、Project Assignment、人工项目锁和 Report。
3. 清理旧后台任务，防止 V2.1 Worker 恢复。
4. 删除旧派生表。
5. 不把旧派生内容转换为 Tag。

升级后运行一次“项目与标签 → 增量整理”，为已有项目但没有标签的会话补充标签。

## 5. Chrome 插件

构建 V2.1.0 插件：

~~~powershell
pnpm --filter @ai-archive/extension build
pnpm --filter @ai-archive/extension zip
~~~

打开 chrome://extensions，启用开发者模式并加载构建目录或解压后的发布包。在 Web“设备”页创建配对码，再由插件认领。

Chrome 不允许普通扩展自动固定工具栏或默认启用无痕；需由用户在扩展详情中设置。设备 Token 只写 storage.local，不进入 Chrome Sync。

支持 ChatGPT、Gemini、Grok、腾讯元宝、豆包、MiniMax、DeepSeek、千问和 Kimi 的当前适配域名。站点 DOM 变化时应先检查适配测试和采集日志。

## 6. Windows/macOS 同步代理

构建：

~~~powershell
pnpm --filter @ai-archive/openclaw-sync build
python scripts/package-macos-sync.py
~~~

macOS 发布包必须通过脚本生成；脚本会把 `AI-Archive-Sync.command` 固定为 `0755` 和纯 LF 换行，其余文件固定为 `0644`，并在覆盖发布包前校验目录结构、执行权限、换行和入口 shebang。可再次运行 `python scripts/package-macos-sync.py --verify release/ai-conversation-archive-macos-sync-V2.1.0.tar.gz` 独立复核。

Windows 使用 sync-local-windows.bat 完成配对，可用 install/uninstall 管理登录后隐藏计划任务，日志位于 %LOCALAPPDATA%\AIArchive\Sync\Logs。

macOS 使用 AI-Archive-Sync.command 完成配对并安装 LaunchAgent，日志位于 ~/Library/Logs/AIArchive。

代理只读取 OpenClaw、Codex、Claude Code 会话文件，不读取模型密钥、Cookie 或 credential 文件。升级代理通常复用现有配对配置；设备被撤销或服务器地址变化时重新配对。

## 7. 历史导入

Web“导入”支持 ChatGPT 官方导出 ZIP、Gemini Takeout 和已适配的 Chat Memo ZIP。也可把 ZIP 放入 IMPORT_INBOX，由 Worker 每五分钟扫描。导入器限制压缩/展开大小、阻止路径穿越，并对内容做入库脱敏与幂等检查。

## 8. 模型配置

在设置中填写 OpenAI 兼容 Base URL、API Key、模型并测试。模型用于项目与标签整理、周报、月报和用户主动生成 Project Context。

归档、导入、同步、搜索、Revision、原始导出和备份不依赖模型。Batch 请求继续节流并支持额度延迟；Context 与模型测试使用 interactive 优先级。

## 9. 备份与恢复

Web 业务备份包含会话、修订、消息、设备、项目、标签、报告、设置、导入记录和操作日志，不包含管理员、登录 Session 和一次性配对码。

恢复到新站点：

1. 全新部署并重新初始化管理员/TOTP。
2. 在“设置 → 备份与恢复”上传 json.gz。
3. 若 APP_MASTER_KEY 指纹不同，按 warning 重新填写加密设置。
4. 重新配对客户端。
5. 检查会话、项目、标签、报告和修订数量。

V2.0.2 备份可以导入；旧派生字段会忽略并 warning。没有 Tag 表数据时恢复为空标签，不影响其他业务表。

## 10. 容器安全

app、worker 和 host-monitor 以非 root、只读根文件系统运行，启用 no-new-privileges 并 drop ALL capabilities，只开放受限 tmpfs 和必要导入卷。host-monitor 只读挂载 /proc 与 /sys/fs/cgroup，不挂 Docker Socket、不发布端口。PostgreSQL 仅恢复官方入口脚本必需 capabilities。部署时不得放宽这些约束。
