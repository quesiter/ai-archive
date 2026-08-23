# 知言归藏 V2.1 文档索引

本文档集以当前 V2.1.2 服务端与 Web 源码、migration 0012、API、测试和 Compose 配置为准，只描述已经实现的能力。历史行为只在 CHANGELOG 中保留。

## 文档

| 文档 | 内容 |
| --- | --- |
| REQUIREMENTS.md | 当前产品边界、功能与验收要求 |
| SYSTEM-DESIGN.md | 组件、数据流、整理、搜索、时间线、报告和安全设计 |
| UI-DESIGN.md | Web 信息架构、页面与响应式行为 |
| DATA-MODEL.md | 当前表、关系、迁移与备份映射 |
| API.md | 当前 HTTP API |
| USER-GUIDE.md | 安装后的日常使用 |
| DEPLOYMENT.md | NAS、Web、插件和同步代理部署 |
| OPERATIONS.md | 升级、监控、备份、恢复与故障排查 |
| WINDOWS-SYNC.md | Windows 同步代理 |
| MACOS-SYNC.md | macOS 同步代理 |
| CHANGELOG.md | 各历史版本真实变更 |

## 当前组件版本

| 组件 | 版本 |
| --- | --- |
| 服务端与 Web | V2.1.2 |
| Chrome 插件 | V2.1.2 |
| Windows/macOS 同步代理 | V2.1.0 |
| 共享协议 | 2.1.0 |

## V2.1 核验重点

- 原始会话及 Revision 仍是事实来源。
- 一个会话只有一个主项目，可有多个标签。
- 项目锁与人工/锁定标签在自动整理中受保护。
- 搜索返回标题/正文命中原因，并定位 Revision 与消息。
- 项目时间线选择最新完整 Revision。
- PROJECT-CONTEXT.md 由用户按需生成。
- 周报/月报直接读取归档会话。
- Migration 0012 保留原业务数据并删除旧派生表。
- 新备份包含标签；旧 V2.0.2 备份可兼容恢复并给出 warning。
- 认证、脱敏、网络和容器安全基线不变。

## 发布核验命令

~~~powershell
pnpm typecheck
pnpm test
pnpm build
docker compose -f infra/docker-compose.yml config
~~~

数据库迁移由 app 启动时执行，也可使用 pnpm db:migrate 手动运行。生产升级前必须先做业务备份，并验证 /healthz 返回 V2.1.2。
