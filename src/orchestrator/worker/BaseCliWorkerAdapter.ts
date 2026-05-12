import { execFile, spawn, ChildProcess, SpawnOptions } from 'child_process';
import { Artifact, ExecuteOptions, IWorkerAdapter, Task, TaskResult, Worker } from '../../types';
import { extractArtifacts } from './outputParser';

/**
 * Common plumbing for CLI-backed worker adapters:
 *   - spawn a child process per task
 *   - track in-flight children so cancel()/disconnect() can kill them
 *   - optional version-probe on connect()
 *
 * Subclasses implement the small CLI-specific hooks (argv, cwd, result formatting).
 */
export abstract class BaseCliWorkerAdapter implements IWorkerAdapter {
    readonly worker: Worker;
    protected readonly _running = new Map<string, ChildProcess>();

    constructor(id: string, name: string, type: Worker['type']) {
        this.worker = { id, name, type, status: 'disconnected' };
    }

    // === Required hooks ===
    protected abstract getCliPath(): string;
    protected abstract buildArgs(task: Task): string[];

    // === Optional hooks ===
    /** Working directory for spawned children. Undefined inherits the extension host's cwd. */
    protected getSpawnCwd(): string | undefined {
        return undefined;
    }

    /**
     * Extra environment variables to merge on top of `process.env` for the
     * spawned child. Returning `undefined` (default) means inherit the parent
     * environment unchanged. Subclasses use this to inject relay endpoints
     * (e.g. `OPENAI_BASE_URL`) and the user's relay auth token.
     */
    protected getSpawnEnv(): NodeJS.ProcessEnv | undefined {
        return undefined;
    }

    /** Whether connect() should probe `cli --version` before marking the worker available. */
    protected shouldProbeVersion(): boolean {
        return true;
    }

    /** Format a successful run into a TaskResult. Override for CLI-specific summaries. */
    protected formatResult(stdout: string, _stderr: string): TaskResult {
        const logs = stdout.split('\n').filter(Boolean);
        return {
            summary: this._defaultSummary(stdout),
            artifacts: this.parseArtifacts(stdout),
            logs
        };
    }

    /**
     * Extract code snippets and file diffs from CLI output. Exposed so subclasses
     * that override formatResult (e.g. to keep a legacy summary format) can still
     * opt in to artifact extraction.
     */
    protected parseArtifacts(stdout: string): Artifact[] {
        return extractArtifacts(stdout);
    }

    /** Human label used in console log messages (defaults to worker name). */
    protected logLabel(): string {
        return this.worker.name;
    }

    // === IWorkerAdapter implementation ===
    async connect(): Promise<void> {
        if (!this.shouldProbeVersion()) {
            this.worker.status = 'available';
            console.log(`${this.logLabel()} 可用。`);
            return;
        }
        const cli = this.getCliPath();
        return new Promise(resolve => {
            execFile(cli, ['--version'], (error, stdout) => {
                if (error) {
                    console.error(`${this.logLabel()} 命令行程序不可用（${cli}）：`, error.message);
                    this.worker.status = 'disconnected';
                } else {
                    console.log(`${this.logLabel()} 命令行程序已检测到：${stdout.trim()}`);
                    this.worker.status = 'available';
                }
                resolve();
            });
        });
    }

    async disconnect(): Promise<void> {
        for (const [, child] of this._running) {
            try { child.kill(); } catch { /* noop */ }
        }
        this._running.clear();
        this.worker.status = 'disconnected';
    }

    execute(task: Task, opts?: ExecuteOptions): Promise<TaskResult> {
        const cli = this.getCliPath();
        const args = this.buildArgs(task);
        const cwd = this.getSpawnCwd();
        const extraEnv = this.getSpawnEnv();

        const spawnOpts: SpawnOptions = {
            stdio: ['ignore', 'pipe', 'pipe']
        };
        if (cwd) {
            spawnOpts.cwd = cwd;
        }
        if (extraEnv) {
            spawnOpts.env = { ...process.env, ...extraEnv };
        }

        const onProgress = opts?.onProgress;

        return new Promise((resolve, reject) => {
            const child = spawn(cli, args, spawnOpts);
            this._running.set(task.id, child);

            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', chunk => {
                const text = chunk.toString();
                stdout += text;
                // Forward live stdout to the orchestrator so the webview can
                // show partial output as it streams. Listener errors are
                // swallowed; failure to render UI must never fail a task.
                if (onProgress) {
                    try { onProgress({ text }); } catch { /* noop */ }
                }
            });
            child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

            child.on('error', err => {
                this._running.delete(task.id);
                reject(err);
            });

            child.on('close', (code, signal) => {
                this._running.delete(task.id);
                if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                    reject(new Error(`${this.logLabel()} 任务已取消（信号 ${signal}）`));
                    return;
                }
                if (code !== 0) {
                    reject(new Error(
                        `${this.logLabel()} 退出码为 ${code}：${stderr.trim() || stdout.trim() || '无输出'}`
                    ));
                    return;
                }
                if (stderr) {
                    console.warn(`${this.logLabel()} 标准错误输出：${stderr}`);
                }
                resolve(this.formatResult(stdout, stderr));
            });
        });
    }

    cancel(taskId: string): boolean {
        const child = this._running.get(taskId);
        if (!child) return false;
        const killed = child.kill();
        if (killed) {
            this._running.delete(taskId);
        }
        return killed;
    }

    // === Helpers ===
    protected _defaultSummary(stdout: string): string {
        const trimmed = stdout.trim();
        if (!trimmed) return `${this.logLabel()} 已完成，但没有输出内容。`;
        const lines = trimmed.split('\n').filter(Boolean);
        const last = lines[lines.length - 1];
        return last.length > 500 ? last.substring(0, 500) + '...' : last;
    }
}
