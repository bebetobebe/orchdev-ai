# 中断识别与恢复

调度器会把执行器抛出的错误统一归类，并在任务卡片中显示中文恢复建议。部分临时性错误会自动延迟重试；需要人工处理的错误只提示，不会盲目循环。

## 分类

| 类型 | 常见信号 | 默认处理 |
| --- | --- | --- |
| 额度已用完 | `quota exhausted`、`insufficient_quota` | 不自动重试，提示切换账号、模型或 API Key |
| 请求过快 | `resource_exhausted`、`rate limit`、`429` | 延迟自动重试 |
| 回复被截断 | `cut short`、`finish_reason: length` | 提示继续上一段回复或拆小任务 |
| 工具调用达到上限 | `tool call limit`、`invocation limit` | 提示拆分任务或提高工具轮次 |
| 命令执行卡住 | `command timed out`、终端卡住 | 提示检查终端、取消或重派 |
| 需要授权 | `401`、`403`、`invalid api key`、权限确认 | 提示检查密钥、登录状态或权限列表 |
| 网络连接异常 | `fetch failed`、`ECONNRESET`、`connection timeout` | 延迟自动重试 |
| 服务内部错误 | `internal error`、`500`、`502` | 延迟自动重试 |
| 模型服务过载 | `over capacity`、`503`、`529` | 延迟自动重试 |
| 版本过旧 | `version is out of date` | 不自动重试，提示更新工具 |

## 配置

```jsonc
"aiDevOrchestrator.recovery.autoRetry": true,
"aiDevOrchestrator.recovery.maxRetries": 3,
"aiDevOrchestrator.recovery.baseDelayMs": 10000,
"aiDevOrchestrator.recovery.maxDelayMs": 30000
```

自动重试采用递增等待，默认会在 10 到 30 秒之间退避。等待期间任务会显示为排队中，执行器会被释放去处理其他任务；到时间后如果执行器空闲就立即重试，否则进入该执行器队列。
