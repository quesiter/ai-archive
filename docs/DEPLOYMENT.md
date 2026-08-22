# 知言归藏部署文档

本文面向群晖 NAS、Chrome 插件、Windows/macOS 本地同步代理和数据备份恢复。当前服务端、Web、Chrome 插件和同步代理统一为 `V2.0.0`。

## 1. 群晖 NAS 全新安装

推荐环境：群晖 DSM 7.2.2、Container Manager、x86-64 机型。DS923+ 的 Ryzen R1600 可以运行本项目；默认配置下不要在同一台 NAS 上同时部署本地大模型。

1. 上传源码包到 NAS：

```sh
/volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.0.0-clean-install.tar.gz
```

2. 创建源码目录和数据目录：

```sh
mkdir -p /volume1/docker/ai-conversation-archive/source
mkdir -p /volume1/docker/ai-conversation-archive/data/postgres
mkdir -p /volume1/docker/ai-conversation-archive/data/imports/inbox
mkdir -p /volume1/docker/ai-conversation-archive/data/imports/processed
mkdir -p /volume1/docker/ai-conversation-archive/data/imports/failed
chown -R 1000:1000 /volume1/docker/ai-conversation-archive/data/imports
chmod -R u+rwX,go-rwx /volume1/docker/ai-conversation-archive/data/imports
cd /volume1/docker/ai-conversation-archive/source
tar -xzf /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.0.0-clean-install.tar.gz
```

3. 生成配置文件、数据库密码和主密钥：

```sh
cp deploy/.env.synology.example deploy/.env
POSTGRES_PASSWORD=$(openssl rand -hex 24 2>/dev/null || dd if=/dev/urandom bs=24 count=1 2>/dev/null | hexdump -ve '1/1 "%02x"')
APP_MASTER_KEY=$(openssl rand -base64 32 2>/dev/null || dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n')
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" deploy/.env
sed -i "s|^APP_MASTER_KEY=.*|APP_MASTER_KEY=$APP_MASTER_KEY|" deploy/.env
```

按需编辑 `deploy/.env` 中的 `APP_ORIGIN`、`ARCHIVE_PORT` 和 `ARCHIVE_DATA_DIR`。生产环境建议 `APP_ORIGIN` 使用 HTTPS 外部地址。

生产安全相关配置：

- `TRUST_PROXY` 默认 `false`。只有应用确实位于可信反向代理后时，才设置代理跳数，例如 `1`；不要直接设置为 `true` 信任任意转发头。
- `EXTENSION_ORIGINS` 默认只允许官方固定 ID `chrome-extension://daolmhnfgimkgnnadojnmhkkjdolplfi`。自行重签 Chrome 扩展时，必须改为新扩展 ID；多个来源用英文逗号分隔。
- `ALLOW_PRIVATE_NETWORK_TARGETS` 默认 `false`，此时 LLM 和 SMTP 会阻止回环、内网、链路本地、云元数据和保留地址，并将连接固定到已验证 DNS 结果。只有明确使用可信内网模型或 SMTP 时才设为 `true`。
- app 和 worker 镜像以非 root 用户运行。NAS 上已有的 `data/imports` 目录必须允许容器中的 Node 用户（UID 1000）读写；如出现 `EACCES`，请在宿主机调整该目录权限后再启动。
- `host-monitor` 以非 root、只读根文件系统运行，仅只读挂载宿主 `/proc` 与 `/sys/fs/cgroup`，不挂载 Docker Socket、不读取 NAS 数据卷容量，也不发布宿主端口。不要为它额外增加特权或端口映射。
- `ARCHIVE_CGROUP_PARENT` 默认 `ai-conversation-archive`，用于把本项目四个容器放入同一父 cgroup 并汇总实际资源用量。所有服务必须使用相同值。
- `ARCHIVE_STORAGE_BUDGET_GB` 是可选的项目数据软预算。留空时页面只显示数据库与导入文件的实际用量，不计算容量百分比；填写正数后才启用项目存储预算告警。

4. 构建并启动：

```sh
cd /volume1/docker/ai-conversation-archive/source/deploy
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
curl -fsS http://127.0.0.1:18080/healthz
```

健康响应中的 `version` 应为 `V2.0.0`；app、host-monitor 与 postgres 应为 healthy，worker 应保持运行。

5. 首次访问 Web 后台，创建管理员账号。系统会显示 TOTP Secret/URI，请立即加入验证器，之后用密码和六位验证码登录。

## 2. 反向代理与端口

推荐在 DSM 的“登录门户”或“反向代理服务器”中新增规则：

| 项目 | 值 |
| --- | --- |
| 来源协议 | HTTPS |
| 来源主机 | `ai-archive.gyee.tech` |
| 来源端口 | `18443` |
| 目标协议 | HTTP |
| 目标主机 | `127.0.0.1` |
| 目标端口 | `18080` |

路由器只转发公网 TCP `18443` 到 NAS TCP `18443`。不要把 DSM 管理端口、PostgreSQL 端口或应用内部 HTTP 端口直接暴露到公网。

如果没有固定公网 IP，可以使用 Cloudflare Tunnel、Tailscale、ZeroTier 或 VPN。无论哪种方式，`APP_ORIGIN` 都应填写用户实际访问 Web 后台的 HTTPS 地址。

## 3. 服务器更新

把新版源码包上传到 `/volume1/docker/ai-conversation-archive/`，然后执行：

```sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.0.0-clean-install.tar.gz
```

脚本会保留现有 `deploy/.env`，创建必要数据目录，尝试数据库备份，解压新版源码包，构建镜像，切换源码目录，强制重建 app、worker 与 host-monitor 容器，并检查 `/healthz` 返回的版本号。脚本会先尝试直接访问 Docker；若 NAS 账户只能执行免交互的 `sudo docker`，则自动切换到该方式。数据目录无法由宿主账户直接维护时，会复用本机已有的应用镜像以 root 容器完成 UID 1000 所需的目录创建和授权。

测试环境如果确认不需要备份，可以跳过备份：

```sh
cd /volume1/docker/ai-conversation-archive/source
SKIP_BACKUP=1 sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.0.0-clean-install.tar.gz
```

如果已经手动把源码覆盖到 `source` 目录，可以原地构建重启：

```sh
cd /volume1/docker/ai-conversation-archive/source
sh scripts/update-server.sh
```

## 4. Chrome 插件

最新插件包：

```text
release/ai-archiveextension-V2.0.0-chrome.zip
```

安装方式：

1. 解压 zip。
2. 打开 `chrome://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择解压目录。
5. 在 Web 后台“设备”页生成 Chrome 配对码。
6. 打开插件，只输入配对码即可；设备名称只在后台填写。

Chrome 不允许普通扩展自动固定到工具栏，也不允许扩展自行默认启用无痕模式。插件已声明支持无痕上下文；用户仍需在 Chrome 扩展详情页打开“允许在无痕模式下使用”。企业环境可以通过 Chrome 企业策略统一固定和开启权限。

设备令牌只保存在浏览器本机的 `storage.local`，不会写入 Chrome Sync。升级旧扩展后会自动清理曾同步的认证字段；如果怀疑同步账号或浏览器配置泄露，请在设备页撤销设备并重新配对。

支持的页面入口包括：

- `chatgpt.com`
- `chat.openai.com`
- `gemini.google.com`
- `grok.com`
- `yuanbao.tencent.com`
- `agent.minimax.io`
- `agent.minimaxi.com`
- `chat.deepseek.com`
- `qianwen.com`
- `www.qianwen.com`
- `www.kimi.com`
- `kimi.com`

扩展会贴在页面右上侧边，自动采集或上传时有轻微动效提示。未变化的会话只做轻量检查，不滚动页面、不扫描全量消息、不重复上传。

## 5. 本地同步代理

### Windows

公司 Windows 电脑推荐使用便携包：

```text
release/ai-conversation-archive-windows-sync-V2.0.0.zip
```

解压到任意目录后先双击 `sync-local-windows.bat` 完成首次配对。首次运行输入 Web 后台生成的 `OpenClaw/Codex 同步代理` 配对码。默认模式只导入近期安全范围并持续监听新增会话。

完成首次配对后，脚本会自动安装并启动后台计划任务，避免长期保留前台命令行窗口。之后也可以用同一个入口重新安装：

```bat
sync-local-windows.bat install
```

后台任务会在当前用户登录后隐藏启动，并复用本机配对配置。日志位于 `%LOCALAPPDATA%\AIArchive\Sync\Logs`。卸载后台任务：

```bat
sync-local-windows.bat uninstall
```

完整历史导入需要显式执行：

```bat
sync-local-windows.bat full-rebuild
```

只导入一次、不持续监听：

```bat
sync-local-windows.bat rebuild-only
```

### macOS / OpenClaw

MacBook 上使用最新 macOS 同步包：

```text
release/ai-conversation-archive-macos-sync-V2.0.0.tar.gz
```

解压后双击 `AI-Archive-Sync.command`。首次运行输入 Web 后台生成的 `OpenClaw/Codex 同步代理` 配对码；配对成功后脚本会询问是否安装后台同步。输入 `Y` 后会自动安装并启动 macOS LaunchAgent，之后登录系统会隐藏运行。

如果之后需要重新安装或卸载后台同步，双击 `AI-Archive-Sync.command` 后在菜单中选择对应操作即可。后台日志位于 `~/Library/Logs/AIArchive`。

代理会读取 OpenClaw、Codex 和 Claude Code 的本地 JSONL 会话文件。它只上传会话内容，不读取模型密钥、Cookie、token 或 credential 文件。

`V2.0.0` 会合并扫描期间发生的文件变化，并在 Codex 文件 mtime 没有更新时使用实际观察时间记录后续修订；服务端也会按修订创建时间稳定选择最新答案。升级同步包后重新安装后台任务即可使用新代理，已有配对配置不需要重建。

## 6. 历史导入

Web 后台“导入”页支持：

- ChatGPT 官方数据导出 ZIP。
- Gemini Takeout ZIP。
- Chat Memo 多平台导出 ZIP（当前解析 ChatGPT、Gemini、元宝、DeepSeek、千问和豆包）。
- 把 ZIP 放入 `IMPORT_INBOX` 目录，由 Worker 定时发现并入队。

Grok、腾讯元宝、MiniMax、DeepSeek、千问、Kimi 等平台没有稳定官方批量历史 API，旧会话主要通过浏览器打开会话后由插件补录。

## 7. 分析、分类与知识

在“设置”页填写 OpenAI 兼容接口的 Base URL、API Key 和模型名，并点击“测试”确认可用。

智能归类默认使用增量候选：只处理新会话、未归类、低置信度或最新修订晚于上次归类的会话。节能模式会尽量使用本地匹配和缓存，减少把大量会话重复发送给模型；完整重评需要在“分类结果”页手动选择。“项目知识”页可以单独重建中文知识，并回到原始消息核对依据。周报/月报会从已归类会话中抽取知识，再生成报告。

默认所有 AI 请求至少间隔 82 秒。MiniMax Token Plan 用完时，系统读取错误或额度接口中的刷新时间，在刷新后增加 10 分钟缓冲再自动续跑；无法取得刷新时间时一小时后重试。启用夜间维护后，每天 Asia/Shanghai 22:00 依次运行增量归类和知识分析。

模型不是归档核心链路依赖；没有配置模型时，采集、导入、同步、会话列表、搜索、修订查看、导出和备份恢复仍可运行。

采集入口会在消息、快照哈希和搜索索引写入前对密码、密钥、Authorization、私钥、数据库连接串、带认证 URL 和 SSH/SFTP 登录信息打码。部署后建议在“设置 > 自定义脱敏规则”一键启用安全规则包；该操作也会创建历史数据清理任务。清理是不可逆操作，运行前应先完成数据库备份。

## 8. 备份与恢复

Web 后台“设置 > 备份与恢复”支持下载业务备份和导入备份。备份包含会话、修订、消息、设备、项目、知识、报告、设置、导入记录和操作日志，不包含管理员账号、登录会话和一次性配对码。

重建网站后的恢复流程：

1. 全新安装并启动服务。
2. 首次访问后台，重新创建管理员并绑定 TOTP。
3. 打开“设置 > 备份与恢复”。
4. 上传 `.json.gz` 备份文件。
5. 点击“导入备份并替换数据”。

如果重建时更换了 `APP_MASTER_KEY`，导入会跳过加密设置，之后需要在设置页重新填写 LLM API Key 和 SMTP 密码。

数据库级备份可以放在 DSM 任务计划中每日执行：

```sh
POSTGRES_USER=archive POSTGRES_DB=archive \
BACKUP_ROOT=/volume1/backup/ai-conversation-archive \
sh /volume1/docker/ai-conversation-archive/source/scripts/backup.sh
```

## 9. 已知边界

- 全量归档指当前页面可见分支的全部可见文本。
- 隐藏推理、已删除消息、未访问分支、附件和未同步临时会话无法保证归档。
- 平台页面 DOM 会变化；适配器失败会记录日志，但不会影响其他平台。
- 上游删除不会自动删除本地版本；需要在 Web 面板手工永久删除归档。
