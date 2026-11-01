# 知言归藏 macOS 本地同步代理

> 同步日期：2026-10-25。当前代理版本 `V2.4.7`，支持 Intel 与 Apple Silicon，要求 Node.js 22 或 24 LTS。代理只读 OpenClaw、Codex、Claude Code 会话，不读取模型密钥、Cookie 或 credential 文件。

| 文档属性 | 内容 |
| --- | --- |
| 文档类型 | macOS 客户端安装与运行手册 |
| 配置项标识 | `DOC-MAC-AGENT-V2.3` |
| 状态 | 发布基线 |

## 1. 首次使用

1. 在 Web“设备”页生成“OpenClaw/Codex 同步代理”配对码。
2. 把 `ai-conversation-archive-macos-sync-V2.4.7.tar.gz` 复制到 Mac 并解压。
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

再次双击入口可以安装/重启后台、前台运行、导入近期历史、卸载或选择 `5` 重新配对。命令行：

```sh
./AI-Archive-Sync.command install
./AI-Archive-Sync.command uninstall
./AI-Archive-Sync.command run
./AI-Archive-Sync.command rebuild
./AI-Archive-Sync.command pair
```

别名：`background`/`install-background`、`uninstall-background`、`watch`、`once`/`rebuild-only`、`re-pair`/`repair`。

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

V2.3.3 的 Codex 历史父子关系补齐无需完整正文重建。先升级服务端和代理，再运行 `./AI-Archive-Sync.command rebuild`，或等待后台下一次扫描。代理额外只读 `sessions`、`archived_sessions` 下全部 JSONL 的初始 `session_meta` 头部，按原始子代理来源与父 ID 回填已有归档，不受正文年龄、文件数量或文件大小窗口限制；无需扩大窗口或删除配置、状态。

该步骤只上传父子关系，不上传历史正文，不创建未归档会话或复活已删除记录。消息、Revision 与 Session ID 保持独立；主列表、项目时间线、首页/项目会话数和待归类使用统一主入口。相同标题、相同目录以及用户主动 fork 的会话不会因此合并。

日志中的 `Codex history lineage: checked ... files without age/size/count limits` 表示全历史头部扫描完成，并列出 updated/unchanged/not archived 数量。全扫描与上传成功才写完成标记；冲突、头部错误或上传失败会留下未完成状态供后续扫描重试。每台保存 Codex 历史的设备均需更新代理，服务端升级本身无法读取 Mac 上的历史日志。

## 4. 默认路径

| 内容 | 路径 |
| --- | --- |
| Codex | `$HOME/.codex` |
| OpenClaw | `$HOME/.openclaw` |
| Claude Code | `$HOME/.claude`（目录存在时自动加入） |
| 服务端 | `https://ai-archive.gyee.tech:18443` |
| 配置 | `$HOME/.config/ai-archive/openclaw-sync.json` |
| 状态 | 同目录 `openclaw-sync-state.json` |

配置中的 `scanSeconds` 默认 60，允许 15–3600。LaunchAgent 在异常退出后由系统重新拉起；授权失效时会停止，等待重新配对，避免反复请求无效凭据。升级后重新执行 `install` 或 `pair`，使现有 LaunchAgent 使用此策略。

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

上传、设备心跳或历史父子关系接口返回 401 时，代理识别为 `AUTH_REVOKED`，停止本次同步和后续监听，并显示重新配对提示。终端中仍有旧版本代理运行时，先按 `Ctrl+C` 停止它。

在 Web“设备”页生成新的“OpenClaw/Codex 同步代理”配对码（不要选择 Chrome 扩展类型），然后使用新版启动器的菜单 `5`，或运行：

```sh
./AI-Archive-Sync.command pair
```

重新配对会保留现有服务器、采集目录、扫描间隔、其他配置字段及同步状态，仅替换设备凭据；显式设置 `AI_ARCHIVE_SERVER` 时使用指定服务器。已有后台服务会先停止，配对成功后重启，并保留已安装任务的同步窗口和限制；显式设置安全窗口环境变量时使用指定值。配对失败时保留原配置和进度，后台保持停止。未安装后台服务时，配对后选择菜单 `1` 安装后台同步，或选择菜单 `2` 前台同步。

底层 CLI 也支持 `node ./openclaw-sync.cjs pair --preserve-config --code 新配对码`。前台同步遇到授权失效退出码为 `3`；LaunchAgent 使用专用参数将授权失效作为正常停止，避免系统立即重启它。

升级代理通常复用现有配置。重新配对无需删除任何配置或状态文件。需要从头重扫但保留 Token 时，可备份后删除 `openclaw-sync-state.json`，或直接给底层 agent 使用 `--reset-state`；服务端仍按 snapshotHash 去重。

## 7. 打包与完整性

发布包必须通过仓库脚本生成：

```sh
python scripts/package-macos-sync.py
python scripts/package-macos-sync.py --verify release/ai-conversation-archive-macos-sync-V2.4.7.tar.gz
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
- Web设备状态长期不更新：检查heartbeat；正常时会回传V2.4.7、macOS、最近扫描/成功同步/错误和跟踪/跳过文件数。

## Grok Build CLI 与 Desktop 采集

新版启动器会在启动时探测 `~/.grok`（Windows 为 `%USERPROFILE%\.grok`），也支持 `GROK_HOME` 或 `AI_ARCHIVE_GROK_BUILD_ROOT` 指定 Grok 根目录；重启后台同步即可让现有配对配置生效，无需重新配对。Windows 前台和计划任务、macOS 前台和 LaunchAgent 均支持该目录。

直接使用底层 CLI 时，在配置文件添加 `grokBuildRoots` 数组，元素为 Grok 根目录（包含 `sessions` 子目录），或在首次配对时附加 `--with-grok-build` / `--grok-build-root 路径`。多个目录可以配置在同一数组中。

采集源为 `sessions/<编码项目目录>/<会话ID>/updates.jsonl`。CLI 与使用相同 Grok runtime 的 Grok Build Desktop 共用 `grok_build` 来源和会话ID，同一会话不会因界面不同重复归档。支持文本流拼接、思考文本、工具状态及显示日志中的回退标记；流式尾部变化会重组快照，避免把单个 token chunk 当成独立消息。损坏或不支持的事件会标记为部分采集。

代理不读取 `auth.json`，不采集 `chat_history.jsonl` 中的系统上下文或加密思考内容，不把上下文大小当成实际 Token 用量。工具只保存简短状态及最多 600 字符可读输出；原始工具输入不入库。仅写入私有格式而没有 Grok ACP 日志的第三方桌面客户端不在此适配范围内。

格式依据：[Grok 官方会话管理](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)；Desktop 采用相同 ACP runtime 的示例：[Grok Build Desktop](https://github.com/phuryn/grok-build-vscode/blob/main/docs/desktop.md)。
