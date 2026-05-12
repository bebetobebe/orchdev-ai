// This file is based on docs/PROTOCOL.md

export interface Task {
    id: string; // Unique identifier (e.g., UUID)
    sessionId: string; // The session this task belongs to
    prompt: string; // The natural language description of the task
    mode: 'Ask' | 'Plan' | 'Execute'; // The mode in which the task was created
    status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
    workerId?: string; // The ID of the worker assigned to this task
    createdAt: number; // Unix timestamp
    completedAt?: number; // Unix timestamp
    result?: TaskResult;
    /**
     * Live partial output while the task is running. Workers that support
     * streaming (HTTP relay SSE, CLI stdout) push chunks here through the
     * `onProgress` callback; the orchestrator clears this when `result` is
     * set on completion. Not persisted across reloads — purely an in-memory
     * affordance for the webview's "watch as it generates" UX.
     */
    streamingOutput?: string;
    /**
     * Recovery hint for an in-flight or failed task. The orchestrator fills
     * this when it recognizes a transient/provider interruption and may use it
     * to schedule an automatic retry.
     */
    recovery?: TaskRecovery;
}

export interface TaskResult {
    summary: string; // A brief, human-readable summary of the outcome
    artifacts: Artifact[]; // A list of files, code snippets, or other generated content
    logs: string[]; // Raw logs or detailed steps from the worker
    modifiedFiles?: string[]; // Files modified by workspace tools, when known.
    recovery?: TaskRecovery; // Optional recovery hint when the task failed or is retrying.
}

export type InterruptionType =
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

export interface TaskRecovery {
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

export interface Artifact {
    type: 'file' | 'snippet';
    name: string; // e.g., 'src/components/Button.tsx'
    content: string;
}

export interface Session {
    id: string; // Unique identifier
    name: string; // User-defined name for the session
    goal: string; // The overall objective of this session
    createdAt: number; // Unix timestamp
    taskIds: string[]; // List of task IDs belonging to this session
    summary?: string; // A running summary of the session's context
}

export type WorkerCapabilityKind =
    | 'api-tools'
    | 'workspace-read'
    | 'workspace-write'
    | 'command-execution'
    | 'cli-project'
    | 'mcp-tool'
    | 'placeholder';

export type WorkerCapabilityStatus = 'ready' | 'info' | 'warning' | 'disabled';

export interface WorkerCapability {
    kind: WorkerCapabilityKind;
    label: string;
    status: WorkerCapabilityStatus;
    description?: string;
}

export interface Worker {
    id: string; // Unique identifier (e.g., 'mcp-1')
    name: string; // Human-readable name
    type: 'mcp' | 'cli'; // The type of worker
    status: 'available' | 'busy' | 'disconnected';
    capabilities?: WorkerCapability[]; // User-facing runtime capability hints for the panel.
}

export type CustomApiHealthStatus = 'untested' | 'testing' | 'ok' | 'no-tools' | 'failed';

export interface CustomApiHealthSnapshot {
    status: CustomApiHealthStatus;
    name: string;
    model?: string;
    message?: string;
    lastCheckedAt?: number;
}

/**
 * A single increment of partial worker output. Adapters call
 * `opts.onProgress` repeatedly during `execute()` while assembling the
 * final result. Empty `text` is permitted but discouraged.
 */
export interface ProgressChunk {
    /** Newly-produced text fragment (already decoded; never null). */
    text: string;
}

/**
 * Optional execution hooks passed by the orchestrator. Adapters that don't
 * support streaming may safely ignore the entire object.
 */
export interface ExecuteOptions {
    /**
     * Called by the adapter for each incremental chunk of assistant output.
     * Implementations should be cheap (the orchestrator forwards them to
     * the webview at high frequency). Errors thrown from `onProgress` are
     * caught by the adapter and ignored.
     */
    onProgress?: (chunk: ProgressChunk) => void;
}

export interface IWorkerAdapter {
    readonly worker: Worker;
    execute(task: Task, opts?: ExecuteOptions): Promise<TaskResult>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    /** Optional: terminate a running task. Returns true if a process was killed. */
    cancel?(taskId: string): boolean;
}

/**
 * Snapshot of the relay's health/usage as periodically probed by
 * `RelayHealthMonitor`. Surfaced to the webview as a pill in the header.
 *
 * Status semantics:
 *   - `disabled`     — relay is off, no token, or `healthUrl` is empty (probe never runs).
 *   - `unknown`      — first tick hasn't completed, or last fetch hit a network/parse error.
 *   - `ok`           — last response was 2xx with `{ ok: true }` (or no `ok` field).
 *   - `degraded`     — last response was 2xx but `{ ok: false }` or had a non-empty `message`.
 *   - `unauthorized` — last response was 401 or 403 (token missing/invalid).
 *   - `down`         — last response was 5xx, 408, 503, or other server error.
 */
export interface RelayHealthSnapshot {
    status: 'disabled' | 'unknown' | 'ok' | 'degraded' | 'unauthorized' | 'down';
    /** Optional human-readable note from the relay or the monitor itself. */
    message?: string;
    /** Optional quota/usage block parsed from the relay's `/health` response. */
    usage?: {
        used: number;
        limit: number;
        /** ISO timestamp the relay says the quota will reset at, if any. */
        resetAt?: string;
    };
    /** Unix-millis timestamp of the last successful or failed probe. */
    lastCheckedAt?: number;
    /** Round-trip ms of the last completed probe (success or fail). */
    lastLatencyMs?: number;
}
