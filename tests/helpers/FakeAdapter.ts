import { ExecuteOptions, IWorkerAdapter, ProgressChunk, Task, TaskResult, Worker } from '../../src/types';

type Pending = {
    resolve: (result: TaskResult) => void;
    reject: (error: unknown) => void;
    task: Task;
    onProgress?: (chunk: ProgressChunk) => void;
};

/**
 * Test double for IWorkerAdapter.
 *
 * - `execute()` returns a Promise the test can settle manually via
 *   `completeWith(result)` / `failWith(err)`, so the orchestrator state
 *   machine can be driven step-by-step.
 * - `cancel(taskId)` rejects the pending promise and records the call, matching
 *   how BaseCliWorkerAdapter would react when a user cancels.
 * - `disconnect()` rejects any in-flight promise and flips the worker status,
 *   so tests can assert the shutdown path.
 */
export class FakeAdapter implements IWorkerAdapter {
    readonly worker: Worker;

    public connectCalls = 0;
    public disconnectCalls = 0;
    public readonly executedTasks: Task[] = [];
    public readonly canceledTaskIds: string[] = [];

    private _pending: Pending | null = null;
    private _nextConnectError: unknown;
    private _hasNextConnectError = false;

    constructor(id: string, name: string = id, type: Worker['type'] = 'mcp') {
        this.worker = { id, name, type, status: 'disconnected' };
    }

    async connect(): Promise<void> {
        this.connectCalls++;
        if (this._hasNextConnectError) {
            const err = this._nextConnectError;
            this._hasNextConnectError = false;
            this._nextConnectError = undefined;
            // Real adapters leave status alone on connect failure.
            throw err;
        }
        this.worker.status = 'available';
    }

    /** Make the next connect() call throw. Tests use this to simulate a CLI that's temporarily down. */
    setNextConnectError(error: unknown): void {
        this._nextConnectError = error;
        this._hasNextConnectError = true;
    }

    async disconnect(): Promise<void> {
        this.disconnectCalls++;
        if (this._pending) {
            const p = this._pending;
            this._pending = null;
            p.reject(new Error('adapter disconnected'));
        }
        this.worker.status = 'disconnected';
    }

    execute(task: Task, opts?: ExecuteOptions): Promise<TaskResult> {
        this.executedTasks.push(task);
        return new Promise<TaskResult>((resolve, reject) => {
            this._pending = { resolve, reject, task, onProgress: opts?.onProgress };
        });
    }

    /**
     * Drive a partial-output chunk through the captured onProgress callback,
     * simulating a streaming worker. No-op if no execute() is pending or
     * the orchestrator did not pass an onProgress (e.g. legacy code path).
     */
    streamChunk(text: string): void {
        const p = this._pending;
        if (!p || !p.onProgress) return;
        p.onProgress({ text });
    }

    cancel(taskId: string): boolean {
        this.canceledTaskIds.push(taskId);
        if (this._pending && this._pending.task.id === taskId) {
            const p = this._pending;
            this._pending = null;
            p.reject(new Error('canceled'));
            return true;
        }
        return false;
    }

    // === Test helpers ===

    /** Resolve the currently pending execute() call. */
    completeWith(result: Partial<TaskResult> = {}): void {
        const p = this._pending;
        if (!p) throw new Error(`FakeAdapter(${this.worker.id}): no pending execute() to complete`);
        this._pending = null;
        p.resolve({
            summary: 'ok',
            artifacts: [],
            logs: [],
            ...result
        });
    }

    /** Reject the currently pending execute() call. */
    failWith(error: unknown): void {
        const p = this._pending;
        if (!p) throw new Error(`FakeAdapter(${this.worker.id}): no pending execute() to fail`);
        this._pending = null;
        p.reject(error);
    }

    get hasPending(): boolean {
        return this._pending !== null;
    }

    get pendingTaskId(): string | null {
        return this._pending?.task.id ?? null;
    }
}

/**
 * Flush pending microtasks so `adapter.execute().then(...)` callbacks in the
 * Orchestrator run before the assertion block.
 */
export async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
