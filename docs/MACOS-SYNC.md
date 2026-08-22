# 知言归藏 macOS 本地同步代理

这个便携包用于把 macOS 上的 Codex、OpenClaw、Claude Code 本地会话同步到“知言归藏”。Intel 芯片和 Apple Silicon 都可以使用，要求 Node.js 22 或更新版本。

## 首次使用

1. 在 Web 后台的设备页面生成 `OpenClaw/Codex 同步代理` 配对码。
2. 把 `ai-conversation-archive-macos-sync-V260822-4.tar.gz` 复制到 Mac。
3. 解压后双击 `AI-Archive-Sync.command`。
4. 输入配对码。
5. 配对成功后输入 `Y` 安装后台同步。

安装后会创建当前用户的 LaunchAgent。之后每次登录 macOS，系统会自动隐藏运行同步代理，不需要保留 Terminal 窗口。

后台日志写入：

```text
~/Library/Logs/AIArchive
```

再次双击 `AI-Archive-Sync.command` 可以重新安装、前台运行、导入近期历史或卸载后台同步。

`V260822-4` 会合并扫描期间发生的文件变化、稳定记录 Codex 后续修订，并兼容 JSONL 记录内部的独立回车空白。升级后可先选择近期历史重建，再重新安装 LaunchAgent；既有配对配置不需要删除。

## 默认路径

- Codex：`$HOME/.codex`
- OpenClaw：`$HOME/.openclaw`
- Claude Code：如果存在则读取 `$HOME/.claude`
- 配置：`$HOME/.config/ai-archive/openclaw-sync.json`
- 服务端：`https://ai-archive.gyee.tech:18443`

## 命令行入口

不想用菜单时，也可以在解压目录运行：

```sh
./AI-Archive-Sync.command install
./AI-Archive-Sync.command uninstall
./AI-Archive-Sync.command rebuild
./AI-Archive-Sync.command run
```

## 路径或服务器覆盖

```sh
AI_ARCHIVE_SERVER="http://你的NAS-IP:18080" ./AI-Archive-Sync.command
```

```sh
AI_ARCHIVE_CODEX_ROOT="/path/to/.codex" \
AI_ARCHIVE_OPENCLAW_ROOT="/path/to/.openclaw" \
AI_ARCHIVE_CLAUDE_CODE_ROOT="/path/to/.claude" \
./AI-Archive-Sync.command install
```

重新配对：

```sh
rm -f "$HOME/.config/ai-archive/openclaw-sync.json"
./AI-Archive-Sync.command
```
