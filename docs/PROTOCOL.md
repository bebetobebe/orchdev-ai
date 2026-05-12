# 协议与数据结构

本文档描述系统内部的核心数据结构，以当前源码实现为准。

## 1. 任务

```ts
interface Task {
  id: string;
  sessionId: string;
  prompt: string;
  mode: 'Ask' | 'Plan' | 'Execute';
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  workerId?: string;
  createdAt: number;
  completedAt?: number;
  result?: TaskResult;
  streamingOutput?: string;
  recovery?: TaskRecovery;
}
```

含义：

- `prompt`：任务描述。
- `mode`：任务意图，分别表示提问、规划、执行。
- `status`：任务生命周期状态。
- `streamingOutput`：执行中产生的实时输出。
- `recovery`：调度器识别到中断后生成的恢复提示，可用于展示自动重试或人工处理建议。

## 2. 任务结果

```ts
interface TaskResult {
  summary: string;
  artifacts: Artifact[];
  logs: string[];
  modifiedFiles?: string[];
  recovery?: TaskRecovery;
}
```

含义：

- `summary`：给界面展示的结果摘要。
- `artifacts`：提取出的结构化产物，例如代码片段或 diff。
- `logs`：原始日志或详细输出。
- `modifiedFiles`：已知被修改的工作区文件列表，用于任务结果里的“修改文件”入口。
- `recovery`：如果任务失败或等待自动重试，这里会包含恢复提示。

## 3. 恢复提示

```ts
type InterruptionType =
  | 'quota-exhausted'
  | 'rate-limited'
  | 'response-truncated'
  | 'tool-limit'
  | 'terminal-stuck'
  | 'authorization-required'
  | 'network'
  | 'internal'
  | 'provider-overloaded'
  | 'version-outdated'
  | 'unknown';

interface TaskRecovery {
  type: InterruptionType;
  title: string;
  message: string;
  action: string;
  retryable: boolean;
  autoRetry: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  nextRetryAt?: number;
}
```

含义：

- `type`：中断分类。
- `title` / `message` / `action`：面向用户展示的中文恢复说明。
- `retryable`：是否可以在处理后重试。
- `autoRetry`：当前是否已经安排自动重试。
- `attempt` / `maxAttempts`：自动重试进度。
- `delayMs` / `nextRetryAt`：本次自动重试等待时间与目标时间。

## 4. 产物

```ts
interface Artifact {
  type: 'file' | 'snippet';
  name: string;
  content: string;
}
```

## 5. 会话

```ts
interface Session {
  id: string;
  name: string;
  goal: string;
  createdAt: number;
  taskIds: string[];
  summary?: string;
}
```

## 6. 执行器能力标签

```ts
type WorkerCapabilityKind =
  | 'api-tools'
  | 'workspace-read'
  | 'workspace-write'
  | 'command-execution'
  | 'cli-project'
  | 'mcp-tool'
  | 'placeholder';

type WorkerCapabilityStatus = 'ready' | 'info' | 'warning' | 'disabled';

interface WorkerCapability {
  kind: WorkerCapabilityKind;
  label: string;
  status: WorkerCapabilityStatus;
  description?: string;
}
```

能力标签用于面板提示，不直接决定权限；真正的权限边界由执行器实现和工作区工具桥控制。

## 7. 执行器

```ts
interface Worker {
  id: string;
  name: string;
  type: 'mcp' | 'cli';
  status: 'available' | 'busy' | 'disconnected';
  capabilities?: WorkerCapability[];
}
```

其中：

- `mcp`：MCP 类型执行器。
- `cli`：命令行、固定 API 或 HTTP 接口型执行器在内部统一归到这一类。
- `capabilities`：给界面展示的能力提示，例如“可读项目”“执行可写”“仅文本响应”。

## 8. 固定 API 健康状态

```ts
type CustomApiHealthStatus = 'untested' | 'testing' | 'ok' | 'no-tools' | 'failed';

interface CustomApiHealthSnapshot {
  status: CustomApiHealthStatus;
  name: string;
  model?: string;
  message?: string;
  lastCheckedAt?: number;
}
```

说明：

- `ok`：基础连接和工具调用测试都通过。
- `no-tools`：基础连接通过，但当前未确认工具调用能力。
- `failed`：基础连接或工具调用测试失败。

## 9. 执行器适配接口

```ts
interface IWorkerAdapter {
  readonly worker: Worker;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  execute(task: Task, opts?: ExecuteOptions): Promise<TaskResult>;
  cancel?(taskId: string): boolean;
}
```

约定：

- `connect()` 负责建立可用状态。
- `disconnect()` 负责断开并清理运行中任务。
- `execute()` 负责把通用任务转成具体后端调用。
- `cancel()` 可选，用于中断运行中的任务。

## 10. 设计说明

- 文档中的结构描述用于帮助理解系统边界，不代表扩展对所有第三方 CLI、MCP 服务或网关做兼容承诺。
- Windsurf 兼容基于标准 VS Code 扩展机制与 VSIX 安装方式，不包含私有协议实现。
