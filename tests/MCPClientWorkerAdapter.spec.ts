import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Task } from '../src/types';
import { MCPClientWorkerAdapter, MCPClientWorkerOptions } from '../src/orchestrator/worker/MCPClientWorkerAdapter';

// ── Fake SDK ──────────────────────────────────────────────────────────────────
interface FakeCallToolResponse {
    content: Array<{ type: string; text?: string }>;
}

class FakeTransport {
    public closed = false;
    async close(): Promise<void> {
        this.closed = true;
    }
}

class FakeClient {
    public connected = false;
    public closed = false;
    public callToolArgs: Array<{ params: any; options: any }> = [];
    public callToolImpl: (params: any, _resultSchema: unknown, options: any) => Promise<FakeCallToolResponse> =
        async () => ({ content: [{ type: 'text', text: 'ok' }] });

    async connect(_transport: FakeTransport): Promise<void> {
        this.connected = true;
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    async callTool(params: any, resultSchema?: unknown, options?: any): Promise<FakeCallToolResponse> {
        this.callToolArgs.push({ params, options });
        return this.callToolImpl(params, resultSchema, options);
    }
}

class TestableMCPAdapter extends MCPClientWorkerAdapter {
    public fakeClient = new FakeClient();
    public fakeTransport = new FakeTransport();
    public createTransportCalls = 0;
    public createClientCalls = 0;
    public failNextConnect = false;

    constructor(id: string, name: string, options: MCPClientWorkerOptions) {
        super(id, name, options);
    }

    protected _createTransport(): any {
        this.createTransportCalls += 1;
        return this.fakeTransport;
    }

    protected _createClient(): any {
        this.createClientCalls += 1;
        if (this.failNextConnect) {
            const broken = new FakeClient();
            broken.connect = async () => { throw new Error('boom'); };
            return broken;
        }
        return this.fakeClient;
    }
}

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't1',
        sessionId: 's1',
        prompt: 'do the thing',
        mode: 'Execute',
        status: 'running',
        createdAt: Date.now(),
        ...overrides,
    };
}

describe('MCPClientWorkerAdapter', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    function makeAdapter(opts: Partial<MCPClientWorkerOptions> = {}): TestableMCPAdapter {
        return new TestableMCPAdapter('mcpc-1', 'MCP Client', {
            command: 'my-mcp',
            args: ['serve'],
            toolName: 'run_task',
            ...opts,
        });
    }

    it('starts disconnected with mcp worker type', () => {
        const adapter = makeAdapter();
        expect(adapter.worker.type).toBe('mcp');
        expect(adapter.worker.status).toBe('disconnected');
    });

    it('connect() builds a transport+client and marks the worker available', async () => {
        const adapter = makeAdapter();
        await adapter.connect();
        expect(adapter.createTransportCalls).toBe(1);
        expect(adapter.createClientCalls).toBe(1);
        expect(adapter.fakeClient.connected).toBe(true);
        expect(adapter.worker.status).toBe('available');
    });

    it('connect() leaves the worker disconnected when transport fails', async () => {
        const adapter = makeAdapter();
        adapter.failNextConnect = true;
        await adapter.connect();
        expect(adapter.worker.status).toBe('disconnected');
    });

    it('execute() throws if the client is not connected', async () => {
        const adapter = makeAdapter();
        await expect(adapter.execute(makeTask())).rejects.toThrow(/尚未连接/);
    });

    it('execute() forwards the prompt under the configured promptArgName', async () => {
        const adapter = makeAdapter({ toolName: 'run_task', promptArgName: 'goal' });
        await adapter.connect();
        await adapter.execute(makeTask({ prompt: 'refactor utils' }));
        expect(adapter.fakeClient.callToolArgs).toHaveLength(1);
        expect(adapter.fakeClient.callToolArgs[0].params).toEqual({
            name: 'run_task',
            arguments: { goal: 'refactor utils' },
        });
    });

    it("defaults promptArgName to 'prompt' when not configured", async () => {
        const adapter = makeAdapter();
        await adapter.connect();
        await adapter.execute(makeTask({ prompt: 'investigate flake' }));
        expect(adapter.fakeClient.callToolArgs[0].params.arguments).toEqual({
            prompt: 'investigate flake',
        });
    });

    it('execute() concatenates text content into logs and uses the last chunk as summary', async () => {
        const adapter = makeAdapter();
        adapter.fakeClient.callToolImpl = async () => ({
            content: [
                { type: 'text', text: 'planning phase' },
                { type: 'text', text: 'final answer: 42' },
            ],
        });
        await adapter.connect();
        const result = await adapter.execute(makeTask());
        expect(result.summary).toBe('final answer: 42');
        expect(result.logs).toEqual(['planning phase', 'final answer: 42']);
    });

    it('execute() reports a fallback summary when the tool returns no text content', async () => {
        const adapter = makeAdapter({ toolName: 'silent_tool' });
        adapter.fakeClient.callToolImpl = async () => ({ content: [] });
        await adapter.connect();
        const result = await adapter.execute(makeTask());
        expect(result.summary).toContain('silent_tool');
        expect(result.summary).toContain('没有返回文本内容');
        expect(result.logs).toEqual([]);
    });

    it('execute() extracts artifacts from text content via the shared parser', async () => {
        const adapter = makeAdapter();
        adapter.fakeClient.callToolImpl = async () => ({
            content: [
                {
                    type: 'text',
                    text: [
                        'diff --git a/src/x.ts b/src/x.ts',
                        '--- a/src/x.ts',
                        '+++ b/src/x.ts',
                        '@@ -1 +1 @@',
                        '-old',
                        '+new',
                    ].join('\n'),
                },
            ],
        });
        await adapter.connect();
        const result = await adapter.execute(makeTask());
        expect(result.artifacts).toHaveLength(1);
        expect(result.artifacts[0].name).toBe('src/x.ts');
    });

    it('cancel() aborts a pending callTool and frees the slot', async () => {
        const adapter = makeAdapter();
        let abortObserved: AbortSignal | undefined;
        adapter.fakeClient.callToolImpl = (_p, _s, options) => new Promise((_resolve, reject) => {
            abortObserved = options?.signal;
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        await adapter.connect();
        const task = makeTask({ id: 'race' });
        const inflight = adapter.execute(task);
        // give microtask time to register pending controller
        await Promise.resolve();
        const canceled = adapter.cancel('race');
        expect(canceled).toBe(true);
        expect(abortObserved?.aborted).toBe(true);
        await expect(inflight).rejects.toThrow(/aborted/);
        // a second cancel for the same id should now be a no-op
        expect(adapter.cancel('race')).toBe(false);
    });

    it('cancel() returns false for unknown task ids', async () => {
        const adapter = makeAdapter();
        await adapter.connect();
        expect(adapter.cancel('ghost')).toBe(false);
    });

    it('disconnect() closes the underlying client and aborts inflight calls', async () => {
        const adapter = makeAdapter();
        adapter.fakeClient.callToolImpl = (_p, _s, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted-by-disconnect')));
        });
        await adapter.connect();
        const inflight = adapter.execute(makeTask({ id: 'long' }));
        await Promise.resolve();
        await adapter.disconnect();
        expect(adapter.fakeClient.closed).toBe(true);
        expect(adapter.worker.status).toBe('disconnected');
        await expect(inflight).rejects.toThrow();
    });

    it('disconnect() is safe to call when never connected', async () => {
        const adapter = makeAdapter();
        await expect(adapter.disconnect()).resolves.toBeUndefined();
        expect(adapter.worker.status).toBe('disconnected');
    });
});
