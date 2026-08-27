# 知言归藏 Windows 本地同步代理

> 同步日期：2026-08-28。当前代理版本 `V2.3.0`。代理只读扫描本地 OpenClaw、Codex、Claude Code 会话并通过设备 Token 上传；不会读取模型密钥、Cookie 或 credential 文件。

| 文档属性 | 内容 |
| --- | --- |
| 文档类型 | Windows 客户端安装与运行手册 |
| 配置项标识 | `DOC-WIN-AGENT-V2.3` |
| 状态 | 发布基线 |

## 1. 首次使用

1. 安装 Node.js 22 或 24 LTS，确认 `node` 在 `PATH` 中。
2. 解压 `ai-conversation-archive-windows-sync-V2.3.0.zip` 到固定目录，例如 `C:\AIArchiveSync`。
3. 在 Web“设备”页创建“OpenClaw/Codex 同步代理”配对码。
4. 双击 `sync-local-windows.bat`，输入配对码。
5. 默认先执行近期安全重建，再安装并启动当前用户的隐藏计划任务。

配对配置和增量状态默认写入：

```text
%USERPROFILE%\.config\ai-archive\openclaw-sync.json
%USERPROFILE%\.config\ai-archive\openclaw-sync-state.json
```

程序使用临时文件加原子 rename 保存，并尝试把目录/文件权限设置为 0700/0600。设备 Token 在配置内，请不要发送或纳入云盘公开分享。

## 2. 后台任务与日志

安装后创建当前用户计划任务 `AI Archive Local Sync`，登录后隐藏运行。日志目录：

```text
%LOCALAPPDATA%\AIArchive\Sync\Logs
```

常用命令：

```bat
sync-local-windows.bat install
sync-local-windows.bat uninstall
sync-local-windows.bat rebuild-only
sync-local-windows.bat watch-only
sync-local-windows.bat full-rebuild
```

- `install`：安装/更新隐藏后台任务。
- `uninstall`：移除后台任务，不删除配对配置和状态。
- `rebuild-only`：按安全窗口扫描一次后退出；`once` 是同义命令。
- `watch-only`：跳过启动扫描，只监听后续变化。
- `full-rebuild`：显式包含全部历史和大文件，可能产生较高 CPU、磁盘、网络和模型归类负载。

移动目录时必须复制整个解压文件夹。源码入口和便携包入口均只负责调用同一个 `sync-local-windows-core.ps1`，配对、安全窗口、危险操作确认和安装逻辑不会维护两份；打包 agent/后台脚本仍需与入口同目录，单独复制 `.bat` 不能工作。

## 3. 默认安全限制

Windows 包装脚本默认：

| 限制 | 默认值 |
| --- | --- |
| 最近历史 | 14 天 |
| 文件数 | 60 |
| 单文件 | 50 MiB |
| 单会话消息 | 12,000 |
| 文件间隔 | 750 ms |

底层 CLI 自身默认最多 500 文件，但 Windows 包装器始终显式传 60，因此便携包实际以 60 为准。单个解压后的 transcript 还有 200 MiB 内部上限。文件必须是普通文件，符号链接会拒绝。

同步按 mtime/size/state 识别增量；JSONL 追加优先上传 append，改写或基线不一致时转完整快照。扫描期间的新变化会合并到下一轮，不会丢失已排队扫描。

## 4. 默认路径

| 内容 | 路径 |
| --- | --- |
| 服务端 | `https://ai-archive.gyee.tech:18443` |
| Codex | `%USERPROFILE%\.codex` |
| OpenClaw | `%USERPROFILE%\.openclaw` |
| Claude Code | `%USERPROFILE%\.claude`（存在时） |
| 配置 | `%USERPROFILE%\.config\ai-archive\openclaw-sync.json` |
| 状态 | 同目录 `openclaw-sync-state.json` |

监听补扫周期写在配置中，默认 60 秒，允许 15–3600 秒；包装器没有独立 UI 修改它。

## 5. 环境变量覆盖

在同一个 cmd 窗口设置后运行脚本：

```bat
set AI_ARCHIVE_SERVER=https://your-archive.example.com:18443
set AI_ARCHIVE_CODEX_ROOT=D:\path\to\.codex
set AI_ARCHIVE_OPENCLAW_ROOT=D:\path\to\.openclaw
set AI_ARCHIVE_CLAUDE_CODE_ROOT=D:\path\to\.claude
set AI_ARCHIVE_SYNC_CONFIG=D:\private\openclaw-sync.json
sync-local-windows.bat rebuild-only
```

安全窗口可用以下变量调整：

```bat
set AI_ARCHIVE_SAFE_RECENT_DAYS=30
set AI_ARCHIVE_SAFE_MAX_FILES=100
set AI_ARCHIVE_SAFE_MAX_FILE_MB=50
set AI_ARCHIVE_SAFE_MAX_MESSAGES=12000
set AI_ARCHIVE_SYNC_DELAY_MS=750
```

非本机服务器必须 HTTPS；只有 `localhost`、`127.0.0.1`、`::1` 可使用 HTTP。局域网 IP 的明文 HTTP 会被拒绝。

## 6. 重新配对与状态重建

设备在 Web 被撤销后，代理把401识别为`AUTH_REVOKED`并停止网络重试；撤销不能恢复。停止计划任务后删除配置，再运行脚本领取新 Token：

```powershell
& .\sync-local-windows.bat uninstall
Remove-Item -LiteralPath "$env:USERPROFILE\.config\ai-archive\openclaw-sync.json"
& .\sync-local-windows.bat
```

通常升级代理不需要删除配置。若需要重新扫描文件但保留设备 Token，可先备份后删除 `openclaw-sync-state.json`，或直接使用底层 CLI 的 `--reset-state`；这会增加重新上传量，但服务端 snapshotHash 仍做幂等。

## 7. 排错

- `node` 找不到或版本为奇数 Current：安装 Node.js 22/24 LTS 并打开新终端。
- 配对失败：确认配对码未过期、kind 匹配、服务地址正确、系统时间正常。
- 计划任务未运行：查看任务计划程序和日志目录，重新执行 `install`。
- 某文件被跳过：检查 14 天/60 文件/50 MiB/12,000 消息限制；只在确认负载后用 full-rebuild。
- 会话缺后续答案：先升级代理并运行 `rebuild-only`；不要删除服务端旧 Revision。
- 401：设备撤销或 Token/服务器不匹配，重新配对。
- 409 incremental base mismatch：代理应自动回退完整快照；持续出现时检查状态文件和服务日志。
- 网络/5xx：代理从5秒指数退避，最高15分钟、最多6次；429遵循`Retry-After`；其他验证类4xx不无限重试。
- Web设备状态长期不更新：检查heartbeat请求；正常时会回传V2.3.0、Windows、最近扫描/成功同步/错误和跟踪/跳过文件数。

发布包由仓库根目录 `pnpm package:windows-sync` 生成，默认输出 `release/ai-conversation-archive-windows-sync-V2.3.0.zip`，并复用同一core脚本。
