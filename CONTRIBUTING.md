# 贡献指南

感谢你愿意改进 OrchDev AI。这个项目当前以“开源仓库 + 本地 VSIX 自用”为主，优先保证三个目标：能构建、能安装、能回归验证。

## 先看什么

- 用户入口：[README.md](README.md)
- 英文入口：[README.en.md](README.en.md)
- 发布说明：[docs/OPEN_SOURCE_RELEASE.md](docs/OPEN_SOURCE_RELEASE.md)
- 发布清单：[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)
- 架构说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 开发环境

- Node.js 18 或更高版本
- VS Code 1.85 或更高版本
- npm 作为默认包管理器

初始化：

```bash
npm install
```

## 常用命令

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run verify
npm run vsix
```

说明：

- `npm run verify` 会执行生产构建、单元测试和 bundle 烟测。
- 涉及调度、执行器、固定 API、MCP、Webview、打包链路的修改，提交前建议至少跑一次 `npm run verify`。
- 涉及 VSIX 内容、README、命令注册或媒体资源的修改，建议额外跑一次 `npm run vsix`。

## 贡献约定

- 优先沿用现有目录结构、命名方式和中文界面文案风格。
- Codex、Claude Code、Gemini、Aider、OpenCode、MCP、API、VSIX 等专有名词保持原文。
- 不要把真实 API 密钥、令牌、私有中继地址、测试凭据或本机绝对路径提交到仓库。
- 修改用户可见行为时，优先同步更新 README、CHANGELOG 和相关文档。
- 修改核心逻辑时，请补充或更新测试，避免只改行为不补覆盖。
- 如果新增 VSIX 运行时所需文件，确认 `.vscodeignore` 没有把它们排除掉。

## 文档约定

- 用户入口文档默认维护中英文两份：`README.md` 与 `README.en.md`。
- 子文档可以中文为主，但术语要和 README 保持一致。
- 不要在文档中保留过期能力说明，例如已经下线的配置入口、旧命令名或旧协议描述。
- 对外下载地址统一使用 GitHub Release 风格，公开仓库前可保留 `YOUR_GITHUB_ACCOUNT` 占位。

## 提交建议

提交 Pull Request 前，建议至少确认：

1. 改动目标清晰，范围没有无关文件。
2. 命令、界面文案、文档和测试口径一致。
3. 没有引入真实密钥、临时构建物或本地调试残留。
4. 验证命令已跑过，或在 PR 描述中明确说明未验证部分。

PR 模板中建议写清楚：

- 改了什么
- 为什么改
- 怎么验证
- 是否影响 README、CHANGELOG、VSIX 打包或安全边界

## 发布前检查

完整流程见 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)。最小建议流程：

```bash
npm audit
npm run verify
npm run vsix
```

然后用生成的 `.vsix` 在 VS Code 或 Windsurf 中安装，至少走一遍“打开面板 -> 启用固定 API -> 测试固定 API -> 安全自检”。
