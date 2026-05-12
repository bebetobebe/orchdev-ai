import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { Task } from '../src/types';

// ── Mock child_process ─────────────────────────────────────────────
// We capture the callbacks passed to execFile / spawn so we can drive them
// from tests without starting real processes.

let lastExecFileArgs: { file: string; args: string[]; cb: Function } | null = null;
let lastSpawnResult: FakeChild | null = null;
let lastSpawnArgs: { cmd: string; args: string[]; opts: SpawnOptions } | null = null;

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;
    kill(): boolean {
        this.killed = true;
        return true;
    }
}

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

// Import after mock so the module picks up the stubs
import { BaseCliWorkerAdapter } from '../src/orchestrator/worker/BaseCliWorkerAdapter';

// ── Concrete test subclass ────────────────────────────────────────
class StubCliAdapter extends BaseCliWorkerAdapter {
    cliPath = '/usr/bin/fake-cli';
    extraArgs: string[] = [];
    cwd: string | undefined = undefined;
    probeVersion = true;

    constructor(id = 'stub-1', name = 'Stub') {
        super(id, name, 'cli');
    }

    protected getCliPath(): string {
        return this.cliPath;
    }
    protected buildArgs(task: Task): string[] {
        return ['run', task.prompt, ...this.extraArgs];
    }
    protected getSpawnCwd(): string | undefined {
        return this.cwd;
    }
    protected shouldProbeVersion(): boolean {
        return this.probeVersion;
    }
}

// ── Helpers ───────────────────────────────────────────────────────
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't1',
        sessionId: 's1',
        prompt: 'do stuff',
        mode: 'Execute',
        status: 'running',
        createdAt: Date.now(),
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────
describe('BaseCliWorkerAdapter', () => {
    let adapter: StubCliAdapter;

    beforeEach(() => {
        adapter = new StubCliAdapter();
        lastExecFileArgs = null;
        lastSpawnResult = null;
        lastSpawnArgs = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ─── Constructor ────────────────────────────────────────────
    describe('constructor', () => {
        it('initialises worker with given id, name, type and disconnected status', () => {
            expect(adapter.worker).toEqual({
                id: 'stub-1',
                name: 'Stub',
                type: 'cli',
                status: 'disconnected',
            });
        });
    });

    // ─── connect() ──────────────────────────────────────────────
    describe('connect()', () => {
        it('probes --version and marks available on success', async () => {
            const p = adapter.connect();
            expect(lastExecFileArgs).not.toBeNull();
            expect(lastExecFileArgs!.file).toBe('/usr/bin/fake-cli');
            expect(lastExecFileArgs!.args).toEqual(['--version']);

            // Simulate successful version output
            lastExecFileArgs!.cb(null, '1.2.3\n');
            await p;

            expect(adapter.worker.status).toBe('available');
        });

        it('marks disconnected when CLI probe fails', async () => {
            const p = adapter.connect();
            lastExecFileArgs!.cb(new Error('ENOENT'), '');
            await p;

            expect(adapter.worker.status).toBe('disconnected');
        });

        it('skips probe and marks available when shouldProbeVersion returns false', async () => {
            adapter.probeVersion = false;
            await adapter.connect();
            expect(lastExecFileArgs).toBeNull();
            expect(adapter.worker.status).toBe('available');
        });
    });

    // ─── disconnect() ───────────────────────────────────────────
    describe('disconnect()', () => {
        it('sets status to disconnected', async () => {
            adapter.worker.status = 'available';
            await adapter.disconnect();
            expect(adapter.worker.status).toBe('disconnected');
        });

        it('kills all running children on disconnect', async () => {
            // Start a task so there's a running child
            const task = makeTask();
            const execP = adapter.execute(task);

            const child = lastSpawnResult!;
            expect(child).not.toBeNull();

            await adapter.disconnect();
            expect(child.killed).toBe(true);

            // The promise should reject because we disconnected; settle it
            child.emit('close', null, 'SIGTERM');
            await execP.catch(() => {}); // swallow
        });
    });

    // ─── execute() ──────────────────────────────────────────────
    describe('execute()', () => {
        it('resolves with formatted result on exit code 0', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('line1\nline2\n'));
            child.emit('close', 0, null);

            const result = await p;
            expect(result.logs).toEqual(['line1', 'line2']);
            expect(result.summary).toBe('line2');
            expect(result.artifacts).toEqual([]); // no code blocks / diffs
        });

        it('rejects on non-zero exit code with stderr', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            child.stderr.emit('data', Buffer.from('fatal error'));
            child.emit('close', 1, null);

            await expect(p).rejects.toThrow('fatal error');
        });

        it('rejects on non-zero exit code with stdout fallback when stderr is empty', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('something went wrong'));
            child.emit('close', 1, null);

            await expect(p).rejects.toThrow('something went wrong');
        });

        it('rejects with fallback text when both stdout/stderr are empty on non-zero exit', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.emit('close', 2, null);

            await expect(p).rejects.toThrow('无输出');
        });

        it('rejects on SIGTERM signal', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.emit('close', null, 'SIGTERM');

            await expect(p).rejects.toThrow('任务已取消');
        });

        it('rejects on SIGKILL signal', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.emit('close', null, 'SIGKILL');

            await expect(p).rejects.toThrow('任务已取消');
        });

        it('rejects on spawn error event', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.emit('error', new Error('spawn ENOENT'));

            await expect(p).rejects.toThrow('spawn ENOENT');
        });

        it('warns on stderr when exit code is 0', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('ok\nfine\n'));
            child.stderr.emit('data', Buffer.from('warning: something'));
            child.emit('close', 0, null);

            await p;
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('warning: something')
            );
        });

        it('passes cwd when getSpawnCwd returns a value', () => {
            adapter.cwd = '/tmp/work';
            const task = makeTask();
            adapter.execute(task);

            expect(lastSpawnArgs).not.toBeNull();
            expect(lastSpawnArgs!.cmd).toBe('/usr/bin/fake-cli');
            expect(lastSpawnArgs!.args).toEqual(['run', 'do stuff']);
            expect(lastSpawnArgs!.opts.cwd).toBe('/tmp/work');

            // settle the promise
            lastSpawnResult!.emit('close', 0, null);
        });

        it('extracts artifacts from stdout with code blocks', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            const output = [
                'Here is the code:',
                '```ts',
                'const x = 1;',
                'const y = 2;',
                '```',
                ''
            ].join('\n');

            child.stdout.emit('data', Buffer.from(output));
            child.emit('close', 0, null);

            const result = await p;
            expect(result.artifacts).toHaveLength(1);
            expect(result.artifacts[0].type).toBe('snippet');
            expect(result.artifacts[0].name).toBe('snippet-ts-1');
        });

        // ─── streaming via opts.onProgress ─────────────────────────
        it('forwards every stdout chunk to onProgress in order', async () => {
            const task = makeTask();
            const chunks: string[] = [];
            const p = adapter.execute(task, { onProgress: (c) => chunks.push(c.text) });
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('hello '));
            child.stdout.emit('data', Buffer.from('world'));
            child.stdout.emit('data', Buffer.from('!'));
            child.emit('close', 0, null);

            const result = await p;
            expect(chunks).toEqual(['hello ', 'world', '!']);
            // Final assembled output goes through formatResult unchanged.
            expect(result.summary).toBe('hello world!');
        });

        it('does not forward stderr chunks to onProgress', async () => {
            const task = makeTask();
            const chunks: string[] = [];
            const p = adapter.execute(task, { onProgress: (c) => chunks.push(c.text) });
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('out'));
            child.stderr.emit('data', Buffer.from('warning: ignore me'));
            child.emit('close', 0, null);

            await p;
            expect(chunks).toEqual(['out']);
        });

        it('execute() works without an onProgress listener (no opts arg)', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.stdout.emit('data', Buffer.from('plain\n'));
            lastSpawnResult!.emit('close', 0, null);
            await expect(p).resolves.toBeDefined();
        });

        it('swallows errors thrown from onProgress without failing the task', async () => {
            const task = makeTask();
            const p = adapter.execute(task, {
                onProgress: () => { throw new Error('listener boom'); },
            });
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('still-fine\n'));
            child.emit('close', 0, null);

            const result = await p;
            expect(result.logs).toEqual(['still-fine']);
        });
    });

    // ─── cancel() ───────────────────────────────────────────────
    describe('cancel()', () => {
        it('returns false when no task with that id is running', () => {
            expect(adapter.cancel('nonexistent')).toBe(false);
        });

        it('kills the child and returns true for a running task', async () => {
            const task = makeTask({ id: 'cancel-me' });
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            const killed = adapter.cancel('cancel-me');
            expect(killed).toBe(true);
            expect(child.killed).toBe(true);

            // Settle the promise
            child.emit('close', null, 'SIGTERM');
            await p.catch(() => {});
        });
    });

    // ─── _defaultSummary() via formatResult ─────────────────────
    describe('_defaultSummary()', () => {
        it('returns last line of stdout as summary', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            const child = lastSpawnResult!;

            child.stdout.emit('data', Buffer.from('first\nsecond\nthird\n'));
            child.emit('close', 0, null);

            const result = await p;
            expect(result.summary).toBe('third');
        });

        it('returns fallback message when stdout is empty', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.stdout.emit('data', Buffer.from(''));
            lastSpawnResult!.emit('close', 0, null);

            const result = await p;
            expect(result.summary).toContain('没有输出内容');
        });

        it('truncates summary at 500 chars', async () => {
            const task = makeTask();
            const p = adapter.execute(task);

            const longLine = 'x'.repeat(600);
            lastSpawnResult!.stdout.emit('data', Buffer.from(`short\n${longLine}\n`));
            lastSpawnResult!.emit('close', 0, null);

            const result = await p;
            expect(result.summary.length).toBeLessThanOrEqual(503); // 500 + '...'
            expect(result.summary.endsWith('...')).toBe(true);
        });
    });

    // ─── logLabel() ─────────────────────────────────────────────
    describe('logLabel()', () => {
        it('uses worker name in error messages', async () => {
            const task = makeTask();
            const p = adapter.execute(task);
            lastSpawnResult!.emit('close', 1, null);

            await expect(p).rejects.toThrow('Stub');
        });
    });
});
