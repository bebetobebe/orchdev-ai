import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Task } from '../src/types';
import { RELAY_CONFIG } from '../src/config/relayConfig';
import { OpenAIRelayWorkerAdapter } from '../src/orchestrator/worker/OpenAIRelayWorkerAdapter';
import type { WorkspaceToolRunner } from '../src/orchestrator/worker/workspaceToolBridge';

const ORIGINAL_RELAY = { ...RELAY_CONFIG };

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't-relay',
        sessionId: 's-relay',
        prompt: 'do the relay thing',
        mode: 'Execute',
        status: 'running',
        createdAt: Date.now(),
        ...overrides,
    };
}

interface FakeFetchCall {
    url: string;
    init: RequestInit;
}

function makeFakeFetch(responder: (call: FakeFetchCall) => Promise<Response> | Response) {
    const calls: FakeFetchCall[] = [];
    const fn = (async (url: any, init: any) => {
        const call = { url: typeof url === 'string' ? url : String(url), init: init || {} };
        calls.push(call);
        return responder(call);
    }) as unknown as typeof fetch;
    return { fn, calls };
}

/**
 * Build a `Response` whose body is a ReadableStream that yields the given
 * raw SSE chunks one at a time, separated by the SSE event delimiter `\n\n`.
 * Each input string is enqueued as one `Uint8Array`, so passing multiple
 * entries lets a test simulate chunk boundaries that split mid-event.
 */
function sseResponse(rawChunks: string[], status = 200): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of rawChunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
    return new Response(stream, {
        status,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

/**
 * Convenience: turn a list of `delta.content` strings into a well-formed
 * OpenAI streaming response, terminated with `data: [DONE]`.
 */
function sseFromDeltas(deltas: string[], opts: { terminate?: boolean } = {}): Response {
    const events = deltas.map((text, i) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
    );
    if (opts.terminate !== false) events.push('data: [DONE]\n\n');
    return sseResponse(events);
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('OpenAIRelayWorkerAdapter', () => {
    beforeEach(() => {
        RELAY_CONFIG.enabled = true;
        RELAY_CONFIG.openaiBaseUrl = 'https://relay.test/openai/v1';
        RELAY_CONFIG.openaiDefaultModel = 'test-default-model';
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        Object.assign(RELAY_CONFIG, ORIGINAL_RELAY);
        vi.restoreAllMocks();
    });

    // === Connect / lifecycle ===

    it('starts disconnected and reports cli worker type', () => {
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay');
        expect(a.worker.type).toBe('cli');
        expect(a.worker.status).toBe('disconnected');
    });

    it('connect() flips to available when relay is enabled with a base URL', async () => {
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay');
        await a.connect();
        expect(a.worker.status).toBe('available');
    });

    it('connect() leaves the worker disconnected when RELAY_CONFIG.enabled is false', async () => {
        RELAY_CONFIG.enabled = false;
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay');
        await a.connect();
        expect(a.worker.status).toBe('disconnected');
    });

    it('connect() can ignore RELAY_CONFIG.enabled for a user-configured API worker', async () => {
        RELAY_CONFIG.enabled = false;
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
        });
        await a.connect();
        expect(a.worker.status).toBe('available');
    });

    it('connect() leaves the worker disconnected when base URL is empty', async () => {
        RELAY_CONFIG.openaiBaseUrl = '';
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay');
        await a.connect();
        expect(a.worker.status).toBe('disconnected');
    });

    it('execute() throws when worker is not available', async () => {
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay');
        await expect(a.execute(makeTask())).rejects.toThrow(/当前不可用/);
    });

    // === Request shape (now with stream:true) ===

    it('execute() POSTs /chat/completions on the relay base URL with stream=true', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['hi']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        await a.execute(makeTask({ prompt: 'hello' }));
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].url).toBe('https://relay.test/openai/v1/chat/completions');
        expect(fake.calls[0].init.method).toBe('POST');
        const body = JSON.parse(fake.calls[0].init.body as string);
        expect(body.stream).toBe(true);
        const headers = fake.calls[0].init.headers as Record<string, string>;
        expect(headers.Accept).toBe('text/event-stream');
    });

    it('execute() uses a custom OpenAI-compatible base URL when configured', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['hi']));
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://openrouter.test/api/v1',
            model: 'provider/model',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
        });
        await a.connect();
        await a.execute(makeTask());
        expect(fake.calls[0].url).toBe('https://openrouter.test/api/v1/chat/completions');
        const body = JSON.parse(fake.calls[0].init.body as string);
        expect(body.model).toBe('provider/model');
    });

    it('execute() can call the Responses API for fixed providers like MintAPI', async () => {
        const fake = makeFakeFetch(() => jsonResponse({
            output_text: 'hi from responses',
        }));
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'MintAPI', {
            baseUrl: 'https://mintapi.cn/v1',
            requireRelayEnabled: false,
            wireApi: 'responses',
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            disableResponseStorage: true,
            fetchImpl: fake.fn,
        });
        await a.connect();
        const result = await a.execute(makeTask({ prompt: 'hello' }));

        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].url).toBe('https://mintapi.cn/v1/responses');
        const body = JSON.parse(fake.calls[0].init.body as string);
        expect(body).toMatchObject({
            model: 'gpt-5.5',
            reasoning: { effort: 'high' },
            store: false,
        });
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ]);
        expect(result.summary).toBe('hi from responses');
    });

    it('execute() sends Bearer authorization header when authToken is set', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['ok']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', {
            fetchImpl: fake.fn,
            authToken: 'sk-secret',
        });
        await a.connect();
        await a.execute(makeTask());
        const headers = fake.calls[0].init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer sk-secret');
    });

    it('execute() omits the authorization header when authToken is empty', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['ok']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        await a.execute(makeTask());
        const headers = fake.calls[0].init.headers as Record<string, string>;
        expect('Authorization' in headers).toBe(false);
    });

    it('execute() uses the configured model and falls back to RELAY_CONFIG default', async () => {
        const fake1 = makeFakeFetch(() => sseFromDeltas(['a']));
        const a1 = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake1.fn });
        await a1.connect();
        await a1.execute(makeTask());
        const body1 = JSON.parse(fake1.calls[0].init.body as string);
        expect(body1.model).toBe('test-default-model');

        const fake2 = makeFakeFetch(() => sseFromDeltas(['b']));
        const a2 = new OpenAIRelayWorkerAdapter('relay-2', 'Relay', { fetchImpl: fake2.fn, model: 'override-model' });
        await a2.connect();
        await a2.execute(makeTask());
        const body2 = JSON.parse(fake2.calls[0].init.body as string);
        expect(body2.model).toBe('override-model');
    });

    it('execute() can use an adapter-specific default model', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['a']));
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            defaultModel: 'custom-default',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
        });
        await a.connect();
        await a.execute(makeTask());
        const body = JSON.parse(fake.calls[0].init.body as string);
        expect(body.model).toBe('custom-default');
    });

    it('execute() prepends the system prompt when configured', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['sys']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', {
            fetchImpl: fake.fn,
            systemPrompt: 'You are terse.',
        });
        await a.connect();
        await a.execute(makeTask({ prompt: 'count to 3' }));
        const body = JSON.parse(fake.calls[0].init.body as string);
        expect(body.messages).toEqual([
            { role: 'system', content: 'You are terse.' },
            { role: 'user', content: 'count to 3' },
        ]);
    });

    // === Streaming behavior ===

    it('execute() assembles deltas and returns the full content as TaskResult', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['Hello, ', 'world', '!']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask());
        expect(result.summary).toBe('Hello, world!');
        expect(result.logs).toEqual(['Hello, world!']);
    });

    it('execute() invokes onProgress for every non-empty delta in order', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['Hello, ', 'world', '!']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const chunks: string[] = [];
        await a.execute(makeTask(), { onProgress: (c) => chunks.push(c.text) });
        expect(chunks).toEqual(['Hello, ', 'world', '!']);
    });

    it('execute() tolerates events split across multiple read boundaries', async () => {
        // Split the JSON payload mid-stream so the buffer must reassemble it.
        const enc = (txt: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: txt } }] })}\n\n`;
        const full = enc('alpha') + enc('beta') + 'data: [DONE]\n\n';
        // Chop at byte 25, 60 to simulate fragmented network delivery.
        const a1 = full.slice(0, 25);
        const a2 = full.slice(25, 60);
        const a3 = full.slice(60);
        const fake = makeFakeFetch(() => sseResponse([a1, a2, a3]));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const chunks: string[] = [];
        const result = await a.execute(makeTask(), { onProgress: (c) => chunks.push(c.text) });
        expect(chunks).toEqual(['alpha', 'beta']);
        expect(result.summary).toBe('alphabeta');
    });

    it('execute() accepts CRLF-delimited SSE events from compatible providers', async () => {
        const events = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\r\n\r\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}\r\n\r\n`,
            'data: [DONE]\r\n\r\n',
        ];
        const fake = makeFakeFetch(() => sseResponse(events));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const chunks: string[] = [];
        const result = await a.execute(makeTask(), { onProgress: (c) => chunks.push(c.text) });
        expect(chunks).toEqual(['A', 'B']);
        expect(result.summary).toBe('AB');
    });

    it('execute() stops cleanly at the [DONE] terminator and ignores trailing bytes', async () => {
        const events = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`,
            `data: [DONE]\n\n`,
            // anything after [DONE] should be ignored
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'IGNORED' } }] })}\n\n`,
        ];
        const fake = makeFakeFetch(() => sseResponse(events));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const chunks: string[] = [];
        const result = await a.execute(makeTask(), { onProgress: (c) => chunks.push(c.text) });
        expect(chunks).toEqual(['first']);
        expect(result.summary).toBe('first');
    });

    it('execute() throws when an SSE event carries an inline error envelope', async () => {
        const events = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
            `data: ${JSON.stringify({ error: { message: 'rate limit hit', type: 'limit' } })}\n\n`,
        ];
        const fake = makeFakeFetch(() => sseResponse(events));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        await expect(a.execute(makeTask())).rejects.toThrow(/rate limit hit/);
    });

    it('execute() ignores SSE comments, keep-alive blank lines, and unknown fields', async () => {
        const events = [
            ': heartbeat\n\n',
            'event: ping\n\n',
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\n`,
            '\n', // bare keep-alive newline
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}\n\n`,
            'data: [DONE]\n\n',
        ];
        const fake = makeFakeFetch(() => sseResponse(events));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask());
        expect(result.summary).toBe('AB');
    });

    it('execute() silently skips data lines whose JSON fails to parse', async () => {
        const events = [
            'data: {not valid json}\n\n',
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'survived' } }] })}\n\n`,
            'data: [DONE]\n\n',
        ];
        const fake = makeFakeFetch(() => sseResponse(events));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask());
        expect(result.summary).toBe('survived');
    });

    it('execute() handles a stream that ends without an explicit [DONE]', async () => {
        const events = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'only' } }] })}\n\n`,
        ];
        const fake = makeFakeFetch(() => sseResponse(events));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask());
        expect(result.summary).toBe('only');
    });

    it('execute() produces artifacts from streamed diff content just like a one-shot', async () => {
        const content = [
            'planning step',
            'diff --git a/src/x.ts b/src/x.ts',
            '--- a/src/x.ts',
            '+++ b/src/x.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n');
        // Stream it as one big delta — production servers usually chunk it
        // smaller, but extractArtifacts only sees the assembled string.
        const fake = makeFakeFetch(() => sseFromDeltas([content]));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask());
        expect(result.artifacts).toHaveLength(1);
        expect(result.artifacts[0].name).toBe('src/x.ts');
        expect(result.logs.length).toBeGreaterThan(0);
    });

    it('execute() returns a fallback summary when the stream produces no content', async () => {
        const fake = makeFakeFetch(() => sseResponse(['data: [DONE]\n\n']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask());
        expect(result.summary).toContain('空响应');
        expect(result.logs).toEqual([]);
    });

    // === Errors / cancellation ===

    it('execute() throws on a non-2xx response with the body included', async () => {
        const fake = makeFakeFetch(() => new Response('rate limited', { status: 429 }));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        await expect(a.execute(makeTask())).rejects.toThrow(/HTTP 429/);
    });

    it('cancel() aborts an inflight request and frees the slot', async () => {
        let observedSignal: AbortSignal | undefined;
        const fake = makeFakeFetch((call) => new Promise((_resolve, reject) => {
            observedSignal = (call.init as any).signal;
            observedSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const inflight = a.execute(makeTask({ id: 'race' }));
        await Promise.resolve();
        const ok = a.cancel('race');
        expect(ok).toBe(true);
        expect(observedSignal?.aborted).toBe(true);
        await expect(inflight).rejects.toThrow(/aborted/);
        expect(a.cancel('race')).toBe(false);
    });

    it('cancel() mid-stream rejects the execute() promise after some chunks have streamed', async () => {
        // Build a stream where we hold the second chunk indefinitely so the
        // adapter is parked on `reader.read()` when we cancel. We can't call
        // `res.body.cancel()` from outside (the adapter has already taken the
        // reader lock); instead we wire the AbortSignal to `controller.error`
        // so the next `reader.read()` rejects, which is exactly what real
        // Node fetch does when the request is aborted mid-stream.
        const enc = new TextEncoder();
        let pendingController!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                pendingController = controller;
                controller.enqueue(enc.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`,
                ));
                // never close \u2014 wait for the abort signal to error the stream
            },
        });
        const fake = makeFakeFetch((call) => {
            const sig = (call.init as any).signal as AbortSignal | undefined;
            sig?.addEventListener('abort', () => {
                try { pendingController.error(new Error('aborted')); } catch { /* noop */ }
            });
            return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        });
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const chunks: string[] = [];
        const inflight = a.execute(makeTask({ id: 'mid' }), { onProgress: (c) => chunks.push(c.text) });
        // Yield enough microtasks for the adapter to read & emit the first chunk.
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const ok = a.cancel('mid');
        expect(ok).toBe(true);
        await expect(inflight).rejects.toThrow(/aborted/);
        // First chunk arrived and was emitted before the abort took effect.
        expect(chunks).toEqual(['first']);
        // Slot is freed after rejection.
        expect(a.cancel('mid')).toBe(false);
    });

    it('disconnect() aborts pending requests and resets status', async () => {
        const fake = makeFakeFetch((call) => new Promise((_resolve, reject) => {
            (call.init as any).signal?.addEventListener('abort', () => reject(new Error('aborted-by-disconnect')));
        }));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const inflight = a.execute(makeTask({ id: 'long' }));
        await Promise.resolve();
        await a.disconnect();
        expect(a.worker.status).toBe('disconnected');
        await expect(inflight).rejects.toThrow();
    });

    it('execute() aborts after timeoutMs elapses', async () => {
        const fake = makeFakeFetch((call) => new Promise((_resolve, reject) => {
            (call.init as any).signal?.addEventListener('abort', () => reject(new Error('aborted-by-timeout')));
        }));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', {
            fetchImpl: fake.fn,
            timeoutMs: 25,
        });
        await a.connect();
        await expect(a.execute(makeTask({ id: 'slow' }))).rejects.toThrow(/aborted-by-timeout/);
    });

    it('execute() swallows errors thrown from onProgress without failing the task', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['x', 'y']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        const result = await a.execute(makeTask(), {
            onProgress: () => { throw new Error('boom'); },
        });
        expect(result.summary).toBe('xy');
    });

    it('joins base URLs that already end with a slash without doubling', async () => {
        RELAY_CONFIG.openaiBaseUrl = 'https://relay.test/openai/v1/';
        const fake = makeFakeFetch(() => sseFromDeltas(['ok']));
        const a = new OpenAIRelayWorkerAdapter('relay-1', 'Relay', { fetchImpl: fake.fn });
        await a.connect();
        await a.execute(makeTask());
        expect(fake.calls[0].url).toBe('https://relay.test/openai/v1/chat/completions');
    });

    it('normalizes a base URL that already includes /chat/completions', async () => {
        const fake = makeFakeFetch(() => sseFromDeltas(['ok']));
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1/chat/completions',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
        });
        await a.connect();
        await a.execute(makeTask());
        expect(fake.calls[0].url).toBe('https://custom.test/v1/chat/completions');
    });

    it('execute() can loop through OpenAI tool calls and merge tool artifacts', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => [
                {
                    type: 'function',
                    function: {
                        name: 'workspace_write_file',
                        description: 'write',
                        parameters: { type: 'object', properties: {}, additionalProperties: false },
                    },
                },
            ]),
            execute: vi.fn(async () => ({
                text: '{"ok":true,"path":"src/demo.ts"}',
                logs: ['工具已写入 src/demo.ts'],
                artifacts: [{ type: 'file', name: 'src/demo.ts', content: 'export const demo = 1;\n' }],
                modifiedFiles: ['src/demo.ts'],
            })),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            if (Array.isArray(body.messages) && body.messages.some((msg: any) => msg.role === 'tool')) {
                return jsonResponse({
                    choices: [{ message: { content: '已完成修改并保存文件。' }, finish_reason: 'stop' }],
                });
            }
            return jsonResponse({
                choices: [{
                    message: {
                        content: '我先直接修改文件。',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'workspace_write_file',
                                arguments: JSON.stringify({
                                    path: 'src/demo.ts',
                                    content: 'export const demo = 1;\n',
                                }),
                            },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ prompt: '修改 src/demo.ts' }));

        expect(fake.calls).toHaveLength(2);
        expect((toolRunner.getDefinitions as any).mock.calls[0][0]).toBe('write');
        expect((toolRunner.execute as any).mock.calls[0][0]).toBe('workspace_write_file');
        expect((toolRunner.execute as any).mock.calls[0][2]).toBe('write');
        expect(result.summary).toBe('已完成修改并保存文件。');
        expect(result.artifacts.some(a => a.name === 'src/demo.ts')).toBe(true);
        expect(result.logs).toContain('工具已写入 src/demo.ts');
        expect(result.modifiedFiles).toEqual(['src/demo.ts']);
    });

    it('execute() can loop through Responses API function calls and merge tool artifacts', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => [
                {
                    type: 'function',
                    function: {
                        name: 'workspace_write_file',
                        description: 'write',
                        parameters: { type: 'object', properties: {}, additionalProperties: false },
                    },
                },
            ]),
            execute: vi.fn(async () => ({
                text: '{"ok":true,"path":"src/responses.ts"}',
                logs: ['Responses 工具已写入 src/responses.ts'],
                artifacts: [{ type: 'file', name: 'src/responses.ts', content: 'export const responses = true;\n' }],
                modifiedFiles: ['src/responses.ts'],
            })),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            if (Array.isArray(body.input) && body.input.some((item: any) => item.type === 'function_call_output')) {
                return jsonResponse({
                    output_text: 'Responses 已完成修改。',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Responses 已完成修改。' }] }],
                });
            }
            return jsonResponse({
                output: [{
                    type: 'function_call',
                    id: 'fc-1',
                    call_id: 'call-1',
                    name: 'workspace_write_file',
                    arguments: JSON.stringify({
                        path: 'src/responses.ts',
                        content: 'export const responses = true;\n',
                    }),
                }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'MintAPI', {
            baseUrl: 'https://mintapi.cn/v1',
            requireRelayEnabled: false,
            wireApi: 'responses',
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            disableResponseStorage: true,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ prompt: '修改 src/responses.ts' }));

        expect(fake.calls).toHaveLength(2);
        expect(JSON.parse(fake.calls[0].init.body as string).tools[0]).toMatchObject({
            type: 'function',
            name: 'workspace_write_file',
        });
        expect(JSON.parse(fake.calls[1].init.body as string).input).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }),
        ]));
        expect(result.summary).toBe('Responses 已完成修改。');
        expect(result.modifiedFiles).toEqual(['src/responses.ts']);
        expect(result.logs).toContain('Responses 工具已写入 src/responses.ts');
    });

    it('execute() accepts legacy function_call responses from compatible APIs', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => [
                {
                    type: 'function',
                    function: {
                        name: 'workspace_write_file',
                        description: 'write',
                        parameters: { type: 'object', properties: {}, additionalProperties: false },
                    },
                },
            ]),
            execute: vi.fn(async () => ({
                text: '{"ok":true,"path":"src/legacy.ts"}',
                logs: ['旧式工具调用已写入 src/legacy.ts'],
                artifacts: [],
                modifiedFiles: ['src/legacy.ts'],
            })),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            if (Array.isArray(body.messages) && body.messages.some((msg: any) => msg.role === 'function')) {
                return jsonResponse({
                    choices: [{ message: { content: '旧式函数调用已完成。' }, finish_reason: 'stop' }],
                });
            }
            return jsonResponse({
                choices: [{
                    message: {
                        content: '',
                        function_call: {
                            name: 'workspace_write_file',
                            arguments: JSON.stringify({
                                path: 'src/legacy.ts',
                                content: 'export const legacy = true;\n',
                            }),
                        },
                    },
                    finish_reason: 'function_call',
                }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-legacy', 'Legacy API', {
            baseUrl: 'https://legacy.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ prompt: '用旧式函数调用修改文件' }));

        expect(fake.calls).toHaveLength(2);
        expect(JSON.parse(fake.calls[0].init.body as string).tools).toBeTruthy();
        const secondBody = JSON.parse(fake.calls[1].init.body as string);
        expect(secondBody.functions).toBeTruthy();
        expect(secondBody.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'function', name: 'workspace_write_file' }),
        ]));
        expect((toolRunner.execute as any).mock.calls[0][0]).toBe('workspace_write_file');
        expect(result.summary).toBe('旧式函数调用已完成。');
        expect(result.modifiedFiles).toEqual(['src/legacy.ts']);
    });

    it('execute() falls back to legacy functions when an API rejects tools parameters', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => [
                {
                    type: 'function',
                    function: {
                        name: 'workspace_read_file',
                        description: 'read',
                        parameters: { type: 'object', properties: {}, additionalProperties: false },
                    },
                },
            ]),
            execute: vi.fn(),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            if (body.tools) {
                return new Response('unsupported parameter: tools', { status: 400, statusText: 'Bad Request' });
            }
            return jsonResponse({
                choices: [{ message: { content: '已切换旧式函数协议。' }, finish_reason: 'stop' }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-legacy', 'Legacy API', {
            baseUrl: 'https://legacy.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ mode: 'Ask', prompt: '分析文件' }));

        expect(fake.calls).toHaveLength(2);
        expect(JSON.parse(fake.calls[0].init.body as string).tools).toBeTruthy();
        expect(JSON.parse(fake.calls[1].init.body as string).functions).toBeTruthy();
        expect(result.summary).toBe('已切换旧式函数协议。');
    });

    it('execute() synthesizes missing tool call ids before sending tool results back', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => [
                {
                    type: 'function',
                    function: {
                        name: 'workspace_write_file',
                        description: 'write',
                        parameters: { type: 'object', properties: {}, additionalProperties: false },
                    },
                },
            ]),
            execute: vi.fn(async () => ({
                text: '{"ok":true}',
                logs: [],
                artifacts: [],
                modifiedFiles: [],
            })),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            if (Array.isArray(body.messages) && body.messages.some((msg: any) => msg.role === 'tool')) {
                const toolMessage = body.messages.find((msg: any) => msg.role === 'tool');
                expect(toolMessage.tool_call_id).toBe('tool-call-1');
                return jsonResponse({
                    choices: [{ message: { content: '完成。' }, finish_reason: 'stop' }],
                });
            }
            return jsonResponse({
                choices: [{
                    message: {
                        content: '',
                        tool_calls: [{
                            type: 'function',
                            function: {
                                name: 'workspace_write_file',
                                arguments: '{}',
                            },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-missing-id', 'Missing Id API', {
            baseUrl: 'https://missing-id.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ prompt: '缺少工具调用 id' }));

        expect(result.summary).toBe('完成。');
    });

    it('execute() keeps Ask mode tools in read-only mode', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => []),
            execute: vi.fn(),
        };
        const fake = makeFakeFetch(() => jsonResponse({
            choices: [{ message: { content: '只是分析，没有改文件。' }, finish_reason: 'stop' }],
        }));
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        await a.execute(makeTask({ mode: 'Ask', prompt: '分析一下' }));

        expect((toolRunner.getDefinitions as any).mock.calls[0][0]).toBe('read');
        expect(toolRunner.execute).not.toHaveBeenCalled();
    });

    it('exposes batch file reading to both read and write tool modes', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn((mode) => mode === 'write'
                ? [
                    {
                        type: 'function',
                        function: {
                            name: 'workspace_read_many_files',
                            description: 'read many',
                            parameters: { type: 'object', properties: {}, additionalProperties: false },
                        },
                    },
                ]
                : []),
            execute: vi.fn(),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            expect(body.tools.some((tool: any) => tool.function.name === 'workspace_read_many_files')).toBe(true);
            return jsonResponse({
                choices: [{ message: { content: '看完多个文件了。' }, finish_reason: 'stop' }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        await a.execute(makeTask({ mode: 'Execute', prompt: '先读多个文件' }));

        expect((toolRunner.getDefinitions as any).mock.calls[0][0]).toBe('write');
    });

    it('instructs Execute mode to perform real file changes with workspace write tools', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => []),
            execute: vi.fn(),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            const systemText = body.messages
                .filter((msg: any) => msg.role === 'system')
                .map((msg: any) => msg.content)
                .join('\n');
            expect(systemText).toContain('当前是执行模式');
            expect(systemText).toContain('必须调用工作区写入工具完成真实文件修改');
            return jsonResponse({
                choices: [{ message: { content: '无法修改，因为没有可用写入工具。' }, finish_reason: 'stop' }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        await a.execute(makeTask({ mode: 'Execute', prompt: '修改文件' }));
    });

    it('accepts object-form tool arguments from compatible APIs', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => [
                {
                    type: 'function',
                    function: {
                        name: 'workspace_replace_range',
                        description: 'replace range',
                        parameters: { type: 'object', properties: {}, additionalProperties: false },
                    },
                },
            ]),
            execute: vi.fn(async () => ({
                text: '{"ok":true}',
                logs: ['工具已调用'],
                artifacts: [],
                modifiedFiles: ['src/demo.ts'],
            })),
        };
        const fake = makeFakeFetch((call) => {
            const body = JSON.parse(call.init.body as string);
            if (Array.isArray(body.messages) && body.messages.some((msg: any) => msg.role === 'tool')) {
                return jsonResponse({
                    choices: [{ message: { content: '修改完成。' }, finish_reason: 'stop' }],
                });
            }
            return jsonResponse({
                choices: [{
                    message: {
                        content: '',
                        tool_calls: [{
                            id: 'call-obj',
                            type: 'function',
                            function: {
                                name: 'workspace_replace_range',
                                arguments: {
                                    path: 'src/demo.ts',
                                    startLine: 1,
                                    endLine: 2,
                                    newText: 'export const demo = 2;',
                                },
                            },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            });
        });
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ prompt: '精确修改文件' }));

        expect((toolRunner.execute as any).mock.calls[0][0]).toBe('workspace_replace_range');
        expect((toolRunner.execute as any).mock.calls[0][1]).toMatchObject({
            path: 'src/demo.ts',
            startLine: 1,
            endLine: 2,
            newText: 'export const demo = 2;',
        });
        expect(result.summary).toBe('修改完成。');
    });

    it('extracts text from array-form assistant content in tool mode', async () => {
        const toolRunner: WorkspaceToolRunner = {
            getDefinitions: vi.fn(() => []),
            execute: vi.fn(),
        };
        const fake = makeFakeFetch(() => jsonResponse({
            choices: [{
                message: {
                    content: [
                        { type: 'text', text: '第一段。' },
                        { type: 'text', text: '第二段。' },
                    ],
                },
                finish_reason: 'stop',
            }],
        }));
        const a = new OpenAIRelayWorkerAdapter('custom-1', 'Custom API', {
            baseUrl: 'https://custom.test/v1',
            requireRelayEnabled: false,
            fetchImpl: fake.fn,
            enableWorkspaceTools: true,
            workspaceRoot: '/workspace',
            workspaceToolRunner: toolRunner,
        });
        await a.connect();
        const result = await a.execute(makeTask({ mode: 'Ask', prompt: '分析一下' }));

        expect(result.summary).toBe('第一段。第二段。');
        expect(result.logs).toContain('第一段。第二段。');
    });
});
