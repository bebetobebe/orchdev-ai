import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { Task } from '../src/types';

// ── Mock child_process ─────────────────────────────────────────────
let lastExecFileArgs: { file: string; args: string[]; cb: Function } | null = null;
let lastSpawnArgs: { cmd: string; args: string[]; opts: SpawnOptions } | null = null;

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;
    kill(): boolean { this.killed = true; return true; }
}

let lastSpawnResult: FakeChild | null = null;

vi.mock('child_process', () => ({
    execFile: (file: string, args: string[], cb: Function) => {
        lastExecFileArgs = { file, args, cb };
    },
    spawn: (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
        const child = new FakeChild();
        lastSpawnResult = child;
        lastSpawnArgs = { cmd, args, opts };
        return child as unknown as ChildProcess;
    },
}));

// Import adapters after mock
import { MCPWorkerAdapter } from '../src/orchestrator/worker/MCPWorkerAdapter';
import { CodexWorkerAdapter } from '../src/orchestrator/worker/CodexWorkerAdapter';
import { OpenCodeWorkerAdapter } from '../src/orchestrator/worker/OpenCodeWorkerAdapter';
import { ClaudeCodeWorkerAdapter } from '../src/orchestrator/worker/ClaudeCodeWorkerAdapter';
import { GeminiWorkerAdapter } from '../src/orchestrator/worker/GeminiWorkerAdapter';
import { AiderWorkerAdapter } from '../src/orchestrator/worker/AiderWorkerAdapter';
import { RELAY_CONFIG } from '../src/config/relayConfig';

// ── Helpers ───────────────────────────────────────────────────────
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't1',
        sessionId: 's1',
        prompt: 'fix the bug',
        mode: 'Execute',
        status: 'running',
        createdAt: Date.now(),
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────
describe('MCPWorkerAdapter', () => {
    let adapter: MCPWorkerAdapter;

    beforeEach(() => {
        adapter = new MCPWorkerAdapter('mcp-1', 'MCP Alpha');
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('sets worker type to mcp', () => {
        expect(adapter.worker.type).toBe('mcp');
    });

    it('connect() skips version probe and marks available immediately', async () => {
        await adapter.connect();
        expect(lastExecFileArgs).toBeNull(); // no execFile call
        expect(adapter.worker.status).toBe('available');
    });

    it('execute() spawns "mcp run --prompt <prompt>"', () => {
        const task = makeTask({ prompt: 'hello world' });
        adapter.execute(task);

        expect(lastSpawnArgs!.cmd).toBe('mcp');
        expect(lastSpawnArgs!.args).toEqual(['run', '--prompt', 'hello world']);
    });

    it('formatResult uses legacy MCP summary shape', async () => {
        const task = makeTask();
        const p = adapter.execute(task);
        const child = lastSpawnResult!;

        child.stdout.emit('data', Buffer.from('some mcp output'));
        child.emit('close', 0, null);

        const result = await p;
        expect(result.summary).toContain('MCP 任务已完成');
        expect(result.summary).toContain('some mcp output');
        expect(result.logs).toEqual(['some mcp output']);
    });

    it('formatResult extracts artifacts from output', async () => {
        const task = makeTask();
        const p = adapter.execute(task);
        const child = lastSpawnResult!;

        const output = [
            'diff --git a/src/x.ts b/src/x.ts',
            '--- a/src/x.ts',
            '+++ b/src/x.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n');

        child.stdout.emit('data', Buffer.from(output));
        child.emit('close', 0, null);

        const result = await p;
        expect(result.artifacts).toHaveLength(1);
        expect(result.artifacts[0].type).toBe('file');
        expect(result.artifacts[0].name).toBe('src/x.ts');
    });

    it('logLabel includes worker name', async () => {
        const task = makeTask();
        const p = adapter.execute(task);
        lastSpawnResult!.emit('close', 1, null);

        await expect(p).rejects.toThrow('MCP Alpha');
    });
});

describe('CodexWorkerAdapter', () => {
    beforeEach(() => {
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('defaults CLI path to "codex"', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex');
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('codex');
    });

    it('respects custom cliPath option', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex', {
            cliPath: '/usr/local/bin/codex-custom',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('/usr/local/bin/codex-custom');
    });

    it('builds args with exec subcommand and prompt', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex');
        adapter.execute(makeTask({ prompt: 'deploy it' }));
        expect(lastSpawnArgs!.args).toEqual(['exec', 'deploy it']);
    });

    it('includes -m flag when model is set', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex', {
            model: 'gpt-5.2-codex',
        });
        adapter.execute(makeTask({ prompt: 'test' }));
        expect(lastSpawnArgs!.args).toContain('-m');
        expect(lastSpawnArgs!.args).toContain('gpt-5.2-codex');
    });

    it('includes -s flag when sandbox is set', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex', {
            sandbox: 'read-only',
        });
        adapter.execute(makeTask({ prompt: 'test' }));
        expect(lastSpawnArgs!.args).toContain('-s');
        expect(lastSpawnArgs!.args).toContain('read-only');
    });

    it('includes -C flag when cwd is set', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex', {
            cwd: '/home/user/project',
        });
        adapter.execute(makeTask({ prompt: 'test' }));
        expect(lastSpawnArgs!.args).toContain('-C');
        expect(lastSpawnArgs!.args).toContain('/home/user/project');
    });

    it('builds full args with all options', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex', {
            model: 'gpt-5.2-codex',
            sandbox: 'workspace-write',
            cwd: '/tmp/ws',
        });
        adapter.execute(makeTask({ prompt: 'refactor' }));
        expect(lastSpawnArgs!.args).toEqual([
            'exec', '-m', 'gpt-5.2-codex', '-s', 'workspace-write', '-C', '/tmp/ws', 'refactor',
        ]);
    });

    it('connect() probes version (shouldProbeVersion defaults to true)', async () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex');
        const p = adapter.connect();
        expect(lastExecFileArgs).not.toBeNull();
        expect(lastExecFileArgs!.file).toBe('codex');

        lastExecFileArgs!.cb(null, '0.1.0');
        await p;
        expect(adapter.worker.status).toBe('available');
    });

    it('logLabel returns "Codex"', async () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex');
        const p = adapter.execute(makeTask());
        lastSpawnResult!.emit('close', 1, null);

        await expect(p).rejects.toThrow('Codex');
    });
});

describe('OpenCodeWorkerAdapter', () => {
    beforeEach(() => {
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('sets worker type to cli', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode');
        expect(adapter.worker.type).toBe('cli');
    });

    it('defaults CLI path to "opencode"', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode');
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('opencode');
    });

    it('respects custom cliPath option', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode', {
            cliPath: '/opt/opencode',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('/opt/opencode');
    });

    it('builds args with run -q subcommand and prompt', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode');
        adapter.execute(makeTask({ prompt: 'migrate db' }));
        expect(lastSpawnArgs!.args).toEqual(['run', '-q', 'migrate db']);
    });

    it('includes -m flag when model is set', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode', {
            model: 'anthropic/claude-sonnet-4',
        });
        adapter.execute(makeTask({ prompt: 'test' }));
        expect(lastSpawnArgs!.args).toEqual([
            'run', '-q', '-m', 'anthropic/claude-sonnet-4', 'test',
        ]);
    });

    it('passes cwd via getSpawnCwd', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode', {
            cwd: '/workspace/project',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.opts.cwd).toBe('/workspace/project');
    });

    it('does not set cwd when option is absent', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode');
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.opts.cwd).toBeUndefined();
    });

    it('connect() probes version by default', async () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode');
        const p = adapter.connect();
        expect(lastExecFileArgs).not.toBeNull();
        expect(lastExecFileArgs!.file).toBe('opencode');

        lastExecFileArgs!.cb(null, '2.0.0');
        await p;
        expect(adapter.worker.status).toBe('available');
    });

    it('logLabel returns "OpenCode"', async () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode');
        const task = makeTask();
        const p = adapter.execute(task);
        lastSpawnResult!.emit('close', 1, null);

        await expect(p).rejects.toThrow('OpenCode');
    });
});

describe('ClaudeCodeWorkerAdapter', () => {
    beforeEach(() => {
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('sets worker type to cli', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code');
        expect(adapter.worker.type).toBe('cli');
    });

    it('defaults CLI path to "claude"', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code');
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('claude');
    });

    it('respects custom cliPath option', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code', {
            cliPath: '/usr/local/bin/claude-canary',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('/usr/local/bin/claude-canary');
    });

    it('builds args with -p print flag and prompt', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code');
        adapter.execute(makeTask({ prompt: 'plan migration' }));
        expect(lastSpawnArgs!.args).toEqual(['-p', 'plan migration']);
    });

    it('includes --model flag when model is set', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code', {
            model: 'claude-sonnet-4-5',
        });
        adapter.execute(makeTask({ prompt: 'refactor' }));
        expect(lastSpawnArgs!.args).toEqual(['-p', '--model', 'claude-sonnet-4-5', 'refactor']);
    });

    it('passes cwd via getSpawnCwd', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code', {
            cwd: '/repo/app',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.opts.cwd).toBe('/repo/app');
    });

    it('connect() probes version by default', async () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code');
        const p = adapter.connect();
        expect(lastExecFileArgs).not.toBeNull();
        expect(lastExecFileArgs!.file).toBe('claude');

        lastExecFileArgs!.cb(null, '1.0.0');
        await p;
        expect(adapter.worker.status).toBe('available');
    });

    it('logLabel returns "Claude Code"', async () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code');
        const p = adapter.execute(makeTask());
        lastSpawnResult!.emit('close', 1, null);

        await expect(p).rejects.toThrow('Claude Code');
    });
});

describe('GeminiWorkerAdapter', () => {
    beforeEach(() => {
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('sets worker type to cli', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini');
        expect(adapter.worker.type).toBe('cli');
    });

    it('defaults CLI path to "gemini"', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini');
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('gemini');
    });

    it('respects custom cliPath option', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini', {
            cliPath: '/opt/bin/gemini',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('/opt/bin/gemini');
    });

    it('builds args with -p prompt flag and prompt value', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini');
        adapter.execute(makeTask({ prompt: 'summarize repo' }));
        expect(lastSpawnArgs!.args).toEqual(['-p', 'summarize repo']);
    });

    it('appends -m flag after the prompt when model is set', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini', {
            model: 'gemini-2.5-pro',
        });
        adapter.execute(makeTask({ prompt: 'audit' }));
        expect(lastSpawnArgs!.args).toEqual(['-p', 'audit', '-m', 'gemini-2.5-pro']);
    });

    it('passes cwd via getSpawnCwd', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini', {
            cwd: '/work/proj',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.opts.cwd).toBe('/work/proj');
    });

    it('connect() probes version by default', async () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini');
        const p = adapter.connect();
        expect(lastExecFileArgs).not.toBeNull();
        expect(lastExecFileArgs!.file).toBe('gemini');

        lastExecFileArgs!.cb(null, '0.1.0');
        await p;
        expect(adapter.worker.status).toBe('available');
    });

    it('logLabel returns "Gemini"', async () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini');
        const p = adapter.execute(makeTask());
        lastSpawnResult!.emit('close', 1, null);

        await expect(p).rejects.toThrow('Gemini');
    });
});

describe('AiderWorkerAdapter', () => {
    beforeEach(() => {
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('sets worker type to cli', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider');
        expect(adapter.worker.type).toBe('cli');
    });

    it('defaults CLI path to "aider"', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider');
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.cmd).toBe('aider');
    });

    it('builds args with --message + non-interactive defaults', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider');
        adapter.execute(makeTask({ prompt: 'add tests' }));
        expect(lastSpawnArgs!.args).toEqual([
            '--message', 'add tests', '--no-pretty', '--no-stream', '--yes-always',
        ]);
    });

    it('omits --yes-always when autoConfirm is false', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider', {
            autoConfirm: false,
        });
        adapter.execute(makeTask({ prompt: 'review' }));
        expect(lastSpawnArgs!.args).not.toContain('--yes-always');
    });

    it('includes --model flag when model is set', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider', {
            model: 'gpt-5',
        });
        adapter.execute(makeTask({ prompt: 'tweak' }));
        expect(lastSpawnArgs!.args).toContain('--model');
        expect(lastSpawnArgs!.args).toContain('gpt-5');
    });

    it('passes cwd via getSpawnCwd', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider', {
            cwd: '/repo/aider-test',
        });
        adapter.execute(makeTask());
        expect(lastSpawnArgs!.opts.cwd).toBe('/repo/aider-test');
    });

    it('connect() probes version by default', async () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider');
        const p = adapter.connect();
        expect(lastExecFileArgs).not.toBeNull();
        expect(lastExecFileArgs!.file).toBe('aider');

        lastExecFileArgs!.cb(null, 'aider 0.60.0');
        await p;
        expect(adapter.worker.status).toBe('available');
    });

    it('logLabel returns "Aider"', async () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider');
        const p = adapter.execute(makeTask());
        lastSpawnResult!.emit('close', 1, null);

        await expect(p).rejects.toThrow('Aider');
    });
});

describe('Relay env injection on CLI workers', () => {
    const ORIGINAL_RELAY = { ...RELAY_CONFIG };

    beforeEach(() => {
        lastSpawnArgs = null;
        lastSpawnResult = null;
        // Force a known relay config for these tests so assertions are stable.
        RELAY_CONFIG.enabled = true;
        RELAY_CONFIG.openaiBaseUrl = 'https://relay.test/openai/v1';
        RELAY_CONFIG.anthropicBaseUrl = 'https://relay.test/anthropic';
        RELAY_CONFIG.geminiBaseUrl = 'https://relay.test/gemini/v1';
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        Object.assign(RELAY_CONFIG, ORIGINAL_RELAY);
        vi.restoreAllMocks();
    });

    it('Codex spawns with the OpenAI relay overlay when authToken is set', () => {
        const adapter = new CodexWorkerAdapter('codex-1', 'Codex', { authToken: 'sk-codex' });
        adapter.execute(makeTask());
        const env = lastSpawnArgs!.opts.env as NodeJS.ProcessEnv;
        expect(env).toBeDefined();
        expect(env.OPENAI_BASE_URL).toBe('https://relay.test/openai/v1');
        expect(env.OPENAI_API_BASE).toBe('https://relay.test/openai/v1');
        expect(env.OPENAI_API_KEY).toBe('sk-codex');
    });

    it('Claude Code spawns with the Anthropic relay overlay when authToken is set', () => {
        const adapter = new ClaudeCodeWorkerAdapter('claude-1', 'Claude Code', { authToken: 'sk-claude' });
        adapter.execute(makeTask());
        const env = lastSpawnArgs!.opts.env as NodeJS.ProcessEnv;
        expect(env.ANTHROPIC_BASE_URL).toBe('https://relay.test/anthropic');
        expect(env.ANTHROPIC_API_BASE).toBe('https://relay.test/anthropic');
        expect(env.ANTHROPIC_API_KEY).toBe('sk-claude');
    });

    it('Gemini spawns with the Gemini relay overlay and both Google API key aliases', () => {
        const adapter = new GeminiWorkerAdapter('gemini-1', 'Gemini', { authToken: 'sk-gemini' });
        adapter.execute(makeTask());
        const env = lastSpawnArgs!.opts.env as NodeJS.ProcessEnv;
        expect(env.GOOGLE_GEMINI_BASE_URL).toBe('https://relay.test/gemini/v1');
        expect(env.GEMINI_API_KEY).toBe('sk-gemini');
        expect(env.GOOGLE_API_KEY).toBe('sk-gemini');
    });

    it('OpenCode spawns with both OpenAI and Anthropic relay overlays (provider-agnostic)', () => {
        const adapter = new OpenCodeWorkerAdapter('oc-1', 'OpenCode', { authToken: 'sk-oc' });
        adapter.execute(makeTask());
        const env = lastSpawnArgs!.opts.env as NodeJS.ProcessEnv;
        expect(env.OPENAI_BASE_URL).toBe('https://relay.test/openai/v1');
        expect(env.OPENAI_API_KEY).toBe('sk-oc');
        expect(env.ANTHROPIC_BASE_URL).toBe('https://relay.test/anthropic');
        expect(env.ANTHROPIC_API_KEY).toBe('sk-oc');
    });

    it('Aider spawns with both OpenAI and Anthropic relay overlays (provider-agnostic)', () => {
        const adapter = new AiderWorkerAdapter('aider-1', 'Aider', { authToken: 'sk-aider' });
        adapter.execute(makeTask());
        const env = lastSpawnArgs!.opts.env as NodeJS.ProcessEnv;
        expect(env.OPENAI_BASE_URL).toBe('https://relay.test/openai/v1');
        expect(env.OPENAI_API_KEY).toBe('sk-aider');
        expect(env.ANTHROPIC_BASE_URL).toBe('https://relay.test/anthropic');
        expect(env.ANTHROPIC_API_KEY).toBe('sk-aider');
    });

    it('Inherits process.env on top of the relay overlay', () => {
        process.env.AI_ORCH_TEST_INHERITED = 'inherited-value';
        try {
            const adapter = new CodexWorkerAdapter('codex-2', 'Codex', { authToken: 'sk-x' });
            adapter.execute(makeTask());
            const env = lastSpawnArgs!.opts.env as NodeJS.ProcessEnv;
            expect(env.AI_ORCH_TEST_INHERITED).toBe('inherited-value');
            expect(env.OPENAI_API_KEY).toBe('sk-x');
        } finally {
            delete process.env.AI_ORCH_TEST_INHERITED;
        }
    });

    it('Skips env injection entirely when relay is disabled', () => {
        RELAY_CONFIG.enabled = false;
        const adapter = new CodexWorkerAdapter('codex-3', 'Codex', { authToken: 'sk-y' });
        adapter.execute(makeTask());
        // When buildRelayEnv returns undefined the base adapter leaves
        // spawnOpts.env unset (so the child inherits the default env).
        expect(lastSpawnArgs!.opts.env).toBeUndefined();
    });
});
