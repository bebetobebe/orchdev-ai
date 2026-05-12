# 开源发布说明

本文档面向当前维护方式：公开源码，自己打包 `.vsix` 使用，暂不发布到 VS Code 扩展商店。VS Code 与 Windsurf 都可以通过本地 VSIX 安装。

## 发布定位

- 源码公开：仓库包含 TypeScript 源码、测试、文档、许可证和发布说明。
- 安装包自取：通过 GitHub Release 上传 `.vsix`，用户从 Release 页面下载安装。
- 密钥不入仓：固定 API 密钥、中继令牌和上游模型凭据只进入 VS Code 系统密钥存储。
- 默认本地优先：内置中继默认关闭，固定 API 默认指向 `MintAPI` + `gpt-5.5` + Responses API。

## 下载链接策略

README 中保留两类链接：

```text
https://github.com/bebetobebe/orchdev-ai/releases/latest
https://github.com/bebetobebe/orchdev-ai/releases/latest/download/orchdev-ai-0.0.1.vsix
```

发版时需要确认：

- `0.0.1`：每次发版时与 `package.json` 的 `version` 保持一致。
- Release 附件名：建议固定为 `orchdev-ai-版本号.vsix`，不要混用中文文件名和临时文件名。
- `package.json` 里的 `npm run vsix` 打包脚本，`--baseContentUrl` 和 `--baseImagesUrl` 要指向真实仓库。

如果暂时不发 GitHub Release，也可以只保留“从源码打包”说明，并把本地 `.vsix` 私下安装使用。

## 发版流程

1. 安装依赖：

```bash
npm install
```

2. 运行完整校验：

```bash
npm run verify
```

3. 打包 VSIX：

```bash
npm run vsix
```

4. 本地安装验证：

```bash
code --install-extension orchdev-ai-0.0.1.vsix
```

5. 在 VS Code 或 Windsurf 中打开命令面板，运行：

```text
OrchDev AI：打开编排面板
OrchDev AI：启用固定 API
OrchDev AI：测试固定 API 连接
OrchDev AI：创建安全自检任务
```

6. 创建 GitHub Release：

- Tag：`v0.0.1`
- Title：`v0.0.1`
- 附件：`orchdev-ai-0.0.1.vsix`
- Release Notes：使用 `CHANGELOG.md` 中对应版本内容。

7. 发布后回看 README 链接，确认 Release 页面和直接下载地址都能打开。

## 仓库字段

公开仓库地址确定后，建议补齐 `package.json`：

```jsonc
"repository": {
  "type": "git",
  "url": "https://github.com/bebetobebe/orchdev-ai.git"
},
"homepage": "https://github.com/bebetobebe/orchdev-ai#readme",
"bugs": {
  "url": "https://github.com/bebetobebe/orchdev-ai/issues"
}
```

没有公开仓库地址前，不要编造这些字段。当前 `npm run vsix` 使用 `--allow-missing-repository`，可以在本地正常打包。

## VSIX 内容边界

当前 `.vscodeignore` 会排除：

- `src/`、`tests/` 等开发输入。
- `node_modules/`、`scripts/`、sourcemap 和编辑器缓存。
- `.git/`、`.github/`、旧 `.vsix`、本地 Windsurf 配置。

安装包应保留：

- `out/extension.js`
- `package.json`
- `README.md`
- `README.en.md`
- `CHANGELOG.md`
- `LICENSE`
- `THIRD_PARTY_NOTICES.md`
- `docs/`
- `media/`

每次调整 `.vscodeignore` 后都要重新运行 `npm run vsix` 并安装验证。

## 发布前不要做的事

- 不要提交真实 API Key、Bearer Token、私有中继地址或本机绝对路径。
- 不要把 `node_modules/`、`out/`、`.vsix` 当成源码提交。
- 不要把本地测试截图、临时压缩包、旧安装包放进 Release 附件。
- 不要承诺“自动完成所有代码开发”。扩展能调度执行器，真实开发能力仍取决于启用的固定 API、CLI 或 MCP 服务。

## 已知边界

- 固定 API 已支持 Responses API、工具调用和工作区读写，但不同网关对工具调用的兼容性仍可能不同。
- 命令行执行器能否读写项目，取决于对应 CLI 的登录状态、模型、沙箱和命令行参数。
- 扩展没有实现 Windsurf/Cascade 私有工具协议；Windsurf 中的能力通过 VSIX、命令行执行器、MCP 客户端和工作区工具桥提供。
- `@modelcontextprotocol/sdk` 可能带入上游依赖，`npm audit` 结果会随依赖更新变化。
