# 知言归藏文档总览

> 汇智能之言，成项目之知。

本文档集以服务端、Web 和客户端 `V2.0.0` 的可执行代码、数据库迁移和部署配置为准，只描述已经实现的能力。规划设想不混入当前需求、API、界面或运维说明；历史行为仅保留在变更历史中。

## 文档入口

| 文档 | 读者与用途 | 事实来源 |
| --- | --- | --- |
| [项目需求文档](REQUIREMENTS.md) | 产品与研发；确认当前产品范围、验收口径和边界。 | Web/客户端行为、API、测试。 |
| [系统设计文档](SYSTEM-DESIGN.md) | 研发与维护者；理解模块、数据流、任务编排、AI 和安全设计。 | 服务端、Worker、客户端源码。 |
| [界面设计文档](UI-DESIGN.md) | 产品、设计与前端；核对 Web、扩展和同步客户端界面。 | `apps/web`、`apps/extension`、同步脚本。 |
| [数据库设计文档](DATA-MODEL.md) | 后端与 DBA；核对表、关系、约束、幂等和生命周期。 | `schema.ts` 与 `0000`—`0011` 迁移。 |
| [API 文档](API.md) | 前后端与集成方；调用当前已注册 HTTP 接口。 | `apps/server/src/routes`。 |
| [用户手册](USER-GUIDE.md) | 管理员；完成登录、采集、同步、归类、知识、报告与脱敏操作。 | 当前 Web 与客户端。 |
| [部署文档](DEPLOYMENT.md) | 部署人员；全新安装、反向代理、客户端发布和升级。 | Compose、Dockerfile、更新脚本。 |
| [运维手册](OPERATIONS.md) | 运维人员；监控、迁移、备份恢复、排障与发布检查。 | 运行配置、脚本和队列实现。 |
| [Windows 同步](WINDOWS-SYNC.md) | Windows 用户；安装便携同步包和后台计划任务。 | Windows 脚本。 |
| [macOS 同步](MACOS-SYNC.md) | macOS 用户；安装便携同步包和 LaunchAgent。 | macOS 脚本。 |
| [变更历史](CHANGELOG.md) | 所有人；追踪已发布版本变化。 | Git 历史与发布内容。 |

## 当前软件组成

| 组件 | 当前版本 | 说明 |
| --- | --- | --- |
| 服务端与 Web | `V2.0.0` | 单镜像部署；app 自动迁移并提供 API/Web，worker 执行异步任务，host-monitor 通过只读 cgroup 汇总项目容器指标。 |
| Chrome 插件 | `V2.0.0` | 网页会话轻量检测、完整/增量采集和本地上传队列。 |
| Windows/macOS 同步代理 | `V2.0.0` | OpenClaw、Codex、Claude Code 本地文件扫描、监听和同步。 |

在线网页采集支持 ChatGPT、Gemini、Grok、腾讯元宝、MiniMax Agent、DeepSeek、千问和 Kimi。本地同步支持 OpenClaw、Codex 和 Claude Code。历史 ZIP 导入支持 ChatGPT、Gemini Takeout 和 Chat Memo 已实现的平台格式。

核心归档、搜索、导出、历史导入、修订查看和备份恢复不依赖模型；项目归类、知识整理和报告需要配置 OpenAI 兼容模型。

## 文档维护规则

1. API 增删以路由注册为准，接口变更必须同步 `API.md`。
2. 表结构以迁移和 `schema.ts` 为准，不能只改 `DATA-MODEL.md`。
3. Web 或客户端增加页面、状态或操作时，同步 `UI-DESIGN.md` 和 `USER-GUIDE.md`。
4. 环境变量、端口、卷、升级或恢复方式变化时，同步部署与运维文档。
5. 未实现、实验性或仅有构想的内容不得写成当前能力。
