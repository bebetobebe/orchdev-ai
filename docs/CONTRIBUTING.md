# 贡献指南

这是仓库根目录 [CONTRIBUTING.md](../CONTRIBUTING.md) 的包内镜像版本，方便安装 VSIX 后直接点击阅读。

## 开发环境

- Node.js 18 或更高版本
- VS Code 1.85 或更高版本
- npm 作为默认包管理器

## 常用命令

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run verify
npm run vsix
```

## 约定

- 用户可见文案默认使用中文。
- Codex、Claude Code、Gemini、Aider、OpenCode、MCP、API、VSIX 等专有名词保持原文。
- 不要提交真实 API 密钥、令牌、私有中继地址或本机绝对路径。
- 涉及调度、执行器、固定 API、MCP、密钥存储或打包规则的修改，请补充测试。

## 发布前建议

1. 跑 `npm audit`
2. 跑 `npm run verify`
3. 跑 `npm run vsix`
4. 用生成的 `.vsix` 在 VS Code 或 Windsurf 中安装验证

更完整的发布流程见 [发布检查清单](RELEASE_CHECKLIST.md)。
