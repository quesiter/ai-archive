# Windows 本地同步代理

这个便携包用于把公司或其他 Windows 电脑上的本地 Codex、OpenClaw、Claude Code 会话同步到 AI Conversation Archive。

## 便携包使用

1. 在 Windows 电脑上安装 Node.js 22 或更新版本，并确认 `node` 在 `PATH` 中可用。
2. 解压 `ai-conversation-archive-windows-sync-V20260817.zip` 到任意目录，例如 `C:\AIArchiveSync`。
3. 在 Web 后台的设备页面生成 `OpenClaw/Codex 同步代理` 配对码。
4. 双击 `sync-local-windows.bat`，首次运行时输入配对码。
5. 脚本会自动安装并启动后台任务；以后不用再保留命令行窗口。

## 后台自启

安装后会创建当前用户的计划任务 `AI Archive Local Sync`，每次登录后隐藏运行同步代理。任务会复用 `%USERPROFILE%\.config\ai-archive\openclaw-sync.json`，因此升级同步包或重新安装计划任务不需要重新配对。

如果之后需要重新安装后台任务，可以双击运行：

```bat
sync-local-windows.bat install
```

如果确实需要前台观察同步日志，再运行：

```bat
sync-local-windows.bat watch-only
```

后台日志写入：

```text
%LOCALAPPDATA%\AIArchive\Sync\Logs
```

停止并移除后台任务：

```powershell
sync-local-windows.bat uninstall
```

移动到公司 Windows 电脑时，请复制解压后的整个文件夹；至少要保证 `sync-local-windows.bat` 和 `openclaw-sync.cjs` 放在同一个目录。单独复制 `.bat` 文件无法运行，因为真正的同步程序在 `openclaw-sync.cjs` 里。

只导入近期历史、不持续监听时运行：

```bat
sync-local-windows.bat rebuild-only
```

默认安全限制为：最近 14 天、最多 60 个文件、单文件最多 50 MB、单会话最多 12000 条消息、每个文件之间等待 750 ms。这样可以避免一次性全量扫描整个 `.codex` 目录给公司电脑造成过高负载。

确实需要完整历史导入时，手动运行：

```bat
sync-local-windows.bat full-rebuild
```

如果只想监听之后的新变化，不做启动时扫描：

```bat
sync-local-windows.bat watch-only
```

## 默认路径

- 服务端：`https://ai-archive.gyee.tech:18443`
- Codex：`%USERPROFILE%\.codex`
- OpenClaw：`%USERPROFILE%\.openclaw`
- Claude Code：`%USERPROFILE%\.claude`
- 配对配置：`%USERPROFILE%\.config\ai-archive\openclaw-sync.json`

## 路径覆盖

如果公司电脑上的 Codex 数据不在默认路径，先在同一个命令行窗口设置环境变量：

```bat
set AI_ARCHIVE_CODEX_ROOT=D:\path\to\.codex
sync-local-windows.bat rebuild-only
```

如果服务端地址不同：

```bat
set AI_ARCHIVE_SERVER=https://your-archive.example.com:18443
sync-local-windows.bat
```

如果需要重新配对，删除：

```text
%USERPROFILE%\.config\ai-archive\openclaw-sync.json
```

然后重新运行 `sync-local-windows.bat`。
