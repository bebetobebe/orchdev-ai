import { EventEmitter } from "../events";
import { Artifact, IWorkerAdapter, Session, Task, TaskRecovery, TaskResult, Worker } from "../types";
import { calculateRecoveryDelayMs, classifyInterruption, createTaskRecovery } from "./interruptionRecovery";

export interface SerializedState {
    sessions: Session[];
    tasks: Task[];
}

export type DispatchTaskResult = 'started' | 'queued' | 'task-not-found' | 'worker-not-found' | 'worker-disconnected' | 'task-not-pending';
export type CancelTaskResult = 'canceled' | 'task-not-found' | 'task-not-cancelable';
export type CreateSessionResult = 'created' | 'name-required' | 'goal-required' | 'name-and-goal-required';
export interface CreateSessionOutcome {
    result: CreateSessionResult;
    session?: Session;
}
export type CreateTaskResult = 'created' | 'session-not-found' | 'prompt-empty';
export interface CreateTaskOutcome {
    result: CreateTaskResult;
    task?: Task;
}
export type DeleteSessionResult = 'deleted' | 'session-not-found';
export type SummarizeSessionResult = 'summarized' | 'session-not-found' | 'no-completed-tasks' | 'worker-not-found';
export interface SummarizeSessionOutcome {
    result: SummarizeSessionResult;
    summary?: string;
}
export type RetryAllFailedResult = 'retried' | 'session-not-found' | 'no-retryable-tasks';
export interface RetryAllFailedOutcome {
    result: RetryAllFailedResult;
    retriedCount?: number;
}
export type CancelAllTasksResult = 'canceled' | 'session-not-found' | 'no-cancelable-tasks';
export interface CancelAllTasksOutcome {
    result: CancelAllTasksResult;
    canceledCount?: number;
}
export type UpdateSessionResult = 'updated' | 'session-not-found' | 'empty-update';
export type UpdateTaskPromptResult = 'updated' | 'task-not-found' | 'task-not-editable' | 'prompt-empty';
export type DeleteTaskResult = 'deleted' | 'task-not-found' | 'task-not-deletable';
export type RetryTaskResult = 'retried' | 'task-not-found' | 'task-not-retryable';
export type CloneTaskResult = 'cloned' | 'task-not-found' | 'session-not-found';
export interface CloneTaskOutcome {
    result: CloneTaskResult;
    task?: Task;
}
export type ConnectWorkerResult = 'connected' | 'worker-not-found' | 'worker-already-connected' | 'worker-still-disconnected';
export type DisconnectWorkerResult = 'disconnected' | 'worker-not-found' | 'worker-already-disconnected' | 'worker-busy' | 'worker-still-connected';
export interface RecoveryOptions {
    autoRetry: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
    autoRetry: true,
    maxRetries: 3,
    baseDelayMs: 10_000,
    maxDelayMs: 30_000,
};

interface RetryDelay {
    timer: ReturnType<typeof setTimeout>;
    resolve: (shouldRetry: boolean) => void;
}

const TASK_MODES = new Set<Task['mode']>(['Ask', 'Plan', 'Execute']);
const TASK_STATUSES = new Set<Task['status']>(['pending', 'queued', 'running', 'completed', 'failed', 'canceled']);
const RECOVERY_TYPES = new Set<TaskRecovery['type']>([
    'quota-exhausted',
    'rate-limited',
    'response-truncated',
    'tool-limit',
    'terminal-stuck',
    'authorization-required',
    'network',
    'internal',
    'provider-overloaded',
    'version-outdated',
    'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionalFiniteTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeRecovery(value: unknown): TaskRecovery | undefined {
    if (!isRecord(value)) return undefined;
    const type = RECOVERY_TYPES.has(value.type as TaskRecovery['type'])
        ? value.type as TaskRecovery['type']
        : 'unknown';
    const title = nonEmptyString(value.title) ?? '恢复提示';
    const message = typeof value.message === 'string' ? value.message : '';
    const action = typeof value.action === 'string' ? value.action : '';
    const recovery: TaskRecovery = {
        type,
        title,
        message,
        action,
        retryable: value.retryable === true,
        autoRetry: value.autoRetry === true,
    };
    if (typeof value.attempt === 'number' && Number.isFinite(value.attempt)) recovery.attempt = Math.max(0, Math.floor(value.attempt));
    if (typeof value.maxAttempts === 'number' && Number.isFinite(value.maxAttempts)) recovery.maxAttempts = Math.max(0, Math.floor(value.maxAttempts));
    if (typeof value.delayMs === 'number' && Number.isFinite(value.delayMs)) recovery.delayMs = Math.max(0, value.delayMs);
    if (typeof value.nextRetryAt === 'number' && Number.isFinite(value.nextRetryAt)) recovery.nextRetryAt = value.nextRetryAt;
    return recovery;
}

function sanitizeTaskResult(value: unknown): TaskResult | undefined {
    if (!isRecord(value)) return undefined;
    const summary = typeof value.summary === 'string' ? value.summary : '';
    const artifacts: Artifact[] = Array.isArray(value.artifacts)
        ? value.artifacts.flatMap(artifact => {
            if (!isRecord(artifact)) return [];
            const type: Artifact['type'] | undefined = artifact.type === 'file' || artifact.type === 'snippet' ? artifact.type : undefined;
            const name = nonEmptyString(artifact.name);
            const content = typeof artifact.content === 'string' ? artifact.content : '';
            return type && name ? [{ type, name, content }] : [];
        })
        : [];
    const logs = Array.isArray(value.logs)
        ? value.logs.filter((log): log is string => typeof log === 'string')
        : [];
    const modifiedFiles = Array.isArray(value.modifiedFiles)
        ? value.modifiedFiles.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
        : undefined;
    const recovery = sanitizeRecovery(value.recovery);
    return {
        summary,
        artifacts,
        logs,
        ...(modifiedFiles && modifiedFiles.length > 0 ? { modifiedFiles } : {}),
        ...(recovery ? { recovery } : {}),
    };
}

function normalizeTaskResult(value: unknown, fallbackSummary: string): TaskResult {
    const sanitized = sanitizeTaskResult(value);
    if (!sanitized) {
        return {
            summary: fallbackSummary,
            artifacts: [],
            logs: [],
        };
    }
    return {
        ...sanitized,
        summary: sanitized.summary.trim() || fallbackSummary,
    };
}

export class Orchestrator {
    private static _instance: Orchestrator;

    private _sessions: Map<string, Session> = new Map();
    private _tasks: Map<string, Task> = new Map();
    private _workerAdapters: Map<string, IWorkerAdapter> = new Map();
    /** Per-worker FIFO queue of task IDs waiting for execution. */
    private _queues: Map<string, string[]> = new Map();
    public readonly onStateChange = new EventEmitter();
    private _onSave?: () => void;
    /** Periodic reconnection sweep for workers that went 'disconnected'. */
    private _healthCheckTimer?: ReturnType<typeof setInterval>;
    /** Guards against overlapping reconnect attempts per worker. */
    private _reconnecting: Set<string> = new Set();
    /** When true, completing a task auto-dispatches the next pending task in the same session to the same worker. */
    private _autoChain: boolean = false;
    private _recoveryOptions: RecoveryOptions = { ...DEFAULT_RECOVERY_OPTIONS };
    private _retryDelays: Map<string, RetryDelay> = new Map();

    private constructor() {
        // Private constructor for singleton pattern
    }

    public static getInstance(): Orchestrator {
        if (!Orchestrator._instance) {
            Orchestrator._instance = new Orchestrator();
        }
        return Orchestrator._instance;
    }

    public get autoChain(): boolean { return this._autoChain; }
    public set autoChain(value: boolean) {
        if (this._autoChain === value) return;
        this._autoChain = value;
        this.onStateChange.emit();
        this.triggerSave();
    }

    public get recoveryOptions(): RecoveryOptions {
        return { ...this._recoveryOptions };
    }

    public configureRecovery(options: Partial<RecoveryOptions>): void {
        this._recoveryOptions = {
            ...this._recoveryOptions,
            ...options,
            maxRetries: Math.max(0, options.maxRetries ?? this._recoveryOptions.maxRetries),
            baseDelayMs: Math.max(0, options.baseDelayMs ?? this._recoveryOptions.baseDelayMs),
            maxDelayMs: Math.max(0, options.maxDelayMs ?? this._recoveryOptions.maxDelayMs),
        };
        if (this._recoveryOptions.maxDelayMs < this._recoveryOptions.baseDelayMs) {
            this._recoveryOptions.maxDelayMs = this._recoveryOptions.baseDelayMs;
        }
    }

    /**
     * Test-only: wipe the singleton so each spec starts from a clean state.
     * Do not call in production code — the name is prefixed with `__` as a
     * reminder. Any running adapters are NOT disconnected; callers must clean
     * those up themselves (or pass pure FakeAdapters, as the unit tests do).
     */
    public static __resetForTesting(): void {
        Orchestrator._instance = undefined as unknown as Orchestrator;
    }

    public setOnSave(callback: () => void): void {
        this._onSave = callback;
    }

    private triggerSave(): void {
        this._onSave?.();
    }

    // === Session Management ===
    public createSession(name: string, goal: string): Session | undefined {
        return this.createSessionWithResult(name, goal).session;
    }

    public createSessionWithResult(name: string, goal: string): CreateSessionOutcome {
        const trimmedName = name?.trim();
        const trimmedGoal = goal?.trim();
        if (!trimmedName && !trimmedGoal) return { result: 'name-and-goal-required' };
        if (!trimmedName) return { result: 'name-required' };
        if (!trimmedGoal) return { result: 'goal-required' };
        const id = this.generateId();
        const newSession: Session = {
            id,
            name: trimmedName,
            goal: trimmedGoal,
            createdAt: Date.now(),
            taskIds: []
        };
        this._sessions.set(id, newSession);
        this.onStateChange.emit();
        this.triggerSave();
        return { result: 'created', session: newSession };
    }

    public getSession(id: string): Session | undefined {
        return this._sessions.get(id);
    }

    public getAllSessions(): Session[] {
        return Array.from(this._sessions.values());
    }

    /** Compute per-session task status counts. */
    public getSessionStats(): Record<string, Record<string, number>> {
        const stats: Record<string, Record<string, number>> = {};
        for (const [, session] of this._sessions) {
            const counts: Record<string, number> = { total: 0, pending: 0, queued: 0, running: 0, completed: 0, failed: 0, canceled: 0 };
            for (const taskId of session.taskIds) {
                const task = this._tasks.get(taskId);
                if (!task) continue;
                counts.total++;
                counts[task.status] = (counts[task.status] || 0) + 1;
            }
            stats[session.id] = counts;
        }
        return stats;
    }

    /**
     * Update a session's name and/or goal. At least one non-empty field is
     * required.
     */
    public updateSession(sessionId: string, name?: string, goal?: string): UpdateSessionResult {
        const session = this._sessions.get(sessionId);
        if (!session) return 'session-not-found';

        const trimmedName = name?.trim();
        const trimmedGoal = goal?.trim();

        // At least one field must change
        if (!trimmedName && !trimmedGoal) return 'empty-update';

        if (trimmedName) session.name = trimmedName;
        if (trimmedGoal) session.goal = trimmedGoal;

        this.onStateChange.emit();
        this.triggerSave();
        return 'updated';
    }

    public async summarizeSession(sessionId: string, workerId: string): Promise<void> {
        const outcome = await this.summarizeSessionWithResult(sessionId, workerId);
        if (outcome.result === 'worker-not-found') {
            throw new Error(`执行器 ${workerId} 当前不可用于生成摘要。`);
        }
    }

    public async summarizeSessionWithResult(sessionId: string, workerId: string): Promise<SummarizeSessionOutcome> {
        const session = this.getSession(sessionId);
        if (!session) return { result: 'session-not-found' };

        const tasks = this.getTasksForSession(sessionId).filter(t => t.status === 'completed');
        if (tasks.length === 0) return { result: 'no-completed-tasks' };

        const contextToSummarize = tasks
            .map(t => `任务：${t.prompt}\n结果：${t.result?.summary ?? '无结果'}`)
            .join('\n\n');
        const summaryPrompt = `请根据以下任务记录生成一段简洁的中文会话摘要：\n\n${contextToSummarize}`;

        // Session existence was already checked at the top of this method.
        const summaryTask = this.createTask(sessionId, summaryPrompt, 'Ask')!;
        summaryTask.status = 'running'; // Mark as running immediately
        this.onStateChange.emit();

        const adapter = this._workerAdapters.get(workerId);
        if (!adapter) {
            summaryTask.status = 'failed';
            this.onStateChange.emit();
            this.triggerSave();
            return { result: 'worker-not-found' };
        }

        adapter.worker.status = 'busy';
        this.onStateChange.emit();

        try {
            const result = normalizeTaskResult(
                await adapter.execute(summaryTask),
                '执行器已返回，但没有生成有效摘要。'
            );
            session.summary = result.summary;
            this._tasks.delete(summaryTask.id);
            session.taskIds = session.taskIds.filter(id => id !== summaryTask.id);
            adapter.worker.status = 'available';
            this.onStateChange.emit();
            this.triggerSave();
            return { result: 'summarized', summary: result.summary };
        } catch (error) {
            summaryTask.status = 'failed';
            adapter.worker.status = 'available';
            this.onStateChange.emit();
            this.triggerSave();
            console.error(`Summarization task for session ${sessionId} failed:`, error);
            throw error;
        }
    }

    // === Task Management ===
    public createTask(sessionId: string, prompt: string, mode: Task['mode']): Task | undefined {
        return this.createTaskWithResult(sessionId, prompt, mode).task;
    }

    public createTaskWithResult(sessionId: string, prompt: string, mode: Task['mode']): CreateTaskOutcome {
        const trimmedPrompt = prompt?.trim();
        if (!trimmedPrompt) return { result: 'prompt-empty' };
        const session = this._sessions.get(sessionId);
        if (!session) {
            console.warn(`createTask: session ${sessionId} does not exist; task not created.`);
            return { result: 'session-not-found' };
        }
        const id = this.generateId();
        const newTask: Task = {
            id,
            sessionId,
            prompt: trimmedPrompt,
            mode,
            status: 'pending',
            createdAt: Date.now(),
        };
        this._tasks.set(id, newTask);
        session.taskIds.push(id);
        this.onStateChange.emit();
        this.triggerSave();
        return { result: 'created', task: newTask };
    }

    public getTask(id: string): Task | undefined {
        return this._tasks.get(id);
    }

    public getTasksForSession(sessionId: string): Task[] {
        const session = this._sessions.get(sessionId);
        if (!session) {
            return [];
        }
        return session.taskIds.map(taskId => this._tasks.get(taskId)).filter(Boolean) as Task[];
    }

    // === Worker Management ===
    public registerWorkerAdapter(adapter: IWorkerAdapter): void {
        this._workerAdapters.set(adapter.worker.id, adapter);
        this.onStateChange.emit();
    }

    public unregisterWorkerAdapter(workerId: string): void {
        const adapter = this._workerAdapters.get(workerId);
        if (!adapter) return;
        // Release any queued tasks back to pending (they can be re-dispatched elsewhere)
        const queue = this._queues.get(workerId) ?? [];
        for (const queuedId of queue) {
            const qTask = this._tasks.get(queuedId);
            if (qTask && qTask.status === 'queued') {
                this._clearRetryDelay(queuedId);
                qTask.status = 'pending';
                qTask.workerId = undefined;
                qTask.recovery = undefined;
            }
        }
        this._queues.delete(workerId);

        // Attempt graceful disconnect; ignore errors
        Promise.resolve(adapter.disconnect()).catch(() => { /* noop */ });
        this._workerAdapters.delete(workerId);
        this.onStateChange.emit();
        this.triggerSave();
    }

    public hasWorkerAdapter(workerId: string): boolean {
        return this._workerAdapters.has(workerId);
    }

    /**
     * Graceful teardown called from the extension's deactivate() hook.
     * - Kills every live child process by disconnecting adapters.
     * - Marks any still-running / queued tasks as failed so state is not left
     *   mid-flight across extension reloads.
     * - Triggers one final save so the marker changes are persisted.
     */
    public async shutdown(): Promise<void> {
        // 0. Stop the reconnect sweep so it doesn't race with disconnect().
        this.stopHealthCheck();
        for (const taskId of Array.from(this._retryDelays.keys())) {
            this._clearRetryDelay(taskId);
        }

        // 1. Mark in-flight tasks as failed before killing their processes,
        //    so downstream save sees the final state.
        const shutdownMsg = '扩展已停用，任务在执行过程中被中断。';
        const now = Date.now();
        for (const task of this._tasks.values()) {
            if (task.status === 'running' || task.status === 'queued') {
                this._clearRetryDelay(task.id);
                task.status = 'failed';
                task.result = {
                    summary: shutdownMsg,
                    artifacts: [],
                    logs: []
                };
                task.completedAt = now;
                task.recovery = undefined;
            }
        }

        // 2. Disconnect every adapter in parallel; each kills its child procs.
        const adapters = Array.from(this._workerAdapters.values());
        await Promise.all(
            adapters.map(a =>
                Promise.resolve(a.disconnect()).catch(err => {
                    console.warn(`shutdown: adapter ${a.worker.id} disconnect failed:`, err);
                })
            )
        );

        // 3. Clear runtime-only state; sessions/tasks persist via onSave.
        this._workerAdapters.clear();
        this._queues.clear();

        // 4. Final flush — onSave host may ignore errors, but we must try.
        try {
            this.triggerSave();
        } catch (err) {
            console.warn('shutdown: final save failed:', err);
        }
    }

    public getWorker(id: string): Worker | undefined {
        return this._workerAdapters.get(id)?.worker;
    }

    public getAllWorkers(): Worker[] {
        return Array.from(this._workerAdapters.values()).map(a => a.worker);
    }

    public async connectWorker(workerId: string): Promise<ConnectWorkerResult> {
        const adapter = this._workerAdapters.get(workerId);
        if (!adapter) {
            return 'worker-not-found';
        }

        if (adapter.worker.status !== 'disconnected') {
            return 'worker-already-connected';
        }

        await adapter.connect();
        const postConnectStatus = this.getWorker(workerId)?.status;
        if (postConnectStatus === 'available') {
            this.onStateChange.emit();
            return 'connected';
        }

        return 'worker-still-disconnected';
    }

    public async disconnectWorker(workerId: string): Promise<DisconnectWorkerResult> {
        const adapter = this._workerAdapters.get(workerId);
        if (!adapter) {
            return 'worker-not-found';
        }

        if (adapter.worker.status === 'disconnected') {
            return 'worker-already-disconnected';
        }

        if (adapter.worker.status === 'busy') {
            return 'worker-busy';
        }

        await adapter.disconnect();
        const postDisconnectStatus = this.getWorker(workerId)?.status;
        if (postDisconnectStatus === 'disconnected') {
            this.onStateChange.emit();
            return 'disconnected';
        }

        return 'worker-still-connected';
    }

    // === Worker Health Check & Auto-Reconnect ===

    /**
     * Run a single reconnect sweep. Kicks `connect()` on every adapter that is
     * currently `disconnected`, guarding against overlapping attempts per
     * worker. Errors are swallowed — a failing adapter simply stays
     * disconnected until the next sweep.
     *
     * Returns a promise that resolves after every in-flight reconnect attempt
     * settles, which makes it straightforward to drive from unit tests.
     */
    public async runHealthCheckOnce(): Promise<void> {
        const attempts: Promise<void>[] = [];
        for (const [id, adapter] of this._workerAdapters) {
            if (adapter.worker.status !== 'disconnected') continue;
            if (this._reconnecting.has(id)) continue;

            this._reconnecting.add(id);
            const p = Promise.resolve(adapter.connect())
                .then(() => {
                    if (adapter.worker.status === 'available') {
                        this.onStateChange.emit();
                        // If there were tasks pinned to this worker queue
                        // (unlikely, since unregister clears them), kick them.
                        this._dequeueNext(adapter);
                    }
                })
                .catch(() => { /* silent — stays disconnected */ })
                .finally(() => { this._reconnecting.delete(id); });
            attempts.push(p);
        }
        await Promise.all(attempts);
    }

    /**
     * Start a periodic health-check sweep. An intervalMs <= 0 disables the
     * sweep (useful for tests or users who want manual-only reconnects).
     * Safe to call multiple times — the previous timer is replaced.
     */
    public startHealthCheck(intervalMs: number): void {
        this.stopHealthCheck();
        if (!intervalMs || intervalMs <= 0) return;
        this._healthCheckTimer = setInterval(() => {
            void this.runHealthCheckOnce();
        }, intervalMs);
    }

    public stopHealthCheck(): void {
        if (this._healthCheckTimer) {
            clearInterval(this._healthCheckTimer);
            this._healthCheckTimer = undefined;
        }
    }

    public async dispatchTask(taskId: string, workerId: string): Promise<DispatchTaskResult> {
        const task = this.getTask(taskId);
        const adapter = this._workerAdapters.get(workerId);

        if (!task) {
            console.error(`派发失败：未找到任务或执行器（${taskId}, ${workerId}）。`);
            return 'task-not-found';
        }

        if (!adapter) {
            console.error(`派发失败：未找到任务或执行器（${taskId}, ${workerId}）。`);
            return 'worker-not-found';
        }

        if (adapter.worker.status === 'disconnected') {
            console.warn(`执行器 ${workerId} 已断开，任务 ${taskId} 保持待处理。`);
            return 'worker-disconnected';
        }

        // Ignore re-dispatch of tasks already in progress/queued/finished
        if (task.status !== 'pending') {
            console.warn(`任务 ${taskId} 当前状态为 ${task.status}，已忽略重复派发。`);
            return 'task-not-pending';
        }

        if (adapter.worker.status === 'busy') {
            this._enqueue(workerId, task);
            return 'queued';
        }

        this._startExecution(task, adapter);
        return 'started';
    }

    /** Returns the queue length for a given worker (for auto-dispatch balancing). */
    public getQueueLength(workerId: string): number {
        return this._queues.get(workerId)?.length ?? 0;
    }

    /** Pick the best worker for auto-dispatch: first available, otherwise the one with the shortest queue. */
    public pickAutoDispatchWorker(): Worker | undefined {
        const workers = this.getAllWorkers().filter(w => w.status !== 'disconnected');
        if (workers.length === 0) return undefined;
        const available = workers.find(w => w.status === 'available');
        if (available) return available;
        // All busy: pick the one with the smallest queue
        return workers.reduce((best, w) =>
            this.getQueueLength(w.id) < this.getQueueLength(best.id) ? w : best
        );
    }

    private _enqueue(workerId: string, task: Task): void {
        const queue = this._queues.get(workerId) ?? [];
        queue.push(task.id);
        this._queues.set(workerId, queue);
        task.status = 'queued';
        task.workerId = workerId;
        this.onStateChange.emit();
        this.triggerSave();
    }

    private _startExecution(task: Task, adapter: IWorkerAdapter): void {
        this._clearRetryDelay(task.id);
        task.status = 'running';
        task.workerId = adapter.worker.id;
        adapter.worker.status = 'busy';
        // Reset any partial output left over from a previous run (retry).
        task.result = undefined;
        task.completedAt = undefined;
        task.streamingOutput = undefined;
        this.onStateChange.emit();
        this.triggerSave();

        // Throttle onStateChange emits during streaming so a fast SSE feed
        // doesn't flood the webview with hundreds of postMessage calls per
        // second. The latest text is always already on `task.streamingOutput`,
        // so we just coalesce notifications into one per ~50ms tick.
        let pendingEmit = false;
        const scheduleEmit = () => {
            if (pendingEmit) return;
            pendingEmit = true;
            setTimeout(() => {
                pendingEmit = false;
                // Stop emitting once the task has reached a terminal state \u2014 the
                // resolve/reject branch below will fire its own final emit.
                if (task.status !== 'running') return;
                this.onStateChange.emit();
            }, 50);
        };

        adapter.execute(task, {
            onProgress: (chunk) => {
                // Drop late chunks arriving after cancel; nothing to display.
                if (task.status !== 'running') return;
                if (!chunk || typeof chunk.text !== 'string' || chunk.text.length === 0) return;
                task.streamingOutput = (task.streamingOutput ?? '') + chunk.text;
                scheduleEmit();
            },
        }).then(result => {
            if (task.status === 'canceled') {
                task.streamingOutput = undefined;
                task.recovery = undefined;
                this.onStateChange.emit();
                this.triggerSave();
                this._dequeueNext(adapter);
                return;
            }
            task.status = 'completed';
            task.result = normalizeTaskResult(result, '执行器已结束，但没有返回有效摘要。');
            task.recovery = task.result.recovery;
            task.completedAt = Date.now();
            // Final result is now in `task.result`; the live preview is
            // redundant and would just confuse the webview's render branch.
            task.streamingOutput = undefined;
            adapter.worker.status = 'available';
            this.onStateChange.emit();
            this.triggerSave();
            this._dequeueNext(adapter);
            this._autoChainNext(task, adapter);
        }).catch(error => {
            const errMsg = error instanceof Error ? error.message : String(error);
            // If the task was already canceled, cancelTask() freed the worker
            // and may have started a new task. Don't touch worker status.
            if (task.status !== 'canceled') {
                adapter.worker.status = 'available';
            }
            if (task.status === 'canceled') {
                task.result = {
                    summary: `已取消：${errMsg}`,
                    artifacts: [],
                    logs: [errMsg]
                };
                task.recovery = undefined;
                task.completedAt = Date.now();
                task.streamingOutput = undefined;
                console.error(`任务 ${task.id} ${task.status}：`, error);
                this.onStateChange.emit();
                this.triggerSave();
                this._dequeueNext(adapter);
                return;
            }

            const completion = async () => {
                const recovered = await this._handleExecutionFailure(task, adapter, error);
                if (recovered) return;
                task.status = 'failed';
                if (!task.result) {
                    task.result = this._buildFailureResult(errMsg);
                }
                task.recovery = task.result.recovery ?? task.recovery;
                task.completedAt = Date.now();
                task.streamingOutput = undefined;
                console.error(`任务 ${task.id} ${task.status}：`, error);
                this.onStateChange.emit();
                this.triggerSave();
                this._dequeueNext(adapter);
            };
            void completion();
        });
    }

    private _buildFailureResult(errorText: string, recovery?: TaskRecovery): TaskResult {
        if (recovery) {
            return {
                summary: recovery.type === 'unknown' ? `错误：${errorText}` : `${recovery.title}：${recovery.message}`,
                artifacts: [],
                logs: [errorText],
                recovery,
            };
        }
        return {
            summary: `错误：${errorText}`,
            artifacts: [],
            logs: [errorText],
        };
    }

    private async _handleExecutionFailure(task: Task, adapter: IWorkerAdapter, error: unknown): Promise<boolean> {
        const errorText = error instanceof Error ? error.message : String(error);
        const hint = classifyInterruption(error);
        const previousAttempts = task.recovery?.autoRetry ? task.recovery.attempt ?? 0 : 0;
        const canAutoRetry = this._recoveryOptions.autoRetry
            && hint.retryable
            && hint.autoRetry
            && previousAttempts < this._recoveryOptions.maxRetries;

        if (!canAutoRetry) {
            task.status = 'failed';
            const recovery = createTaskRecovery(hint, {
                autoRetry: false,
                attempt: previousAttempts,
                maxAttempts: this._recoveryOptions.maxRetries,
            });
            task.result = this._buildFailureResult(errorText, recovery);
            task.recovery = recovery;
            return false;
        }

        const nextAttempt = previousAttempts + 1;
        const delayMs = calculateRecoveryDelayMs(hint, previousAttempts, {
            baseDelayMs: this._recoveryOptions.baseDelayMs,
            maxDelayMs: this._recoveryOptions.maxDelayMs,
        });
        const nextRetryAt = Date.now() + delayMs;
        const recovery = createTaskRecovery(hint, {
            autoRetry: true,
            attempt: nextAttempt,
            maxAttempts: this._recoveryOptions.maxRetries,
            delayMs,
            nextRetryAt,
        });

        task.status = 'queued';
        task.result = this._buildFailureResult(errorText, recovery);
        task.recovery = recovery;
        task.completedAt = undefined;
        task.streamingOutput = undefined;
        this.onStateChange.emit();
        this.triggerSave();
        this._dequeueNext(adapter);

        const shouldRetry = await this._waitForRetryWindow(task.id, delayMs);
        if (!shouldRetry) {
            return true;
        }
        if (task.status !== 'queued' || task.workerId !== adapter.worker.id) {
            return true;
        }
        if (adapter.worker.status === 'available') {
            this._startExecution(task, adapter);
            return true;
        }

        const queue = this._queues.get(adapter.worker.id) ?? [];
        if (!queue.includes(task.id)) {
            queue.push(task.id);
            this._queues.set(adapter.worker.id, queue);
            this.onStateChange.emit();
            this.triggerSave();
        }
        return true;
    }

    private _waitForRetryWindow(taskId: string, delayMs: number): Promise<boolean> {
        this._clearRetryDelay(taskId);
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this._retryDelays.delete(taskId);
                resolve(true);
            }, Math.max(0, delayMs));
            this._retryDelays.set(taskId, { timer, resolve });
        });
    }

    private _clearRetryDelay(taskId: string, shouldRetry: boolean = false): void {
        const pending = this._retryDelays.get(taskId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._retryDelays.delete(taskId);
        pending.resolve(shouldRetry);
    }

    /**
     * If auto-chain is enabled, find the next pending task in the same
     * session and dispatch it to the same worker.
     */
    private _autoChainNext(completedTask: Task, adapter: IWorkerAdapter): void {
        if (!this._autoChain) return;
        if (adapter.worker.status !== 'available') return;

        const session = this._sessions.get(completedTask.sessionId);
        if (!session) return;

        for (const taskId of session.taskIds) {
            const t = this._tasks.get(taskId);
            if (t && t.status === 'pending') {
                this.dispatchTask(t.id, adapter.worker.id);
                return;
            }
        }
    }

    private _dequeueNext(adapter: IWorkerAdapter): void {
        const workerId = adapter.worker.id;
        const queue = this._queues.get(workerId);
        if (!queue || queue.length === 0) return;
        if (adapter.worker.status !== 'available') return;

        // Skip tasks that are no longer pending-queued (canceled / deleted)
        while (queue.length > 0) {
            const nextId = queue.shift()!;
            const next = this._tasks.get(nextId);
            if (next && next.status === 'queued') {
                this._queues.set(workerId, queue);
                this._startExecution(next, adapter);
                return;
            }
        }
        this._queues.set(workerId, queue);
    }

    private _removeFromQueue(taskId: string, workerId: string): void {
        const queue = this._queues.get(workerId);
        if (!queue) return;
        const idx = queue.indexOf(taskId);
        if (idx >= 0) {
            queue.splice(idx, 1);
            this._queues.set(workerId, queue);
        }
    }

    // === Session & Task Deletion ===
    public deleteSession(sessionId: string): DeleteSessionResult {
        const session = this._sessions.get(sessionId);
        if (!session) return 'session-not-found';
        const freedWorkers: IWorkerAdapter[] = [];
        for (const taskId of session.taskIds) {
            const task = this._tasks.get(taskId);
            if (!task) continue;
            this._clearRetryDelay(taskId);

            if (task.status === 'running' && task.workerId) {
                task.status = 'canceled';
                const adapter = this._workerAdapters.get(task.workerId);
                if (adapter) {
                    adapter.worker.status = 'available';
                    if (typeof adapter.cancel === 'function') {
                        try { adapter.cancel(taskId); } catch { /* noop */ }
                    }
                    freedWorkers.push(adapter);
                }
            } else if (task.status === 'queued' && task.workerId) {
                task.status = 'canceled';
                this._removeFromQueue(taskId, task.workerId);
            }
            this._tasks.delete(taskId);
        }
        this._sessions.delete(sessionId);
        this.onStateChange.emit();
        this.triggerSave();
        // After freeing workers, kick their queues
        for (const adapter of freedWorkers) {
            this._dequeueNext(adapter);
        }
        return 'deleted';
    }

    public cancelTask(taskId: string): CancelTaskResult {
        const task = this._tasks.get(taskId);
        if (!task) return 'task-not-found';
        // Terminal states are no-ops — avoid unnecessary emit/save
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') return 'task-not-cancelable';
        this._clearRetryDelay(taskId);

        if (task.status === 'running') {
            task.status = 'canceled';
            // Try to terminate the underlying process if the adapter supports it
            if (task.workerId) {
                const adapter = this._workerAdapters.get(task.workerId);
                if (adapter) {
                    adapter.worker.status = 'available';
                    if (typeof adapter.cancel === 'function') {
                        try {
                            adapter.cancel(taskId);
                        } catch (e) {
                            console.warn(`Adapter cancel failed for task ${taskId}:`, e);
                        }
                    }
                    // Worker just freed; run next queued task
                    this._dequeueNext(adapter);
                }
            }
        } else if (task.status === 'queued') {
            // Remove from worker queue; leave workerId intact for reference
            if (task.workerId) {
                this._removeFromQueue(taskId, task.workerId);
            }
            task.status = 'canceled';
        } else if (task.status === 'pending') {
            task.status = 'canceled';
        }
        task.recovery = undefined;
        this.onStateChange.emit();
        this.triggerSave();
        return 'canceled';
    }

    /**
     * Update the prompt of a task that has not yet been dispatched.
     * Only `pending` tasks can be edited.
     */
    public updateTaskPrompt(taskId: string, newPrompt: string): UpdateTaskPromptResult {
        const task = this._tasks.get(taskId);
        if (!task) return 'task-not-found';
        if (task.status !== 'pending') return 'task-not-editable';
        const trimmedPrompt = newPrompt.trim();
        if (!trimmedPrompt) return 'prompt-empty';

        task.prompt = trimmedPrompt;
        this.onStateChange.emit();
        this.triggerSave();
        return 'updated';
    }

    /**
     * Remove a task that is no longer in flight. Only `pending`, `completed`,
     * `failed`, and `canceled` tasks can be deleted; `running` / `queued`
     * tasks must be canceled first.
     */
    public deleteTask(taskId: string): DeleteTaskResult {
        const task = this._tasks.get(taskId);
        if (!task) return 'task-not-found';
        if (task.status === 'running' || task.status === 'queued') return 'task-not-deletable';
        this._clearRetryDelay(taskId);

        // Remove from parent session's taskIds list
        const session = this._sessions.get(task.sessionId);
        if (session) {
            session.taskIds = session.taskIds.filter(id => id !== taskId);
        }

        this._tasks.delete(taskId);
        this.onStateChange.emit();
        this.triggerSave();
        return 'deleted';
    }

    /**
     * Reset a failed or canceled task back to `pending` so it can be
     * re-dispatched.
     */
    public retryTask(taskId: string): RetryTaskResult {
        const task = this._tasks.get(taskId);
        if (!task) return 'task-not-found';
        if (task.status !== 'failed' && task.status !== 'canceled') return 'task-not-retryable';
        this._clearRetryDelay(taskId);

        task.status = 'pending';
        task.result = undefined;
        task.completedAt = undefined;
        task.workerId = undefined;
        task.recovery = undefined;

        this.onStateChange.emit();
        this.triggerSave();
        return 'retried';
    }

    /**
     * Create a new pending copy of an existing task in the same session.
     * Useful for re-running a prompt on a different worker.
     */
    public cloneTask(taskId: string): CloneTaskOutcome {
        const original = this._tasks.get(taskId);
        if (!original) return { result: 'task-not-found' };

        const session = this._sessions.get(original.sessionId);
        if (!session) return { result: 'session-not-found' };

        const task = this.createTask(original.sessionId, original.prompt, original.mode);
        if (!task) return { result: 'session-not-found' };
        return { result: 'cloned', task };
    }

    /**
     * Retry all failed/canceled tasks in a session.
     * Returns the number of tasks retried.
     */
    public retryAllFailed(sessionId: string): number {
        return this.retryAllFailedWithResult(sessionId).retriedCount ?? 0;
    }

    public retryAllFailedWithResult(sessionId: string): RetryAllFailedOutcome {
        const session = this._sessions.get(sessionId);
        if (!session) return { result: 'session-not-found' };

        let count = 0;
        for (const taskId of session.taskIds) {
            const task = this._tasks.get(taskId);
            if (!task) continue;
            if (task.status !== 'failed' && task.status !== 'canceled') continue;
            this._clearRetryDelay(taskId);

            task.status = 'pending';
            task.result = undefined;
            task.completedAt = undefined;
            task.workerId = undefined;
            task.recovery = undefined;
            count++;
        }

        if (count > 0) {
            this.onStateChange.emit();
            this.triggerSave();
            return { result: 'retried', retriedCount: count };
        }
        return { result: 'no-retryable-tasks' };
    }

    /**
     * Cancel all pending tasks in a session. Running/queued tasks are also
     * canceled. Returns the number of tasks canceled.
     */
    public cancelAllTasks(sessionId: string): number {
        return this.cancelAllTasksWithResult(sessionId).canceledCount ?? 0;
    }

    public cancelAllTasksWithResult(sessionId: string): CancelAllTasksOutcome {
        const session = this._sessions.get(sessionId);
        if (!session) return { result: 'session-not-found' };

        let count = 0;
        for (const taskId of [...session.taskIds]) {
            const task = this._tasks.get(taskId);
            if (!task) continue;
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') continue;

            this.cancelTask(taskId);
            count++;
        }
        if (count > 0) {
            return { result: 'canceled', canceledCount: count };
        }
        return { result: 'no-cancelable-tasks' };
    }

    // === Persistence ===
    public serialize(): SerializedState {
        return {
            sessions: Array.from(this._sessions.values()),
            tasks: Array.from(this._tasks.values())
        };
    }

    public deserialize(state: SerializedState): void {
        this._sessions.clear();
        this._tasks.clear();
        this._queues.clear();
        for (const taskId of Array.from(this._retryDelays.keys())) {
            this._clearRetryDelay(taskId);
        }
        const now = Date.now();
        const rawSessions = Array.isArray(state?.sessions) ? state.sessions : [];
        const rawTasks = Array.isArray(state?.tasks) ? state.tasks : [];
        const sessionOrder: string[] = [];

        for (const rawSession of rawSessions) {
            if (!isRecord(rawSession)) continue;
            const id = nonEmptyString(rawSession.id);
            const name = nonEmptyString(rawSession.name);
            const goal = nonEmptyString(rawSession.goal);
            if (!id || !name || !goal || this._sessions.has(id)) continue;
            const taskIds = Array.isArray(rawSession.taskIds)
                ? rawSession.taskIds.filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
                : [];
            const session: Session = {
                id,
                name,
                goal,
                createdAt: finiteTimestamp(rawSession.createdAt, now),
                taskIds,
            };
            if (typeof rawSession.summary === 'string' && rawSession.summary.length > 0) {
                session.summary = rawSession.summary;
            }
            this._sessions.set(id, session);
            sessionOrder.push(id);
        }

        for (const rawTask of rawTasks) {
            if (!isRecord(rawTask)) continue;
            const id = nonEmptyString(rawTask.id);
            const sessionId = nonEmptyString(rawTask.sessionId);
            const prompt = nonEmptyString(rawTask.prompt);
            const mode = TASK_MODES.has(rawTask.mode as Task['mode']) ? rawTask.mode as Task['mode'] : undefined;
            const status = TASK_STATUSES.has(rawTask.status as Task['status']) ? rawTask.status as Task['status'] : undefined;
            if (!id || !sessionId || !prompt || !mode || !status || this._tasks.has(id) || !this._sessions.has(sessionId)) {
                continue;
            }

            const task: Task = {
                id,
                sessionId,
                prompt,
                mode,
                status,
                createdAt: finiteTimestamp(rawTask.createdAt, now),
            };
            const workerId = nonEmptyString(rawTask.workerId);
            if (workerId) {
                task.workerId = workerId;
            }
            const completedAt = optionalFiniteTimestamp(rawTask.completedAt);
            if (completedAt) {
                task.completedAt = completedAt;
            }
            const result = sanitizeTaskResult(rawTask.result);
            if (result) {
                task.result = result;
            }
            const recovery = sanitizeRecovery(rawTask.recovery) ?? task.result?.recovery;
            if (recovery) {
                task.recovery = recovery;
            }

            // Running tasks from a previous session are orphaned; mark them failed.
            if (task.status === 'running') {
                task.status = 'failed';
                task.workerId = undefined;
                task.completedAt = task.completedAt ?? now;
                task.result = this._buildFailureResult('扩展重启后中断，任务未继续执行。', task.recovery);
                task.recovery = undefined;
            }
            // Queued tasks lost their worker queue across restart; return them to pending.
            if (task.status === 'queued') {
                task.status = 'pending';
                task.workerId = undefined;
                task.result = undefined;
                task.completedAt = undefined;
                task.recovery = undefined;
            }

            this._tasks.set(id, task);
        }

        for (const sessionId of sessionOrder) {
            const session = this._sessions.get(sessionId);
            if (!session) continue;
            const seen = new Set<string>();
            const cleanedTaskIds = session.taskIds.filter(taskId => {
                if (seen.has(taskId)) return false;
                if (!this._tasks.has(taskId)) return false;
                seen.add(taskId);
                return true;
            });
            const orphanTasks = Array.from(this._tasks.values())
                .filter(task => task.sessionId === sessionId && !seen.has(task.id))
                .sort((a, b) => a.createdAt - b.createdAt)
                .map(task => task.id);
            session.taskIds = [...cleanedTaskIds, ...orphanTasks];
        }

        this.onStateChange.emit();
        this.triggerSave();
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15);
    }
}
