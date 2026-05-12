import { RELAY_CONFIG } from '../../config/relayConfig';
import { Artifact, ExecuteOptions, IWorkerAdapter, Task, TaskResult, Worker } from '../../types';
import { extractArtifacts } from './outputParser';
import {
    type WorkspaceToolExecutionResult,
    type WorkspaceToolMode,
    type WorkspaceToolRunner,
    WorkspaceToolBridge,
} from './workspaceToolBridge';

/**
 * Configuration for the OpenAI-compatible HTTP relay worker.
 */
export interface OpenAIRelayWorkerOptions {
    /** User-supplied auth token. Sent as `Authorization: Bearer <token>`. */
    authToken?: string;
    /** Override the default model from RELAY_CONFIG. */
    model?: string;
    /** Fallback model when `model` is not set. Defaults to RELAY_CONFIG.openaiDefaultModel. */
    defaultModel?: string;
    /** Optional system prompt to prepend to every request. */
    systemPrompt?: string;
    /** Override the relay base URL. Defaults to RELAY_CONFIG.openaiBaseUrl. */
    baseUrl?: string;
    /** HTTP API shape to call. Defaults to Chat Completions for broad compatibility. */
    wireApi?: 'chat_completions' | 'responses';
    /** Optional reasoning effort for Responses API models. */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    /** When true, send `store: false` on Responses API calls. */
    disableResponseStorage?: boolean;
    /**
     * Whether connect() should respect RELAY_CONFIG.enabled. The built-in
     * relay worker keeps the default `true`; user-configured third-party
     * OpenAI-compatible APIs pass `false` so they work independently.
     */
    requireRelayEnabled?: boolean;
    /** Per-request timeout in milliseconds. Defaults to 120s. */
    timeoutMs?: number;
    /** Optional fetch override for tests; defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
    /** Enable OpenAI tool-calling against local workspace tools. */
    enableWorkspaceTools?: boolean;
    /** Workspace root exposed to built-in tools. */
    workspaceRoot?: string;
    /** Allow write tools and command execution. Otherwise tools are read-only. */
    allowCommandExecution?: boolean;
    /** Optional tool runner override for tests. */
    workspaceToolRunner?: WorkspaceToolRunner;
    /** Max assistant/tool turns before aborting a tool-calling task. */
    maxToolIterations?: number;
}

/** Shape of one `data: {...}` line in an OpenAI SSE stream. */
interface ChatCompletionStreamChunk {
    choices?: Array<{
        delta?: { role?: string; content?: string | null };
        finish_reason?: string | null;
    }>;
    error?: { message?: string; type?: string };
}

interface ChatCompletionToolCall {
    id?: string;
    type?: string;
    function?: {
        name?: string;
        arguments?: unknown;
    };
}

interface ChatCompletionMessage {
    role?: string;
    content?: unknown;
    tool_calls?: ChatCompletionToolCall[];
    function_call?: {
        name?: string;
        arguments?: unknown;
    };
}

interface ChatCompletionResponse {
    choices?: Array<{
        message?: ChatCompletionMessage;
        finish_reason?: string | null;
    }>;
    error?: { message?: string; type?: string };
}

interface ResponsesApiOutputItem {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: unknown;
    role?: string;
    content?: Array<{
        type?: string;
        text?: string;
    }>;
}

interface ResponsesApiResponse {
    id?: string;
    output_text?: string;
    output?: ResponsesApiOutputItem[];
    error?: { message?: string; type?: string };
}

interface ResponsesToolCall {
    id: string;
    callId: string;
    name: string;
    arguments?: unknown;
    raw: ResponsesApiOutputItem;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOL_ITERATIONS = 12;
const SSE_TERMINATOR = '[DONE]';
type ToolProtocol = 'modern' | 'legacy';

/**
 * HTTP-based worker that calls a relay's OpenAI-compatible
 * `/v1/chat/completions` endpoint. It keeps streaming for plain chat and
 * switches to OpenAI tool-calling when workspace tools are enabled.
 */
export class OpenAIRelayWorkerAdapter implements IWorkerAdapter {
    readonly worker: Worker;
    private readonly _options: OpenAIRelayWorkerOptions;
    private readonly _pending = new Map<string, AbortController>();
    private readonly _workspaceTools?: WorkspaceToolRunner;

    constructor(id: string, name: string, options: OpenAIRelayWorkerOptions = {}) {
        this._options = options;
        this.worker = { id, name, type: 'cli', status: 'disconnected' };
        if (options.enableWorkspaceTools && options.workspaceRoot) {
            this._workspaceTools = options.workspaceToolRunner ?? new WorkspaceToolBridge({
                workspaceRoot: options.workspaceRoot,
                commandTimeoutMs: options.timeoutMs,
                allowCommandExecution: options.allowCommandExecution,
            });
        }
    }

    async connect(): Promise<void> {
        if (this._options.requireRelayEnabled !== false && !RELAY_CONFIG.enabled) {
            console.warn(`${this.worker.name}：中继服务已在 RELAY_CONFIG 中关闭，执行器保持断开。`);
            this.worker.status = 'disconnected';
            return;
        }
        if (!this._getBaseUrl()) {
            console.warn(`${this.worker.name}：中继服务基础地址为空，执行器保持断开。`);
            this.worker.status = 'disconnected';
            return;
        }
        this.worker.status = 'available';
        console.log(`${this.worker.name} 可用（中继服务：${this._getBaseUrl()}）。`);
    }

    async disconnect(): Promise<void> {
        for (const ctrl of this._pending.values()) {
            try { ctrl.abort(); } catch { /* noop */ }
        }
        this._pending.clear();
        this.worker.status = 'disconnected';
    }

    async execute(task: Task, opts?: ExecuteOptions): Promise<TaskResult> {
        if (this.worker.status === 'disconnected') {
            throw new Error(`${this.worker.name} 当前不可用。`);
        }
        const controller = new AbortController();
        this._pending.set(task.id, controller);
        const timeoutMs = this._options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
            try { controller.abort(); } catch { /* noop */ }
        }, timeoutMs);
        try {
            if (this._getWireApi() === 'responses') {
                return await this._executeWithResponsesApi(task, controller.signal, opts?.onProgress);
            }
            const url = this._joinUrl(this._getBaseUrl(), '/chat/completions');
            if (this._shouldUseWorkspaceTools()) {
                return await this._executeWithWorkspaceTools(url, task, controller.signal, opts?.onProgress);
            }
            const res = await this._postChatCompletion(url, {
                model: this._getModel(),
                messages: this._buildMessages(task),
                stream: true,
            }, controller.signal, true);
            const content = await this._consumeStream(res, opts?.onProgress);
            return this._formatStreamingResult(content);
        } finally {
            clearTimeout(timer);
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

    private _getBaseUrl(): string {
        const raw = this._options.baseUrl || RELAY_CONFIG.openaiBaseUrl;
        return raw.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/g, '');
    }

    private _getModel(): string {
        return this._options.model || this._options.defaultModel || RELAY_CONFIG.openaiDefaultModel;
    }

    private _getWireApi(): 'chat_completions' | 'responses' {
        return this._options.wireApi || 'chat_completions';
    }

    private _joinUrl(base: string, path: string): string {
        const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
        const trimmedPath = path.startsWith('/') ? path : '/' + path;
        return trimmedBase + trimmedPath;
    }

    private _buildMessages(task: Task): Array<Record<string, unknown>> {
        const messages: Array<Record<string, unknown>> = [];
        if (this._options.systemPrompt && this._options.systemPrompt.length > 0) {
            messages.push({ role: 'system', content: this._options.systemPrompt });
        }
        if (this._shouldUseWorkspaceTools()) {
            const modeInstruction = task.mode === 'Execute'
                ? '当前是执行模式：如果任务要求修改代码，必须调用工作区写入工具完成真实文件修改，不要只用文字描述改法；如果不能修改，请明确说明原因。'
                : '当前是只读模式：只能读取、搜索和分析项目文件，不要声称已经修改文件。';
            messages.push({
                role: 'system',
                content: [
                    '你可以调用工作区工具完成代码开发任务。',
                    '先读取和搜索必要文件，再做最小范围修改。',
                    modeInstruction,
                    '修改后给出中文总结，说明改了哪些文件、如何验证。',
                ].join('\n'),
            });
        }
        messages.push({ role: 'user', content: task.prompt });
        return messages;
    }

    private _shouldUseWorkspaceTools(): boolean {
        return Boolean(this._workspaceTools);
    }

    private _workspaceToolMode(task: Task): WorkspaceToolMode {
        return task.mode === 'Execute' ? 'write' : 'read';
    }

    private async _executeWithWorkspaceTools(
        url: string,
        task: Task,
        signal: AbortSignal,
        onProgress?: (chunk: { text: string }) => void,
    ): Promise<TaskResult> {
        const toolRunner = this._workspaceTools;
        if (!toolRunner) {
            throw new Error(`${this.worker.name}：未配置工作区工具。`);
        }

        const mode = this._workspaceToolMode(task);
        const tools = toolRunner.getDefinitions(mode);
        const messages = this._buildMessages(task);
        const logs: string[] = [];
        const artifacts: Artifact[] = [];
        const modifiedFiles = new Set<string>();
        const maxIterations = this._options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
        let protocol: ToolProtocol = 'modern';

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            const completion = await this._requestToolCompletion(url, {
                model: this._getModel(),
                messages,
                tools,
                signal,
                protocol,
            });
            protocol = completion.protocol;
            const payload = completion.payload;
            const message = payload.choices?.[0]?.message;
            if (!message) {
                throw new Error(`${this.worker.name}：工具调用响应缺少 message。`);
            }

            const content = this._messageContentToText(message.content);
            const extracted = this._extractToolCalls(message);
            const toolCalls = extracted.toolCalls;
            protocol = extracted.protocol;
            messages.push(this._assistantToolMessage(content, toolCalls, protocol));

            if (content.trim()) {
                logs.push(content.trim());
                if (onProgress) {
                    try { onProgress({ text: content }); } catch { /* noop */ }
                }
            }

            if (toolCalls.length === 0) {
                artifacts.push(...extractArtifacts(content));
                return this._formatToolResult(content, logs, artifacts, modifiedFiles);
            }

            for (const toolCall of toolCalls) {
                const toolResult = await this._executeToolCall(toolRunner, toolCall, mode);
                logs.push(...toolResult.logs);
                artifacts.push(...toolResult.artifacts);
                toolResult.modifiedFiles.forEach(path => modifiedFiles.add(path));
                messages.push(this._toolResultMessage(toolCall, toolResult.text, protocol));
                if (onProgress) {
                    try {
                        onProgress({ text: `\n[工具 ${toolCall.function?.name || 'unknown'}]\n${toolResult.text}\n` });
                    } catch { /* noop */ }
                }
            }
        }

        throw new Error(`${this.worker.name}：工具调用轮次超过限制，已中止。`);
    }

    private async _executeWithResponsesApi(
        task: Task,
        signal: AbortSignal,
        onProgress?: (chunk: { text: string }) => void,
    ): Promise<TaskResult> {
        const url = this._joinUrl(this._getBaseUrl(), '/responses');
        if (this._shouldUseWorkspaceTools()) {
            return await this._executeResponsesWithWorkspaceTools(url, task, signal, onProgress);
        }
        const res = await this._postChatCompletion(url, this._buildResponsesRequestBody(task), signal, false);
        const payload = await this._parseResponsesResponse(res);
        const content = this._responsesOutputToText(payload);
        if (content && onProgress) {
            try { onProgress({ text: content }); } catch { /* noop */ }
        }
        return this._formatStreamingResult(content);
    }

    private async _executeResponsesWithWorkspaceTools(
        url: string,
        task: Task,
        signal: AbortSignal,
        onProgress?: (chunk: { text: string }) => void,
    ): Promise<TaskResult> {
        const toolRunner = this._workspaceTools;
        if (!toolRunner) {
            throw new Error(`${this.worker.name}：未配置工作区工具。`);
        }

        const mode = this._workspaceToolMode(task);
        const tools = toolRunner.getDefinitions(mode);
        const instructions = this._responsesInstructions(task);
        const input: Array<Record<string, unknown>> = [
            { role: 'user', content: [{ type: 'input_text', text: task.prompt }] },
        ];
        const logs: string[] = [];
        const artifacts: Artifact[] = [];
        const modifiedFiles = new Set<string>();
        const maxIterations = this._options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            const res = await this._postChatCompletion(url, this._buildResponsesRequestBody(task, {
                instructions,
                input,
                tools,
            }), signal, false);
            const payload = await this._parseResponsesResponse(res);
            const content = this._responsesOutputToText(payload);
            const toolCalls = this._extractResponsesToolCalls(payload);

            if (content.trim()) {
                logs.push(content.trim());
                if (onProgress) {
                    try { onProgress({ text: content }); } catch { /* noop */ }
                }
            }

            if (toolCalls.length === 0) {
                artifacts.push(...extractArtifacts(content));
                return this._formatToolResult(content, logs, artifacts, modifiedFiles);
            }

            if (Array.isArray(payload.output)) {
                input.push(...payload.output as unknown as Array<Record<string, unknown>>);
            }
            for (const toolCall of toolCalls) {
                const toolResult = await this._executeResponsesToolCall(toolRunner, toolCall, mode);
                logs.push(...toolResult.logs);
                artifacts.push(...toolResult.artifacts);
                toolResult.modifiedFiles.forEach(path => modifiedFiles.add(path));
                input.push({
                    type: 'function_call_output',
                    call_id: toolCall.callId,
                    output: toolResult.text,
                });
                if (onProgress) {
                    try {
                        onProgress({ text: `\n[工具 ${toolCall.name}]\n${toolResult.text}\n` });
                    } catch { /* noop */ }
                }
            }
        }

        throw new Error(`${this.worker.name}：工具调用轮次超过限制，已中止。`);
    }

    private async _executeToolCall(
        runner: WorkspaceToolRunner,
        toolCall: ChatCompletionToolCall,
        mode: WorkspaceToolMode,
    ): Promise<WorkspaceToolExecutionResult> {
        const name = toolCall.function?.name;
        if (!name) {
            throw new Error(`${this.worker.name}：工具调用缺少名称。`);
        }
        let args: Record<string, unknown> = {};
        const rawArgs = toolCall.function?.arguments;
        if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
            try {
                args = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch (error) {
                throw new Error(`${this.worker.name}：工具 ${name} 参数不是合法 JSON：${String(error)}`);
            }
        } else if (rawArgs && typeof rawArgs === 'object') {
            args = rawArgs as Record<string, unknown>;
        }
        return await runner.execute(name, args, mode);
    }

    private async _executeResponsesToolCall(
        runner: WorkspaceToolRunner,
        toolCall: ResponsesToolCall,
        mode: WorkspaceToolMode,
    ): Promise<WorkspaceToolExecutionResult> {
        return await runner.execute(toolCall.name, this._normalizeResponsesArguments(toolCall.arguments), mode);
    }

    private _normalizeResponsesArguments(args: unknown): Record<string, unknown> {
        if (typeof args === 'string' && args.trim().length > 0) {
            try {
                return JSON.parse(args) as Record<string, unknown>;
            } catch {
                return {};
            }
        }
        if (args && typeof args === 'object') {
            return args as Record<string, unknown>;
        }
        return {};
    }

    private async _requestToolCompletion(
        url: string,
        options: {
            model: string;
            messages: Array<Record<string, unknown>>;
            tools: ReturnType<WorkspaceToolRunner['getDefinitions']>;
            signal: AbortSignal;
            protocol: ToolProtocol;
        }
    ): Promise<{ payload: ChatCompletionResponse; protocol: ToolProtocol }> {
        const attempt = async (protocol: ToolProtocol): Promise<{ payload: ChatCompletionResponse; protocol: ToolProtocol }> => {
            const res = await this._postChatCompletion(
                url,
                this._buildToolRequestBody(options.model, options.messages, options.tools, protocol),
                options.signal,
                false
            );
            return {
                payload: await this._parseJsonResponse(res),
                protocol,
            };
        };

        try {
            return await attempt(options.protocol);
        } catch (error) {
            if (options.protocol === 'modern' && this._looksLikeLegacyToolProtocolError(error)) {
                return await attempt('legacy');
            }
            throw error;
        }
    }

    private _buildResponsesRequestBody(
        task: Task,
        options?: {
            instructions?: string;
            input?: Array<Record<string, unknown>>;
            tools?: ReturnType<WorkspaceToolRunner['getDefinitions']>;
        }
    ): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: this._getModel(),
            input: options?.input ?? [{ role: 'user', content: [{ type: 'input_text', text: task.prompt }] }],
        };
        const instructions = options?.instructions ?? this._responsesInstructions(task);
        if (instructions) {
            body.instructions = instructions;
        }
        if (options?.tools) {
            body.tools = options.tools.map(def => ({
                type: 'function',
                name: def.function.name,
                description: def.function.description,
                parameters: def.function.parameters,
            }));
        }
        if (this._options.reasoningEffort) {
            body.reasoning = { effort: this._options.reasoningEffort };
        }
        if (this._options.disableResponseStorage) {
            body.store = false;
        }
        return body;
    }

    private _buildToolRequestBody(
        model: string,
        messages: Array<Record<string, unknown>>,
        tools: ReturnType<WorkspaceToolRunner['getDefinitions']>,
        protocol: ToolProtocol,
    ): Record<string, unknown> {
        if (protocol === 'legacy') {
            return {
                model,
                messages,
                functions: tools.map(def => def.function),
                stream: false,
            };
        }
        return {
            model,
            messages,
            tools,
            stream: false,
        };
    }

    private _responsesInstructions(task: Task): string | undefined {
        const instructions: string[] = [];
        if (this._options.systemPrompt && this._options.systemPrompt.length > 0) {
            instructions.push(this._options.systemPrompt);
        }
        if (this._shouldUseWorkspaceTools()) {
            const modeInstruction = task.mode === 'Execute'
                ? '当前是执行模式：如果任务要求修改代码，必须调用工作区写入工具完成真实文件修改，不要只用文字描述改法；如果不能修改，请明确说明原因。'
                : '当前是只读模式：只能读取、搜索和分析项目文件，不要声称已经修改文件。';
            instructions.push(
                '你可以调用工作区工具完成代码开发任务。',
                '先读取和搜索必要文件，再做最小范围修改。',
                modeInstruction,
                '修改后给出中文总结，说明改了哪些文件、如何验证。'
            );
        }
        return instructions.length > 0 ? instructions.join('\n') : undefined;
    }

    private _looksLikeLegacyToolProtocolError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        return [
            /tool_choice/,
            /tool_calls/,
            /unknown parameter.*tools?/,
            /unsupported parameter.*tools?/,
            /does not support.*tools?/,
            /unrecognized request argument.*tools?/,
            /functions? only/,
            /role ["']tool["']/,
        ].some(pattern => pattern.test(normalized));
    }

    private _extractToolCalls(message: ChatCompletionMessage): { toolCalls: ChatCompletionToolCall[]; protocol: ToolProtocol } {
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            return {
                toolCalls: message.tool_calls.map((call, index) => ({
                    ...call,
                    id: call.id || `tool-call-${index + 1}`,
                    type: call.type || 'function',
                })),
                protocol: 'modern',
            };
        }
        if (message.function_call?.name) {
            return {
                toolCalls: [{
                    id: 'legacy-function-call',
                    type: 'function',
                    function: {
                        name: message.function_call.name,
                        arguments: message.function_call.arguments,
                    },
                }],
                protocol: 'legacy',
            };
        }
        return { toolCalls: [], protocol: 'modern' };
    }

    private _assistantToolMessage(
        content: string,
        toolCalls: ChatCompletionToolCall[],
        protocol: ToolProtocol,
    ): Record<string, unknown> {
        if (protocol === 'legacy' && toolCalls.length > 0) {
            return {
                role: 'assistant',
                content: content || '',
                function_call: {
                    name: toolCalls[0].function?.name,
                    arguments: toolCalls[0].function?.arguments ?? '',
                },
            };
        }
        return {
            role: 'assistant',
            content: content || '',
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };
    }

    private _toolResultMessage(
        toolCall: ChatCompletionToolCall,
        content: string,
        protocol: ToolProtocol,
    ): Record<string, unknown> {
        if (protocol === 'legacy') {
            return {
                role: 'function',
                name: toolCall.function?.name || 'unknown_function',
                content,
            };
        }
        return {
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function?.name || 'tool-call',
            content,
        };
    }

    private _messageContentToText(content: unknown): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map(item => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item === 'object') {
                        const candidate = item as { text?: unknown; content?: unknown };
                        if (typeof candidate.text === 'string') return candidate.text;
                        if (typeof candidate.content === 'string') return candidate.content;
                    }
                    return '';
                })
                .filter(Boolean)
                .join('');
        }
        return '';
    }

    private async _postChatCompletion(
        url: string,
        body: Record<string, unknown>,
        signal: AbortSignal,
        streaming: boolean,
    ): Promise<Response> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: streaming ? 'text/event-stream' : 'application/json',
        };
        if (this._options.authToken && this._options.authToken.length > 0) {
            headers.Authorization = `Bearer ${this._options.authToken}`;
        }
        const fetchImpl = this._options.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new Error(`${this.worker.name}：当前运行环境不支持全局 fetch。`);
        }
        const res = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) {
            const text = await this._safeReadText(res);
            throw new Error(`${this.worker.name} HTTP ${res.status}: ${text || res.statusText}`);
        }
        return res;
    }

    private async _parseJsonResponse(res: Response): Promise<ChatCompletionResponse> {
        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            const text = await this._safeReadText(res);
            throw new Error(`${this.worker.name}：响应不是合法 JSON。${text ? ` 原始内容：${text}` : ''}`);
        }
        const parsed = payload as ChatCompletionResponse;
        if (parsed.error) {
            throw new Error(`${this.worker.name}：${parsed.error.message || 'OpenAI 兼容接口返回错误。'}`);
        }
        return parsed;
    }

    private async _parseResponsesResponse(res: Response): Promise<ResponsesApiResponse> {
        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            const text = await this._safeReadText(res);
            throw new Error(`${this.worker.name}：Responses 响应不是合法 JSON。${text ? ` 原始内容：${text}` : ''}`);
        }
        const parsed = payload as ResponsesApiResponse;
        if (parsed.error) {
            throw new Error(`${this.worker.name}：${parsed.error.message || 'Responses 接口返回错误。'}`);
        }
        return parsed;
    }

    private _responsesOutputToText(payload: ResponsesApiResponse): string {
        if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
            return payload.output_text;
        }
        if (!Array.isArray(payload.output)) {
            return '';
        }
        return payload.output
            .flatMap(item => Array.isArray(item.content) ? item.content : [])
            .map(part => typeof part.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('');
    }

    private _extractResponsesToolCalls(payload: ResponsesApiResponse): ResponsesToolCall[] {
        if (!Array.isArray(payload.output)) {
            return [];
        }
        return payload.output
            .filter(item => item.type === 'function_call' && typeof item.name === 'string')
            .map((item, index) => ({
                id: item.id || `responses-tool-${index + 1}`,
                callId: item.call_id || item.id || `responses-tool-${index + 1}`,
                name: item.name || 'unknown_function',
                arguments: item.arguments,
                raw: item,
            }));
    }

    private async _safeReadText(res: Response): Promise<string> {
        try {
            return await res.text();
        } catch {
            return '';
        }
    }

    /**
     * Read an OpenAI-style `text/event-stream` body, dispatching each
     * `delta.content` fragment through `onProgress` and returning the
     * fully-assembled assistant text.
     */
    private async _consumeStream(
        res: Response,
        onProgress?: (chunk: { text: string }) => void,
    ): Promise<string> {
        const body = res.body;
        if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== 'function') {
            throw new Error(`${this.worker.name}: relay returned a non-streaming body.`);
        }
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let assembled = '';
        try {
            let streamDone = false;
            while (!streamDone) {
                const { value, done } = await reader.read();
                if (done) {
                    streamDone = true;
                    continue;
                }
                buffer += decoder.decode(value, { stream: true });
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const rawEvent = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const delta = this._parseSseEvent(rawEvent);
                    if (delta === '__DONE__') {
                        return assembled;
                    }
                    if (delta && delta.length > 0) {
                        assembled += delta;
                        if (onProgress) {
                            try { onProgress({ text: delta }); } catch { /* noop */ }
                        }
                    }
                    boundary = buffer.indexOf('\n\n');
                }
            }
            const tail = buffer.trim();
            if (tail.length > 0) {
                const delta = this._parseSseEvent(tail);
                if (delta && delta !== '__DONE__' && delta.length > 0) {
                    assembled += delta;
                    if (onProgress) {
                        try { onProgress({ text: delta }); } catch { /* noop */ }
                    }
                }
            }
            return assembled;
        } finally {
            try { reader.releaseLock(); } catch { /* noop */ }
        }
    }

    private _parseSseEvent(rawEvent: string): string {
        const dataLines: string[] = [];
        for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const value = line.slice(5).replace(/^ /, '');
            dataLines.push(value);
        }
        if (dataLines.length === 0) return '';
        const payload = dataLines.join('\n').trim();
        if (payload.length === 0) return '';
        if (payload === SSE_TERMINATOR) return '__DONE__';
        let parsed: ChatCompletionStreamChunk;
        try {
            parsed = JSON.parse(payload) as ChatCompletionStreamChunk;
        } catch {
            return '';
        }
        if (parsed.error) {
            throw new Error(`${this.worker.name} 中继服务错误：${parsed.error.message || '未知错误'}`);
        }
        const choice = parsed.choices && parsed.choices[0];
        const content = choice?.delta?.content;
        return typeof content === 'string' ? content : '';
    }

    private _formatStreamingResult(content: string): TaskResult {
        const trimmed = content.trim();
        const summary = trimmed.length === 0
            ? `${this.worker.name} 返回了空响应。`
            : this._truncate(trimmed);
        const logs = trimmed ? trimmed.split('\n').filter(Boolean) : [];
        const artifacts: Artifact[] = trimmed ? extractArtifacts(trimmed) : [];
        return { summary, artifacts, logs };
    }

    private _formatToolResult(
        content: string,
        logs: string[],
        artifacts: Artifact[],
        modifiedFiles: Set<string>,
    ): TaskResult {
        const trimmed = content.trim();
        const summary = trimmed.length > 0
            ? this._truncate(trimmed)
            : modifiedFiles.size > 0
                ? `已通过工具修改 ${modifiedFiles.size} 个文件。`
                : `${this.worker.name} 已完成，但没有返回文字总结。`;
        return {
            summary,
            artifacts: dedupeArtifacts(artifacts),
            logs: logs.filter(Boolean),
            modifiedFiles: Array.from(modifiedFiles).sort(),
        };
    }

    private _truncate(text: string, max = 500): string {
        return text.length <= max ? text : text.substring(0, max) + '...';
    }
}

function dedupeArtifacts(artifacts: Artifact[]): Artifact[] {
    const seen = new Set<string>();
    return artifacts.filter(artifact => {
        const key = `${artifact.type}:${artifact.name}:${artifact.content}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
