# 文档索引

这里收集 OrchDev AI 的维护、发布、架构和安全说明。用户入口请优先阅读仓库根目录的 [README.md](../README.md)，英文用户入口见 [README.en.md](../README.en.md)。

## 交流

- QQ 群：`1058933735`

## 使用与发布

| 文档 | 内容 |
| --- | --- |
| [开源发布说明](OPEN_SOURCE_RELEASE.md) | 源码公开、本地 VSIX、GitHub Release 下载链接和发布流程 |
| [发布检查清单](RELEASE_CHECKLIST.md) | 发布前需要完成的验证、密钥、打包、安装和仓库检查 |
| [路线图](ROADMAP.md) | 已完成能力和后续方向 |
| [产品需求文档](PRD.md) | 项目目标、用户、问题和非目标 |

## 技术说明

| 文档 | 内容 |
| --- | --- |
| [架构说明](ARCHITECTURE.md) | 展示层、调度层、执行器适配层和工作区工具桥 |
| [协议与数据结构](PROTOCOL.md) | 任务、会话、执行器、恢复提示和适配器接口 |
| [中断识别与恢复](INTERRUPTION_RECOVERY.md) | 常见错误分类、中文恢复提示和自动重试策略 |

## 仓库治理

| 文档 | 内容 |
| --- | --- |
| [安全策略](SECURITY.md) | 密钥处理、工作区边界和安全问题报告方式 |
| [贡献指南](CONTRIBUTING.md) | 本地开发、验证命令和提交注意事项 |
| [第三方许可证](../THIRD_PARTY_NOTICES.md) | 运行时依赖和第三方声明 |

## 发布链接约定

README 中的下载链接默认使用：

```text
https://github.com/bebetobebe/orchdev-ai/releases/latest
https://github.com/bebetobebe/orchdev-ai/releases/latest/download/orchdev-ai-0.0.1.vsix
```

发布 `.vsix` 时，建议把文件名保持为 `orchdev-ai-版本号.vsix`，方便 README、Release Notes 和用户安装说明长期一致。
