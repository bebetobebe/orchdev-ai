# 发布检查清单

本清单用于“公开源码 + GitHub Release 下载 VSIX + 本地安装自用”的发布方式。每次改版本号、改固定 API、改打包内容或准备对外发 Release 前，都建议完整走一遍。

## 1. 代码与依赖

- [ ] `npm install` 成功。
- [ ] `npm audit` 已查看，确认没有必须立即处理的高风险漏洞。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run lint` 通过。
- [ ] `npm run test:unit` 通过。
- [ ] `npm run verify` 通过。

## 2. 固定 API 与密钥

- [ ] `src/config/fixedApiConfig.ts` 中的 `name`、`baseUrl`、`wireApi`、`model` 与本次发布一致。
- [ ] `baseUrl` 是可公开展示的服务地址，不包含密钥、签名或一次性 token。
- [ ] 如果服务需要密钥，`apiKeyOptional` 已按实际情况设置。
- [ ] 固定 API 密钥只通过 `OrchDev AI：设置固定 API 密钥` 写入 VS Code 系统密钥存储。
- [ ] `src/config/relayConfig.ts` 没有硬编码任何 API 密钥。
- [ ] 如果没有自己的中继服务，确认 `RELAY_CONFIG.enabled` 为 `false`。

## 3. 文档与公开信息

- [ ] `README.md` 和 `README.en.md` 都能说明项目用途、安装方式、固定 API、执行器能力和安全边界。
- [ ] README 下载链接指向 `https://github.com/bebetobebe/orchdev-ai`。
- [ ] `package.json` 的 `npm run vsix` 打包脚本里，`--baseContentUrl` 和 `--baseImagesUrl` 已替换为真实仓库地址。
- [ ] README 中的 VSIX 文件名与 `package.json` 版本一致。
- [ ] `CHANGELOG.md` 已记录本次版本的用户可见变化。
- [ ] `docs/OPEN_SOURCE_RELEASE.md`、`docs/ARCHITECTURE.md`、`docs/PROTOCOL.md` 没有过期描述。
- [ ] 文档里没有真实密钥、私有 URL、本机绝对路径或临时文件名。

## 4. VSIX 打包

- [ ] `npm run vsix` 成功。
- [ ] 输出文件名为 `orchdev-ai-版本号.vsix`。
- [ ] `.vscodeignore` 没有排除 `out/extension.js`、`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE`、`docs/`、`media/`。
- [ ] `.vscodeignore` 已排除 `src/`、`tests/`、`node_modules/`、`.git/`、旧 `.vsix`。
- [ ] 打包输出中没有源码、测试、依赖目录、私有配置或旧安装包。

## 5. 本地安装验收

- [ ] 生成的 `.vsix` 能在 VS Code 中安装。
- [ ] 生成的 `.vsix` 能在 Windsurf 中安装。
- [ ] 命令面板可找到 `OrchDev AI：打开编排面板`。
- [ ] 主面板能打开，按钮、状态卡片、任务输入区和执行器列表显示正常。
- [ ] 点击 `启用固定 API` 后可以注册固定 API 执行器。
- [ ] 点击 `测试固定 API 连接` 后能给出明确状态：通过、未确认工具调用或失败原因。
- [ ] 点击 `安全自检` 后能创建任务；启用真实可写执行器后，只写入 `.ai-orchestrator/self-check.md`。
- [ ] 任务结果中的“修改文件”可打开项目内文件，项目外路径会被拦截。
- [ ] 执行任务派发到不可写执行器时，界面会提示可能只能返回文字结果。

## 6. GitHub Release

- [ ] `package.json` 的 `version` 已更新。
- [ ] Tag 格式为 `v版本号`，例如 `v0.0.3`。
- [ ] Release 标题与 Tag 一致。
- [ ] Release Notes 使用 `CHANGELOG.md` 对应版本内容。
- [ ] Release 附件只上传当前版本 `.vsix`。
- [ ] 发布后打开 README 的 Release 链接和直接下载链接验证可访问。

## 7. 仓库治理

- [ ] 已包含 `LICENSE`。
- [ ] 已包含 `CHANGELOG.md`。
- [ ] 已包含 `CONTRIBUTING.md`。
- [ ] 已包含 `SECURITY.md`。
- [ ] 已包含 issue 模板和 PR 模板。
- [ ] 如果已有公开仓库地址，已补齐 `package.json` 的 `repository`、`homepage`、`bugs`。
- [ ] 如果暂时只本地自用，保留 `publisher: orchdev-ai-local`。
