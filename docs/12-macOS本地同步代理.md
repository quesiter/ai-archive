# 知言归藏 macOS 本地同步代理

> 同步日期：2026-08-28。当前代理版本 `V2.3.0`，支持 Intel 与 Apple Silicon，要求 Node.js 22 或 24 LTS。代理只读 OpenClaw、Codex、Claude Code 会话，不读取模型密钥、Cookie 或 credential 文件。

| 文档属性 | 内容 |
| --- | --- |
| 文档类型 | macOS 客户端安装与运行手册 |
| 配置项标识 | `DOC-MAC-AGENT-V2.3` |
| 状态 | 发布基线 |

## 1. 首次使用

1. 在 Web“设备”页生成“OpenClaw/Codex 同步代理”配对码。
2. 把 `ai-conversation-archive-macos-sync-V2.3.0.tar.gz` 复制到 Mac 并解压。
3. 保持 `AI-Archive-Sync.command` 与 `openclaw-sync.cjs` 在同一目录。
4. 双击 `AI-Archive-Sync.command`，输入配对码。
5. 配对成功后输入 `Y` 安装当前用户 LaunchAgent。

安装后每次登录自动后台运行，不需要保留 Terminal。配置和状态默认位于：

```text
~/.config/ai-archive/openclaw-sync.json
~/.config/ai-archive/openclaw-sync-state.json
```

文件包含设备 Token 和增量位置，程序以 0700 目录、0600 文件和原子 rename 保存；不要公开分享。

## 2. 菜单、命令与日志

再次双击入口可以安装/重启后台、前台运行、导入近期历史或卸载。命令行：

```sh
./AI-Archive-Sync.command install
./AI-Archive-Sync.command uninstall
./AI-Archive-Sync.command run
./AI-Archive-Sync.command rebuild
```

别名：`background`/`install-background`、`uninstall-background`、`watch`、`once`/`rebuild-only`。

注意：wrapper 的 `run` 会先做一次安全窗口扫描再持续监听；它不是 Windows `watch-only` 的完全等价命令。

后台 Label 为 `com.ai-archive.openclaw-sync`，plist 在 `~/Library/LaunchAgents`。日志：

```text
~/Library/Logs/AIArchive/openclaw-sync.log
~/Library/Logs/AIArchive/openclaw-sync.error.log
```

`uninstall` 只移除 LaunchAgent 和 plist，不删除配对配置或状态。

## 3. 默认安全限制

macOS 包装脚本显式使用：

| 限制 | 默认值 |
| --- | --- |
| 最近历史 | 14 天 |
| 文件数 | 60 |
| 单文件 | 50 MiB |
| 单会话消息 | 12,000 |
| 文件间隔 | 750 ms |

底层 CLI 默认文件数为 500，但 wrapper 传入 60，因此便携包实际为 60。transcript 必须是普通文件，符号链接拒绝；单个解压后的 transcript 还有 200 MiB 内部上限。

补同步最近 30 天：

```sh
AI_ARCHIVE_SAFE_RECENT_DAYS=30 ./AI-Archive-Sync.command rebuild
```

完整历史并不是 wrapper 的公开命令。确认负载后可直接调用同目录 agent：

```sh
node ./openclaw-sync.cjs full-rebuild --delay-ms 750
```

这会包含大文件并取消近期/文件数/消息数安全窗口，可能产生很高负载。

## 4. 默认路径

| 内容 | 路径 |
| --- | --- |
| Codex | `$HOME/.codex` |
| OpenClaw | `$HOME/.openclaw` |
| Claude Code | `$HOME/.claude`（目录存在时自动加入） |
| 服务端 | `https://ai-archive.gyee.tech:18443` |
| 配置 | `$HOME/.config/ai-archive/openclaw-sync.json` |
| 状态 | 同目录 `openclaw-sync-state.json` |

配置中的 `scanSeconds` 默认 60，允许 15–3600。LaunchAgent 的 KeepAlive 为 true，异常退出后系统会重新拉起。

## 5. 路径、服务器和限制覆盖

首次配对前使用环境变量：

```sh
AI_ARCHIVE_SERVER="https://your-archive.example.com:18443" \
AI_ARCHIVE_CODEX_ROOT="/path/to/.codex" \
AI_ARCHIVE_OPENCLAW_ROOT="/path/to/.openclaw" \
AI_ARCHIVE_CLAUDE_CODE_ROOT="/path/to/.claude" \
AI_ARCHIVE_SYNC_CONFIG="$HOME/.config/ai-archive/openclaw-sync.json" \
./AI-Archive-Sync.command install
```

安全窗口变量：

```sh
AI_ARCHIVE_SAFE_RECENT_DAYS=30 \
AI_ARCHIVE_SAFE_MAX_FILES=100 \
AI_ARCHIVE_SAFE_MAX_FILE_MB=50 \
AI_ARCHIVE_SAFE_MAX_MESSAGES=12000 \
AI_ARCHIVE_SYNC_DELAY_MS=750 \
./AI-Archive-Sync.command rebuild
```

这些变量在安装 LaunchAgent 时被展开为 ProgramArguments；后续改变 shell 环境不会自动修改已安装 plist，需要重新执行 `install`。

远程服务器必须 HTTPS。只有 `localhost`、`127.0.0.1` 或 `::1` 可 HTTP；局域网 IP 明文 HTTP 被拒绝。

## 6. 重新配对与重建状态

Web 撤销设备后上传返回401，代理识别为`AUTH_REVOKED`并停止网络重试；撤销不能恢复。先卸载LaunchAgent，再删除配置并重新运行：

```sh
./AI-Archive-Sync.command uninstall
rm -f "$HOME/.config/ai-archive/openclaw-sync.json"
./AI-Archive-Sync.command
```

升级代理通常复用现有配置。需要从头重扫但保留 Token 时，可备份后删除 `openclaw-sync-state.json`，或直接给底层 agent 使用 `--reset-state`；服务端仍按 snapshotHash 去重。

## 7. 打包与完整性

发布包必须通过仓库脚本生成：

```sh
python scripts/package-macos-sync.py
python scripts/package-macos-sync.py --verify release/ai-conversation-archive-macos-sync-V2.3.0.tar.gz
```

脚本校验目录结构、入口 shebang、LF 换行，并固定入口 0755、其他文件 0644。若双击只显示 `bad interpreter`，脚本未启动，也不会同步；重新用官方打包脚本生成或检查换行/执行权限。

## 8. 排错

- `Node.js was not found`：安装 Node.js 22/24 LTS，确认 GUI 启动的 shell 能找到 `node`。
- `Missing sync agent`：入口和 `openclaw-sync.cjs` 不在同一解压目录。
- 配对失败：检查 10 分钟有效期、kind、HTTPS 服务地址和系统时间。
- LaunchAgent 不运行：检查 plist、`launchctl print gui/$(id -u)/com.ai-archive.openclaw-sync` 和错误日志。
- 文件被跳过：检查 14 天/60 文件/50 MiB/12,000 消息限制。
- 401：设备已撤销或配置与服务器不匹配，重新配对。
- 后续答案缺失：升级代理，运行 `rebuild`，保留服务端旧 Revision。
- 网络/5xx：代理从5秒指数退避，最高15分钟、最多6次；429遵循`Retry-After`；其他验证类4xx不无限重试。
- Web设备状态长期不更新：检查heartbeat；正常时会回传V2.3.0、macOS、最近扫描/成功同步/错误和跟踪/跳过文件数。
