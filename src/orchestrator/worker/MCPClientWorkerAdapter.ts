import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Artifact, IWorkerAdapter, Task, TaskResult, Worker } from '../../types';
import { extractArtifacts } from './outputParser';

/**
 * Configuration for a real Model Context Protocol worker. The adapter spawns
 * the configured MCP server over stdio and proxies each task to a single
 * `tools/call` invocation against the configured tool name.
 */
export interface MCPClientWorkerOptions {
    /** Executable used to start the MCP server (e.g. 'npx', '/usr/local/bin/my-mcp'). */
    command: string;
    /** Arguments passed to the server executable. */
    args?: string[];
    /** Extra env vars merged on top of the inherited environment. */
    env?: Record<string, string>;
    /** Working directory for the spawned MCP server. */
    cwd?: string;
    /** Name of the MCP tool to invoke for every task. */
    toolName: string;
    /** Argument name used to pass `task.prompt` to the tool (default 'prompt'). */
    promptArgName?: string;
    /** Identification advertised to the MCP server. */
    clientName?: string;
    clientVersion?: string;
}

interface MCPContentItem {
    type: string;
    text?: string;
}

/**
 * Real MCP client adapter. Unlike the legacy `MCPWorkerAdapter` (which shells
 * out to a fictional `mcp` CLI), this adapter speaks the Model Context Protocol
 * via the official `@modelcontextprotocol/sdk` and runs each task as a single
 * `tools/call` against the configured server.
 */
export class MCPClientWorkerAdapter implements IWorkerAdapter {
    readonly worker: Worker;
    private readonly _options: MCPClientWorkerOptions;
    private _client: Client | null = null;
    private readonly _pending = new Map<string, AbortController>();

    constructor(id: string, name: string, options: MCPClientWorkerOptions) {
        this._options = options;
        this.worker = { id, name, type: 'mcp', status: 'disconnected' };
    }

    async connect(): Promise<void> {
        try {
            const transport = this._createTransport();
            const client = this._createClient();
            await client.connect(transport);
            this._client = client;
            this.worker.status = 'available';
            console.log(`MCP 客户端 ${this.worker.name} 已连接到 ${this._options.command}。`);
        } catch (err) {
            this.worker.status = 'disconnected';
            console.error(`MCP 客户端 ${this.worker.name} 连接失败：`, err);
        }
    }

    async disconnect(): Promise<void> {
        for (const ctrl of this._pending.values()) {
            try { ctrl.abort(); } catch { /* noop */ }
        }
        this._pending.clear();
        if (this._client) {
            try {
                await this._client.close();
            } catch (err) {
                console.warn(`MCP 客户端 ${this.worker.name} 关闭失败：`, err);
            }
            this._client = null;
        }
        this.worker.status = 'disconnected';
    }

    async execute(task: Task): Promise<TaskResult> {
        if (!this._client) {
            throw new Error(`MCP 客户端 ${this.worker.name} 尚未连接。`);
        }
        const controller = new AbortController();
        this._pending.set(task.id, controller);
        const promptArg = this._options.promptArgName || 'prompt';
        try {
            const result = await this._client.callTool(
                {
                    name: this._options.toolName,
                    arguments: { [promptArg]: task.prompt },
                },
                undefined,
                { signal: controller.signal }
            );
            return this._formatResult(result);
        } finally {
            this._pending.delete(task.id);
        }
    }

    cancel(taskId: string): boolean {
        const ctrl = this._pending.get(taskId);
        if (!ctrl) return false;
        try { ctrl.abort(); } catch { /* noop */ }
        this._pending.delete(taskId);
        return true;
    }

    // === Internal helpers, exposed for tests ===

    /** Override point for tests to inject a fake transport. */
    protected _createTransport(): InstanceType<typeof StdioClientTransport> {
        return new StdioClientTransport({
            command: this._options.command,
            args: this._options.args,
            env: this._options.env,
            cwd: this._options.cwd,
        });
    }

    /** Override point for tests to inject a fake client. */
    protected _createClient(): Client {
        return new Client(
            {
                name: this._options.clientName || 'orchdev-ai',
                version: this._options.clientVersion || '0.0.1',
            },
            { capabilities: {} }
        );
    }

    private _formatResult(raw: unknown): TaskResult {
        const content: MCPContentItem[] = Array.isArray((raw as { content?: unknown })?.content)
            ? ((raw as { content: MCPContentItem[] }).content)
            : [];
        const textParts = content
            .filter(item => item && item.type === 'text' && typeof item.text === 'string')
            .map(item => item.text as string);
        const stdout = textParts.join('\n');
        const summary = textParts.length === 0
            ? `MCP 工具 ${this._options.toolName} 没有返回文本内容。`
            : this._truncate(textParts[textParts.length - 1]);
        const artifacts: Artifact[] = stdout ? extractArtifacts(stdout) : [];
        const logs = stdout ? stdout.split('\n').filter(Boolean) : [];
        return { summary, artifacts, logs };
    }

    private _truncate(text: string, max = 500): string {
        const trimmed = text.trim();
        if (trimmed.length <= max) return trimmed;
        return trimmed.substring(0, max) + '...';
    }
}
