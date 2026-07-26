# 中文文档总览

本文档集记录 `AI Conversation Archive` 在 2026-07-26 当前代码状态下的功能、设计与运维方式。项目仍处于测试阶段，文档以当前实现为准，不把历史升级日志当作唯一入口。

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [需求文档](REQUIREMENTS.md) | 描述产品目标、用户角色、功能需求、非功能需求、验收标准和已知边界。 |
| [系统设计文档](SYSTEM-DESIGN.md) | 描述整体架构、采集链路、同步代理、AI 运行方式、队列、日志与安全设计。 |
| [数据模型文档](DATA-MODEL.md) | 描述 PostgreSQL 表结构、核心关系、幂等键、归档版本和分析数据的存储方式。 |
| [API 文档](API.md) | 描述 Web、设备、采集、导入、归类、报告、日志和设置接口。 |
| [用户手册](USER-GUIDE.md) | 面向日常使用，说明后台、Chrome 插件、本地同步代理、导入、分类和报告如何操作。 |
| [运维手册](OPERATIONS.md) | 面向部署维护，说明本地开发、NAS 部署、升级、备份恢复、日志排错和安全检查。 |
| [变更历史](CHANGELOG.md) | 合并原 `UPDATE-*.md` 的版本更新记录。 |

## 现有代码组成

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| 服务端 | `apps/server` | Fastify API、PostgreSQL/Drizzle、pg-boss 队列、Worker、历史导入、AI 分析、邮件发送。 |
| Web 后台 | `apps/web` | React 单用户管理后台，包含仪表盘、会话、项目、报告、导入、设备、日志和设置页面。 |
| Chrome 插件 | `apps/extension` | Manifest V3 插件，在支持的 AI 网页中自动识别会话 ID，先轻量判断变化，再按完整或增量模式归档。 |
| 本地同步代理 | `apps/openclaw-sync` | 读取本机 OpenClaw、Codex、Claude Code JSONL 会话文件，转换为统一采集协议并上传。 |
| 共享协议 | `packages/contracts` | 采集快照、消息、分段、设备配对、知识抽取等 Zod Schema 与 TypeScript 类型。 |
| 部署与脚本 | `deploy`、`scripts` | Docker Compose、备份、恢复、API 冒烟测试等脚本。 |

## 当前支持的平台

在线网页自动采集支持：ChatGPT、Gemini、Grok、腾讯元宝、MiniMax Agent、DeepSeek、千问、Kimi。

本地同步支持：OpenClaw、Codex、Claude Code。

核心归档、搜索、历史导入和修订查看不依赖 OpenAI 兼容模型配置；模型仅用于可选的智能归类、知识抽取、报告和后续个人分析。

历史导入支持：ChatGPT 导出 ZIP、Gemini Takeout ZIP。其他平台没有稳定官方批量历史 API，当前主要通过电脑浏览器逐个打开会话补录。

## 阅读建议

第一次部署或升级时，先读 [运维手册](OPERATIONS.md)。

要确认某个功能是否已经实现，先读 [需求文档](REQUIREMENTS.md) 和 [用户手册](USER-GUIDE.md)。

要排查采集、分类、报告失败，优先读 [系统设计文档](SYSTEM-DESIGN.md) 的运行链路和 [API 文档](API.md) 的状态接口，再去后台对应业务页面和“日志”页面查看具体记录。
