# 安全策略

这是仓库根目录 [SECURITY.md](../SECURITY.md) 的包内镜像版本，方便安装 VSIX 后直接点击阅读。

## 支持范围

当前项目处于 `0.0.x` 早期版本，默认只承诺维护主分支和最新打包版本。

## 报告安全问题

如果你发现以下问题，请优先私下联系维护者：

- API 密钥、令牌或本地凭据泄露
- 任务派发导致非预期命令执行
- VSIX 打包内容包含不应发布的文件
- Webview 中可被外部输入触发的脚本注入
- MCP 客户端、固定 API 工具桥或命令行执行器存在权限边界绕过

## 密钥处理原则

- 中继服务令牌通过 `OrchDev AI：设置中继服务令牌` 保存到 VS Code 系统密钥存储。
- 固定 API 密钥通过 `OrchDev AI：设置固定 API 密钥` 保存到 VS Code 系统密钥存储。
- 不要把密钥写入 `settings.json`、源码、README、测试快照、issue 或 PR 讨论。

## 工作区工具边界

- 默认拒绝访问 `.env`、`.git`、`node_modules`、构建缓存和常见密钥/证书文件。
- `Ask` / `Plan` 模式只暴露只读工具；`Execute` 模式才允许写文件。
- 本地命令执行默认关闭，只有显式开启 `allowCommandExecution` 才会暴露命令工具。

## 本地安装建议

安装本地 VSIX 前建议运行：

```bash
npm audit
npm run verify
npm run vsix
```

如果需要更完整的说明，请回到仓库根目录查看 [SECURITY.md](../SECURITY.md)。
