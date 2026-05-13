import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { FakeAdapter, flush } from './helpers/FakeAdapter';

// Orchestrator.console.error / warn is used for "expected" error paths
// (failed dispatches, canceled tasks, etc.). Mute it so spec output stays clean.
beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => { /* noop */ });
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});
afterEach(() => {
    vi.restoreAllMocks();
});

function registerConnected(o: Orchestrator, id: string): FakeAdapter {
    const a = new FakeAdapter(id);
    o.registerWorkerAdapter(a);
    a.worker.status = 'available'; // simulate a successful connect()
    return a;
}

describe('Orchestrator', () => {
    let o: Orchestrator;

    beforeEach(() => {
        Orchestrator.__resetForTesting();
        o = Orchestrator.getInstance();
    });

    afterEach(() => {
        Orchestrator.__resetForTesting();
    });

    // ---------- Session & Task creation ----------

    describe('session / task creation', () => {
        it('creates a session with an id and empty taskIds', () => {
            const s = o.createSession('s1', 'goal')!;
            expect(s).toBeTruthy();
            expect(s!.id).toBeTruthy();
            expect(s.taskIds).toEqual([]);
            expect(o.getAllSessions()).toHaveLength(1);
        });

        it('returns an explicit created outcome for createSessionWithResult', () => {
            const outcome = o.createSessionWithResult('s1', 'goal');
            expect(outcome.result).toBe('created');
            expect(outcome.session).toBeTruthy();
            expect(outcome.session!.taskIds).toEqual([]);
        });

        it('creates a task linked to its session with status=pending', () => {
            const s = o.createSession('s1', 'goal')!;
            const t = o.createTask(s.id, 'do thing', 'Ask');
            expect(t).toBeTruthy();
            expect(t!.status).toBe('pending');
            expect(o.getSession(s.id)!.taskIds).toContain(t!.id);
        });

        it('returns an explicit created outcome for createTaskWithResult', () => {
            const s = o.createSession('s1', 'goal')!;
            const outcome = o.createTaskWithResult(s.id, 'do thing', 'Ask');
            expect(outcome.result).toBe('created');
            expect(outcome.task).toBeTruthy();
            expect(outcome.task!.status).toBe('pending');
        });

        it('trims session name/goal and task prompt on create', () => {
            const s = o.createSession('  s1  ', '  goal  ')!;
            const t = o.createTask(s.id, '  do thing  ', 'Ask')!;

            expect(s.name).toBe('s1');
            expect(s.goal).toBe('goal');
            expect(t.prompt).toBe('do thing');
        });

        it('returns undefined when creating a task against a missing session', () => {
            expect(o.createTask('does-not-exist', 'x', 'Ask')).toBeUndefined();
        });

        it('returns an explicit missing-session outcome when creating a task against a missing session', () => {
            expect(o.createTaskWithResult('does-not-exist', 'x', 'Ask').result).toBe('session-not-found');
        });

        it('rejects createSession with empty name or goal', () => {
            expect(o.createSession('', 'g')).toBeUndefined();
            expect(o.createSession('n', '')).toBeUndefined();
            expect(o.createSession('  ', '  ')).toBeUndefined();
            expect(o.getAllSessions()).toHaveLength(0);
        });

        it('returns explicit outcomes for createSessionWithResult validation failures', () => {
            expect(o.createSessionWithResult('', 'g').result).toBe('name-required');
            expect(o.createSessionWithResult('n', '').result).toBe('goal-required');
            expect(o.createSessionWithResult('  ', '  ').result).toBe('name-and-goal-required');
            expect(o.getAllSessions()).toHaveLength(0);
        });

        it('rejects createTask with empty prompt', () => {
            const s = o.createSession('s', 'g')!;
            expect(o.createTask(s.id, '', 'Ask')).toBeUndefined();
            expect(o.createTask(s.id, '   ', 'Ask')).toBeUndefined();
            expect(s.taskIds).toHaveLength(0);
        });

        it('returns an explicit prompt-empty outcome for createTaskWithResult validation failures', () => {
            const s = o.createSession('s', 'g')!;
            expect(o.createTaskWithResult(s.id, '', 'Ask').result).toBe('prompt-empty');
            expect(o.createTaskWithResult(s.id, '   ', 'Ask').result).toBe('prompt-empty');
            expect(s.taskIds).toHaveLength(0);
        });
    });

    // ---------- getSessionStats ----------

    describe('getSessionStats', () => {
        it('returns counts by status for each session', () => {
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'a', 'Ask')!;
            const t2 = o.createTask(s.id, 'b', 'Ask')!;
            o.cancelTask(t2.id);

            const stats = o.getSessionStats();
            expect(stats[s.id].total).toBe(2);
            expect(stats[s.id].pending).toBe(1);
            expect(stats[s.id].canceled).toBe(1);
        });

        it('returns empty counts for a session with no tasks', () => {
            const s = o.createSession('s', 'g')!;
            const stats = o.getSessionStats();
            expect(stats[s.id].total).toBe(0);
        });
    });

    // ---------- updateSession ----------

    describe('updateSession', () => {
        it('updates name only', () => {
            const s = o.createSession('old', 'goal')!;
            expect(o.updateSession(s.id, 'new')).toBe('updated');
            expect(o.getSession(s.id)!.name).toBe('new');
            expect(o.getSession(s.id)!.goal).toBe('goal');
        });

        it('updates goal only', () => {
            const s = o.createSession('name', 'old')!;
            expect(o.updateSession(s.id, undefined, 'new goal')).toBe('updated');
            expect(o.getSession(s.id)!.name).toBe('name');
            expect(o.getSession(s.id)!.goal).toBe('new goal');
        });

        it('updates both name and goal', () => {
            const s = o.createSession('a', 'b')!;
            o.updateSession(s.id, 'x', 'y');
            expect(o.getSession(s.id)!.name).toBe('x');
            expect(o.getSession(s.id)!.goal).toBe('y');
        });

        it('trims whitespace', () => {
            const s = o.createSession('a', 'b')!;
            o.updateSession(s.id, '  trimmed  ', '  clean  ');
            expect(o.getSession(s.id)!.name).toBe('trimmed');
            expect(o.getSession(s.id)!.goal).toBe('clean');
        });

        it('rejects empty/whitespace-only updates', () => {
            const s = o.createSession('keep', 'this')!;
            expect(o.updateSession(s.id, '', '')).toBe('empty-update');
            expect(o.updateSession(s.id, '   ')).toBe('empty-update');
            expect(o.getSession(s.id)!.name).toBe('keep');
        });

        it('returns false for nonexistent session', () => {
            expect(o.updateSession('ghost', 'x')).toBe('session-not-found');
        });

        it('fires onStateChange and triggerSave', () => {
            const s = o.createSession('a', 'b')!;

            let stateChanges = 0;
            const unsub = o.onStateChange.subscribe(() => { stateChanges++; });
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.updateSession(s.id, 'new');
            expect(stateChanges).toBe(1);
            expect(saves).toBe(1);

            unsub();
        });
    });

    describe('summarizeSessionWithResult', () => {
        it('returns session-not-found for a nonexistent session', async () => {
            await expect(o.summarizeSessionWithResult('ghost', 'w1')).resolves.toEqual({ result: 'session-not-found' });
        });

        it('returns no-completed-tasks when the session has nothing completed', async () => {
            const s = o.createSession('s', 'g')!;
            o.createTask(s.id, 'still pending', 'Ask');

            await expect(o.summarizeSessionWithResult(s.id, 'w1')).resolves.toEqual({ result: 'no-completed-tasks' });
        });

        it('returns worker-not-found when the selected summary worker is missing', async () => {
            const s = o.createSession('s', 'g')!;
            const task = o.createTask(s.id, 'done', 'Ask')!;
            task.status = 'completed';
            task.completedAt = Date.now();
            task.result = { summary: 'done', artifacts: [], logs: [] };

            const outcome = await o.summarizeSessionWithResult(s.id, 'ghost');

            expect(outcome).toEqual({ result: 'worker-not-found' });
            expect(o.getTasksForSession(s.id).some(t => t.status === 'failed' && t.prompt.startsWith('请根据以下任务记录生成一段简洁的中文会话摘要：'))).toBe(true);
        });

        it('returns summarized and persists the session summary on success', async () => {
            const adapter = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const task = o.createTask(s.id, 'complete me', 'Ask')!;

            await o.dispatchTask(task.id, adapter.worker.id);
            adapter.completeWith({ summary: 'task summary' });
            await flush();

            const summarize = o.summarizeSessionWithResult(s.id, adapter.worker.id);
            expect(adapter.hasPending).toBe(true);

            adapter.completeWith({ summary: 'session summary' });
            await expect(summarize).resolves.toEqual({ result: 'summarized', summary: 'session summary' });
            expect(o.getSession(s.id)?.summary).toBe('session summary');
        });
    });

    // ---------- Dispatch & queueing ----------

    describe('dispatch & queueing', () => {
        it('dispatches to an available worker and completes successfully', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'prompt', 'Ask')!;

            const result = await o.dispatchTask(t.id, a.worker.id);
            expect(result).toBe('started');
            expect(o.getTask(t.id)!.status).toBe('running');
            expect(a.hasPending).toBe(true);

            a.completeWith({ summary: 'done' });
            await flush();

            const done = o.getTask(t.id)!;
            expect(done.status).toBe('completed');
            expect(done.result?.summary).toBe('done');
            expect(a.worker.status).toBe('available');
        });

        it('normalizes malformed worker results before storing them', async () => {
            const adapter = {
                worker: { id: 'w-bad', name: 'Bad Worker', type: 'cli' as const, status: 'available' as const },
                execute: vi.fn(async () => ({
                    summary: 123,
                    artifacts: [{ type: 'wat', name: 'bad', content: 'x' }, { type: 'file', name: 'src/a.ts', content: 7 }],
                    logs: [1, 'kept log'],
                    modifiedFiles: ['src/a.ts', 42],
                } as never)),
                connect: vi.fn(async () => undefined),
                disconnect: vi.fn(async () => undefined),
            };
            o.registerWorkerAdapter(adapter);
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'prompt', 'Execute')!;

            expect(await o.dispatchTask(t.id, adapter.worker.id)).toBe('started');
            await flush();

            const done = o.getTask(t.id)!;
            expect(done.status).toBe('completed');
            expect(done.result?.summary).toBe('执行器已结束，但没有返回有效摘要。');
            expect(done.result?.artifacts).toEqual([{ type: 'file', name: 'src/a.ts', content: '' }]);
            expect(done.result?.logs).toEqual(['kept log']);
            expect(done.result?.modifiedFiles).toEqual(['src/a.ts']);
        });

        it('queues a second task while the worker is busy, then auto-runs it', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;

            const firstResult = await o.dispatchTask(t1.id, a.worker.id);
            expect(firstResult).toBe('started');
            expect(o.getTask(t1.id)!.status).toBe('running');

            const secondResult = await o.dispatchTask(t2.id, a.worker.id);
            expect(secondResult).toBe('queued');
            expect(o.getTask(t2.id)!.status).toBe('queued');
            expect(o.getQueueLength(a.worker.id)).toBe(1);

            // First task finishes → second is auto-started
            a.completeWith();
            await flush();

            expect(o.getTask(t1.id)!.status).toBe('completed');
            expect(o.getTask(t2.id)!.status).toBe('running');
            expect(a.pendingTaskId).toBe(t2.id);
            expect(o.getQueueLength(a.worker.id)).toBe(0);
        });

        it('refuses to dispatch to a disconnected worker (task stays pending)', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);
            // status stays 'disconnected' because we never called connect()
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            const result = await o.dispatchTask(t.id, a.worker.id);
            expect(result).toBe('worker-disconnected');
            expect(o.getTask(t.id)!.status).toBe('pending');
            expect(a.hasPending).toBe(false);
        });

        it('marks a task failed when the adapter rejects', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.failWith(new Error('boom'));
            await flush();

            const done = o.getTask(t.id)!;
            expect(done.status).toBe('failed');
            expect(done.result?.summary).toMatch(/错误：boom/);
            expect(a.worker.status).toBe('available');
        });

        it('auto retries transient failures after a recovery delay', async () => {
            vi.useFakeTimers();
            try {
                o.configureRecovery({ maxRetries: 2, baseDelayMs: 5, maxDelayMs: 5 });
                const a = registerConnected(o, 'w1');
                const s = o.createSession('s', 'g')!;
                const t = o.createTask(s.id, 'x', 'Ask')!;

                await o.dispatchTask(t.id, a.worker.id);
                a.failWith(new Error('resource_exhausted. Please try again later'));
                await flush();
                await flush();

                const waiting = o.getTask(t.id)!;
                expect(waiting.status).toBe('queued');
                expect(waiting.recovery?.type).toBe('rate-limited');
                expect(waiting.recovery?.autoRetry).toBe(true);
                expect(waiting.recovery?.attempt).toBe(1);
                expect(a.worker.status).toBe('available');
                expect(a.hasPending).toBe(false);

                await vi.advanceTimersByTimeAsync(5);
                await flush();

                expect(o.getTask(t.id)!.status).toBe('running');
                expect(a.pendingTaskId).toBe(t.id);

                a.completeWith({ summary: 'done after retry' });
                await flush();

                const done = o.getTask(t.id)!;
                expect(done.status).toBe('completed');
                expect(done.result?.summary).toBe('done after retry');
                expect(done.recovery).toBeUndefined();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not auto retry quota exhaustion but stores a recovery hint', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.failWith(new Error('Failed precondition: Your daily usage quota has been exhausted'));
            await flush();
            await flush();

            const done = o.getTask(t.id)!;
            expect(done.status).toBe('failed');
            expect(done.recovery?.type).toBe('quota-exhausted');
            expect(done.recovery?.autoRetry).toBe(false);
            expect(done.result?.summary).toMatch(/额度已用完/);
            expect(a.worker.status).toBe('available');
        });
    });

    // ---------- Cancellation ----------

    describe('cancelTask', () => {
        it('cancels a pending task without touching the adapter', () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            expect(o.cancelTask(t.id)).toBe('canceled');
            expect(o.getTask(t.id)!.status).toBe('canceled');
            expect(a.canceledTaskIds).toEqual([]);
            expect(a.hasPending).toBe(false);
        });

        it('cancels a queued task and removes it from the queue', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;
            await o.dispatchTask(t1.id, a.worker.id);
            await o.dispatchTask(t2.id, a.worker.id);
            expect(o.getTask(t2.id)!.status).toBe('queued');

            expect(o.cancelTask(t2.id)).toBe('canceled');
            expect(o.getTask(t2.id)!.status).toBe('canceled');
            expect(o.getQueueLength(a.worker.id)).toBe(0);
            // t1 is still running, adapter wasn't asked to cancel anything
            expect(a.canceledTaskIds).toEqual([]);
            expect(o.getTask(t1.id)!.status).toBe('running');
        });

        it('cancels a running task, kicks the adapter, and frees the worker', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            await o.dispatchTask(t.id, a.worker.id);

            expect(o.cancelTask(t.id)).toBe('canceled');
            await flush();

            expect(o.getTask(t.id)!.status).toBe('canceled');
            expect(a.canceledTaskIds).toEqual([t.id]);
            expect(a.worker.status).toBe('available');
        });

        it('cancelling running task auto-starts the next queued one', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;
            await o.dispatchTask(t1.id, a.worker.id);
            await o.dispatchTask(t2.id, a.worker.id);

            o.cancelTask(t1.id);
            await flush();

            expect(o.getTask(t1.id)!.status).toBe('canceled');
            expect(o.getTask(t2.id)!.status).toBe('running');
            expect(a.pendingTaskId).toBe(t2.id);
        });

        it('is a no-op on completed tasks (no emit/save)', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            await o.dispatchTask(t.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });
            expect(o.cancelTask(t.id)).toBe('task-not-cancelable');
            expect(emits).toBe(0);
            expect(o.getTask(t.id)!.status).toBe('completed');
            unsub();
        });

        it('is a no-op on failed tasks', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            await o.dispatchTask(t.id, a.worker.id);
            a.failWith(new Error('err'));
            await flush();

            expect(o.cancelTask(t.id)).toBe('task-not-cancelable');
            expect(o.getTask(t.id)!.status).toBe('failed');
        });

        it('is a no-op on already-canceled tasks', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            o.cancelTask(t.id);

            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });
            expect(o.cancelTask(t.id)).toBe('task-not-cancelable');
            expect(emits).toBe(0);
            unsub();
        });

        it('returns task-not-found for a nonexistent task id', () => {
            expect(o.cancelTask('ghost')).toBe('task-not-found');
        });
    });

    // ---------- cancel-then-reject race ----------

    describe('cancel-then-reject race', () => {
        it('does not reset worker status when canceled task rejects via cancel()', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;

            await o.dispatchTask(t1.id, a.worker.id);
            await o.dispatchTask(t2.id, a.worker.id);
            expect(o.getTask(t2.id)!.status).toBe('queued');

            // Cancel t1 → adapter.cancel() rejects t1's promise
            // → _dequeueNext fires → t2 starts (worker busy again)
            o.cancelTask(t1.id);

            // t1's rejection propagates through microtasks
            await flush();

            expect(o.getTask(t1.id)!.status).toBe('canceled');
            expect(o.getTask(t2.id)!.status).toBe('running');
            // Worker must still be busy with t2, not reset to available by t1's .catch
            expect(a.worker.status).toBe('busy');
        });
    });

    // ---------- Auto-dispatch worker selection ----------

    describe('pickAutoDispatchWorker', () => {
        it('prefers an available worker over a busy one', async () => {
            const a1 = registerConnected(o, 'w1');
            const a2 = registerConnected(o, 'w2');
            const s = o.createSession('s', 'g')!;
            const busy = o.createTask(s.id, 'busy', 'Ask')!;
            await o.dispatchTask(busy.id, a1.worker.id);

            const picked = o.pickAutoDispatchWorker();
            expect(picked?.id).toBe(a2.worker.id);
        });

        it('when all workers are busy, picks the one with shortest queue', async () => {
            const a1 = registerConnected(o, 'w1');
            const a2 = registerConnected(o, 'w2');
            const s = o.createSession('s', 'g')!;
            // Each worker has one running task; then queue 2 more on w1, 1 on w2
            const r1 = o.createTask(s.id, 'r1', 'Ask')!;
            const r2 = o.createTask(s.id, 'r2', 'Ask')!;
            await o.dispatchTask(r1.id, a1.worker.id);
            await o.dispatchTask(r2.id, a2.worker.id);

            const q1a = o.createTask(s.id, 'q1a', 'Ask')!;
            const q1b = o.createTask(s.id, 'q1b', 'Ask')!;
            const q2a = o.createTask(s.id, 'q2a', 'Ask')!;
            await o.dispatchTask(q1a.id, a1.worker.id);
            await o.dispatchTask(q1b.id, a1.worker.id);
            await o.dispatchTask(q2a.id, a2.worker.id);

            expect(o.getQueueLength('w1')).toBe(2);
            expect(o.getQueueLength('w2')).toBe(1);

            const picked = o.pickAutoDispatchWorker();
            expect(picked?.id).toBe('w2');
        });

        it('returns undefined when no connected workers exist', () => {
            expect(o.pickAutoDispatchWorker()).toBeUndefined();
        });
    });

    // ---------- unregisterWorkerAdapter ----------

    describe('unregisterWorkerAdapter', () => {
        it('removes the adapter and resets queued tasks back to pending', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;
            await o.dispatchTask(t1.id, a.worker.id);
            await o.dispatchTask(t2.id, a.worker.id);
            expect(o.getTask(t2.id)!.status).toBe('queued');

            o.unregisterWorkerAdapter(a.worker.id);
            await flush();

            expect(o.hasWorkerAdapter(a.worker.id)).toBe(false);
            expect(o.getTask(t2.id)!.status).toBe('pending');
            expect(o.getTask(t2.id)!.workerId).toBeUndefined();
            expect(a.disconnectCalls).toBe(1);
        });
    });

    describe('connectWorker / disconnectWorker', () => {
        it('returns worker-not-found for unknown worker ids', async () => {
            expect(await o.connectWorker('ghost')).toBe('worker-not-found');
            expect(await o.disconnectWorker('ghost')).toBe('worker-not-found');
        });

        it('returns worker-already-connected when connecting an available worker', async () => {
            const a = registerConnected(o, 'w1');

            expect(await o.connectWorker(a.worker.id)).toBe('worker-already-connected');
            expect(a.connectCalls).toBe(0);
        });

        it('returns worker-still-disconnected when connect resolves without making the worker available', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);
            vi.spyOn(a, 'connect').mockResolvedValueOnce(undefined);

            expect(await o.connectWorker(a.worker.id)).toBe('worker-still-disconnected');
            expect(a.worker.status).toBe('disconnected');
        });

        it('returns connected and emits when a worker connects successfully', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);
            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });

            expect(await o.connectWorker(a.worker.id)).toBe('connected');
            expect(a.worker.status).toBe('available');
            expect(emits).toBe(1);

            unsub();
        });

        it('returns worker-already-disconnected when disconnecting an already disconnected worker', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);

            expect(await o.disconnectWorker(a.worker.id)).toBe('worker-already-disconnected');
            expect(a.disconnectCalls).toBe(0);
        });

        it('returns worker-busy and leaves the running task untouched', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'run', 'Execute')!;
            await o.dispatchTask(t.id, a.worker.id);

            expect(await o.disconnectWorker(a.worker.id)).toBe('worker-busy');
            expect(a.disconnectCalls).toBe(0);
            expect(a.worker.status).toBe('busy');
            expect(o.getTask(t.id)!.status).toBe('running');
        });

        it('returns worker-still-connected when disconnect resolves without changing the worker status', async () => {
            const a = registerConnected(o, 'w1');
            vi.spyOn(a, 'disconnect').mockResolvedValueOnce(undefined);

            expect(await o.disconnectWorker(a.worker.id)).toBe('worker-still-connected');
            expect(a.worker.status).toBe('available');
        });

        it('returns disconnected and emits when a worker disconnects successfully', async () => {
            const a = registerConnected(o, 'w1');
            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });

            expect(await o.disconnectWorker(a.worker.id)).toBe('disconnected');
            expect(a.worker.status).toBe('disconnected');
            expect(emits).toBe(1);

            unsub();
        });
    });

    // ---------- serialize / deserialize ----------

    describe('serialize / deserialize', () => {
        it('replays sessions + tasks and downgrades running/queued to failed/pending', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const tRun = o.createTask(s.id, 'run', 'Ask')!;
            const tQueue = o.createTask(s.id, 'queue', 'Ask')!;
            await o.dispatchTask(tRun.id, a.worker.id);
            await o.dispatchTask(tQueue.id, a.worker.id);

            const snapshot = o.serialize();

            Orchestrator.__resetForTesting();
            const o2 = Orchestrator.getInstance();
            o2.deserialize(snapshot);

            expect(o2.getTask(tRun.id)!.status).toBe('failed');
            expect(o2.getTask(tRun.id)!.workerId).toBeUndefined();
            expect(o2.getTask(tQueue.id)!.status).toBe('pending');
            expect(o2.getTask(tQueue.id)!.workerId).toBeUndefined();
            expect(o2.getAllSessions()).toHaveLength(1);
        });

        it('sanitizes corrupted persisted state and saves the repaired snapshot', () => {
            const save = vi.fn();
            o.setOnSave(save);

            expect(() => o.deserialize({
                sessions: [
                    null,
                    {
                        id: 's1',
                        name: '  Session  ',
                        goal: '  Goal  ',
                        createdAt: 'bad',
                        taskIds: ['missing', 'running', 'running'],
                    },
                    { id: '', name: 'bad', goal: 'bad', taskIds: [] },
                ],
                tasks: [
                    {
                        id: 'running',
                        sessionId: 's1',
                        prompt: '  run  ',
                        mode: 'Execute',
                        status: 'running',
                        createdAt: 0,
                        workerId: 'w1',
                        result: {
                            summary: 42,
                            artifacts: [{ type: 'file', name: 'a.ts', content: 'x' }, { type: 'bad', name: 'b', content: 'x' }],
                            logs: [1, 'log'],
                        },
                    },
                    {
                        id: 'queued',
                        sessionId: 's1',
                        prompt: 'queue',
                        mode: 'Ask',
                        status: 'queued',
                        createdAt: 1,
                        workerId: 'w1',
                        result: { summary: 'old', artifacts: [], logs: [] },
                    },
                    {
                        id: 'orphan',
                        sessionId: 's1',
                        prompt: 'orphan',
                        mode: 'Plan',
                        status: 'completed',
                        createdAt: 2,
                        result: { summary: 'done', artifacts: [], logs: [], modifiedFiles: ['src/a.ts', 7] },
                    },
                    { id: 'bad-mode', sessionId: 's1', prompt: 'bad', mode: 'Other', status: 'pending', createdAt: 3 },
                    { id: 'missing-session', sessionId: 'ghost', prompt: 'bad', mode: 'Ask', status: 'pending', createdAt: 4 },
                ],
            } as never)).not.toThrow();

            expect(o.getAllSessions()).toHaveLength(1);
            expect(o.getSession('s1')?.name).toBe('Session');
            expect(o.getSession('s1')?.goal).toBe('Goal');
            expect(o.getSession('s1')?.taskIds).toEqual(['running', 'queued', 'orphan']);
            expect(o.getTask('running')?.status).toBe('failed');
            expect(o.getTask('running')?.workerId).toBeUndefined();
            expect(o.getTask('running')?.result?.summary).toContain('扩展重启后中断');
            expect(o.getTask('queued')?.status).toBe('pending');
            expect(o.getTask('queued')?.result).toBeUndefined();
            expect(o.getTask('orphan')?.result?.modifiedFiles).toEqual(['src/a.ts']);
            expect(o.getTask('bad-mode')).toBeUndefined();
            expect(o.getTask('missing-session')).toBeUndefined();
            expect(save).toHaveBeenCalled();
        });
    });

    // ---------- shutdown ----------

    describe('shutdown', () => {
        it('marks in-flight tasks failed, disconnects adapters, clears queues', async () => {
            const a1 = registerConnected(o, 'w1');
            const a2 = registerConnected(o, 'w2');
            const s = o.createSession('s', 'g')!;
            const tRun = o.createTask(s.id, 'run', 'Ask')!;
            const tQueue = o.createTask(s.id, 'queue', 'Ask')!;
            const tOther = o.createTask(s.id, 'other', 'Ask')!;
            await o.dispatchTask(tRun.id, a1.worker.id);
            await o.dispatchTask(tQueue.id, a1.worker.id);
            await o.dispatchTask(tOther.id, a2.worker.id);

            await o.shutdown();

            expect(o.getTask(tRun.id)!.status).toBe('failed');
            expect(o.getTask(tQueue.id)!.status).toBe('failed');
            expect(o.getTask(tOther.id)!.status).toBe('failed');
            expect(a1.disconnectCalls).toBe(1);
            expect(a2.disconnectCalls).toBe(1);
            expect(o.hasWorkerAdapter(a1.worker.id)).toBe(false);
            expect(o.getQueueLength(a1.worker.id)).toBe(0);
        });

        it('leaves already-completed/failed tasks untouched', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const tDone = o.createTask(s.id, 'done', 'Ask')!;
            await o.dispatchTask(tDone.id, a.worker.id);
            a.completeWith({ summary: 'all good' });
            await flush();
            expect(o.getTask(tDone.id)!.status).toBe('completed');

            await o.shutdown();

            const finalTask = o.getTask(tDone.id)!;
            expect(finalTask.status).toBe('completed');
            expect(finalTask.result?.summary).toBe('all good');
        });
    });

    describe('deleteSession', () => {
        it('returns deleted and removes the session plus its tasks', () => {
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'a', 'Ask')!;
            const t2 = o.createTask(s.id, 'b', 'Plan')!;

            expect(o.deleteSession(s.id)).toBe('deleted');
            expect(o.getSession(s.id)).toBeUndefined();
            expect(o.getTask(t1.id)).toBeUndefined();
            expect(o.getTask(t2.id)).toBeUndefined();
        });

        it('returns session-not-found for a nonexistent session id', () => {
            expect(o.deleteSession('ghost')).toBe('session-not-found');
        });

        it('does not delete tasks from other sessions', () => {
            const s1 = o.createSession('one', 'g')!;
            const s2 = o.createSession('two', 'g')!;
            const deletedTask = o.createTask(s1.id, 'remove me', 'Ask')!;
            const keptTask = o.createTask(s2.id, 'keep me', 'Ask')!;

            o.deleteSession(s1.id);

            expect(o.getSession(s1.id)).toBeUndefined();
            expect(o.getTask(deletedTask.id)).toBeUndefined();
            expect(o.getSession(s2.id)).toBeDefined();
            expect(o.getTask(keptTask.id)).toBeDefined();
        });
    });

    // ---------- Health check / auto-reconnect ----------

    describe('runHealthCheckOnce', () => {
        it('reconnects a disconnected adapter', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);
            expect(a.worker.status).toBe('disconnected');

            await o.runHealthCheckOnce();

            expect(a.connectCalls).toBe(1);
            expect(a.worker.status).toBe('available');
        });

        it('skips adapters that are already available', async () => {
            const a = registerConnected(o, 'w1'); // status=available, connectCalls still 0 (helper skips connect())
            await o.runHealthCheckOnce();
            expect(a.connectCalls).toBe(0);
            expect(a.worker.status).toBe('available');
        });

        it('leaves an adapter disconnected when connect() throws', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);
            a.setNextConnectError(new Error('CLI not installed'));

            await o.runHealthCheckOnce();

            expect(a.connectCalls).toBe(1);
            expect(a.worker.status).toBe('disconnected');

            // Next sweep tries again (guard released after the failure)
            await o.runHealthCheckOnce();
            expect(a.connectCalls).toBe(2);
            expect(a.worker.status).toBe('available');
        });

        it('does not issue concurrent connect() for the same adapter', async () => {
            const a = new FakeAdapter('w1');
            o.registerWorkerAdapter(a);

            // Fire two sweeps back-to-back without awaiting the first
            const p1 = o.runHealthCheckOnce();
            const p2 = o.runHealthCheckOnce();
            await Promise.all([p1, p2]);

            // Second sweep saw the in-flight guard and skipped
            expect(a.connectCalls).toBe(1);
            expect(a.worker.status).toBe('available');
        });
    });

    describe('startHealthCheck / stopHealthCheck', () => {
        it('runs periodic sweeps at the configured interval', async () => {
            vi.useFakeTimers();
            try {
                const a = new FakeAdapter('w1');
                o.registerWorkerAdapter(a);
                o.startHealthCheck(1000);
                expect(a.connectCalls).toBe(0);

                await vi.advanceTimersByTimeAsync(1000);
                expect(a.connectCalls).toBe(1);
                expect(a.worker.status).toBe('available');

                // Once available, further ticks don't re-connect
                await vi.advanceTimersByTimeAsync(3000);
                expect(a.connectCalls).toBe(1);
            } finally {
                o.stopHealthCheck();
                vi.useRealTimers();
            }
        });

        it('stopHealthCheck halts further sweeps', async () => {
            vi.useFakeTimers();
            try {
                const a = new FakeAdapter('w1');
                a.setNextConnectError(new Error('nope'));
                o.registerWorkerAdapter(a);
                o.startHealthCheck(1000);

                await vi.advanceTimersByTimeAsync(1000);
                expect(a.connectCalls).toBe(1);
                expect(a.worker.status).toBe('disconnected');

                o.stopHealthCheck();
                await vi.advanceTimersByTimeAsync(5000);
                expect(a.connectCalls).toBe(1); // no further attempts
            } finally {
                vi.useRealTimers();
            }
        });

        it('intervalMs <= 0 disables the sweep', async () => {
            vi.useFakeTimers();
            try {
                const a = new FakeAdapter('w1');
                o.registerWorkerAdapter(a);
                o.startHealthCheck(0);
                await vi.advanceTimersByTimeAsync(10_000);
                expect(a.connectCalls).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // ---------- retryTask ----------

    describe('retryTask', () => {
        it('resets a failed task to pending', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'try', 'Execute')!;

            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);
            a.failWith(new Error('boom'));
            await flush();

            expect(o.getTask(t.id)!.status).toBe('failed');

            const ok = o.retryTask(t.id);
            expect(ok).toBe('retried');

            const retried = o.getTask(t.id)!;
            expect(retried.status).toBe('pending');
            expect(retried.result).toBeUndefined();
            expect(retried.completedAt).toBeUndefined();
            expect(retried.workerId).toBeUndefined();
        });

        it('resets a canceled task to pending', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'try', 'Execute')!;
            o.cancelTask(t.id);

            expect(o.getTask(t.id)!.status).toBe('canceled');

            const ok = o.retryTask(t.id);
            expect(ok).toBe('retried');
            expect(o.getTask(t.id)!.status).toBe('pending');
        });

        it('returns false for a pending task', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            expect(o.retryTask(t.id)).toBe('task-not-retryable');
            expect(o.getTask(t.id)!.status).toBe('pending');
        });

        it('returns false for a running task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);

            expect(o.retryTask(t.id)).toBe('task-not-retryable');
            expect(o.getTask(t.id)!.status).toBe('running');

            // Clean up
            a.completeWith();
            await flush();
        });

        it('returns false for a completed task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            expect(o.retryTask(t.id)).toBe('task-not-retryable');
            expect(o.getTask(t.id)!.status).toBe('completed');
        });

        it('returns false for a nonexistent task id', () => {
            expect(o.retryTask('no-such-task')).toBe('task-not-found');
        });

        it('fires onStateChange and triggerSave on retry', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            o.cancelTask(t.id);

            let stateChanges = 0;
            const unsub = o.onStateChange.subscribe(() => { stateChanges++; });
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.retryTask(t.id);
            expect(stateChanges).toBe(1);
            expect(saves).toBe(1);

            unsub();
        });
    });

    // ---------- deleteTask ----------
    describe('deleteTask', () => {
        it('deletes a pending task', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            expect(o.deleteTask(t.id)).toBe('deleted');
            expect(o.getTask(t.id)).toBeUndefined();
        });

        it('deletes a completed task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            expect(o.deleteTask(t.id)).toBe('deleted');
            expect(o.getTask(t.id)).toBeUndefined();
        });

        it('deletes a failed task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);
            a.failWith(new Error('boom'));
            await flush();

            expect(o.deleteTask(t.id)).toBe('deleted');
            expect(o.getTask(t.id)).toBeUndefined();
        });

        it('deletes a canceled task', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            o.cancelTask(t.id);

            expect(o.deleteTask(t.id)).toBe('deleted');
            expect(o.getTask(t.id)).toBeUndefined();
        });

        it('returns false for a running task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);

            expect(o.deleteTask(t.id)).toBe('task-not-deletable');

            a.completeWith();
            await flush();
        });

        it('returns false for a queued task', async () => {
            const s = o.createSession('s', 'g')!;
            const a = registerConnected(o, 'w');
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;
            await o.dispatchTask(t1.id, a.worker.id);
            await o.dispatchTask(t2.id, a.worker.id);

            expect(o.deleteTask(t2.id)).toBe('task-not-deletable');

            o.cancelTask(t1.id);
            o.cancelTask(t2.id);
            await flush();
        });

        it('returns false for a nonexistent task id', () => {
            expect(o.deleteTask('ghost')).toBe('task-not-found');
        });

        it('removes the task from session.taskIds', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            o.deleteTask(t.id);
            expect(o.getSession(s.id)!.taskIds).not.toContain(t.id);
        });

        it('fires onStateChange and triggerSave on delete', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;

            let stateChanges = 0;
            const unsub = o.onStateChange.subscribe(() => { stateChanges++; });
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.deleteTask(t.id);
            expect(stateChanges).toBe(1);
            expect(saves).toBe(1);

            unsub();
        });
    });

    // ---------- updateTaskPrompt ----------
    describe('updateTaskPrompt', () => {
        it('updates a pending task prompt', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'old prompt', 'Ask')!;

            expect(o.updateTaskPrompt(t.id, 'new prompt')).toBe('updated');
            expect(o.getTask(t.id)!.prompt).toBe('new prompt');
        });

        it('trims whitespace from the new prompt', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'old', 'Ask')!;

            o.updateTaskPrompt(t.id, '  trimmed  ');
            expect(o.getTask(t.id)!.prompt).toBe('trimmed');
        });

        it('rejects empty or whitespace-only prompts', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'keep me', 'Ask')!;

            expect(o.updateTaskPrompt(t.id, '')).toBe('prompt-empty');
            expect(o.updateTaskPrompt(t.id, '   ')).toBe('prompt-empty');
            expect(o.getTask(t.id)!.prompt).toBe('keep me');
        });

        it('rejects editing a running task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            await o.dispatchTask(t.id, a.worker.id);

            expect(o.updateTaskPrompt(t.id, 'changed')).toBe('task-not-editable');

            a.completeWith();
            await flush();
        });

        it('rejects editing a completed task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Execute')!;
            const a = registerConnected(o, 'w');
            await o.dispatchTask(t.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            expect(o.updateTaskPrompt(t.id, 'changed')).toBe('task-not-editable');
        });

        it('rejects editing a canceled task', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'x', 'Ask')!;
            o.cancelTask(t.id);

            expect(o.updateTaskPrompt(t.id, 'changed')).toBe('task-not-editable');
        });

        it('returns false for nonexistent task', () => {
            expect(o.updateTaskPrompt('ghost', 'x')).toBe('task-not-found');
        });

        it('fires onStateChange and triggerSave', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'old', 'Ask')!;

            let stateChanges = 0;
            const unsub = o.onStateChange.subscribe(() => { stateChanges++; });
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.updateTaskPrompt(t.id, 'new');
            expect(stateChanges).toBe(1);
            expect(saves).toBe(1);

            unsub();
        });
    });

    // ---------- cloneTask ----------
    describe('cloneTask', () => {
        it('creates a new pending task with same prompt and mode', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'clone me', 'Plan')!;

            const clone = o.cloneTask(t.id);
            expect(clone.result).toBe('cloned');
            expect(clone.task).toBeDefined();
            expect(clone.task!.id).not.toBe(t.id);
            expect(clone.task!.prompt).toBe(t.prompt);
            expect(clone.task!.mode).toBe(t.mode);
            expect(clone.task!.status).toBe('pending');
        });

        it('adds clone to the same session taskIds', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'clone me', 'Ask')!;

            const clone = o.cloneTask(t.id);
            expect(clone.result).toBe('cloned');
            expect(o.getSession(s.id)!.taskIds).toContain(clone.task!.id);
        });

        it('can clone a completed task', async () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'done', 'Ask')!;
            const a = registerConnected(o, 'w');
            o.dispatchTask(t.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            const clone = o.cloneTask(t.id);
            expect(clone.result).toBe('cloned');
            expect(clone.task).toBeDefined();
            expect(clone.task!.status).toBe('pending');
            expect(clone.task!.result).toBeUndefined();
        });

        it('returns undefined for nonexistent task', () => {
            expect(o.cloneTask('ghost').result).toBe('task-not-found');
        });
    });

    // ---------- retryAllFailed ----------
    describe('retryAllFailed', () => {
        it('retries all failed/canceled tasks in a session', () => {
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'a', 'Ask')!;
            const t2 = o.createTask(s.id, 'b', 'Ask')!;
            const t3 = o.createTask(s.id, 'c', 'Ask')!;

            o.cancelTask(t1.id);
            o.cancelTask(t2.id);

            expect(o.retryAllFailed(s.id)).toBe(2);
            expect(o.getTask(t1.id)!.status).toBe('pending');
            expect(o.getTask(t2.id)!.status).toBe('pending');
            expect(o.getTask(t3.id)!.status).toBe('pending');
        });

        it('returns an explicit retried outcome for retryAllFailedWithResult', () => {
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'a', 'Ask')!;
            const t2 = o.createTask(s.id, 'b', 'Ask')!;
            o.cancelTask(t1.id);
            o.cancelTask(t2.id);

            expect(o.retryAllFailedWithResult(s.id)).toEqual({ result: 'retried', retriedCount: 2 });
        });

        it('returns 0 when no tasks are retryable', () => {
            const s = o.createSession('s', 'g')!;
            o.createTask(s.id, 'x', 'Ask');
            expect(o.retryAllFailed(s.id)).toBe(0);
        });

        it('returns an explicit no-retryable-tasks outcome when no tasks can be retried', () => {
            const s = o.createSession('s', 'g')!;
            o.createTask(s.id, 'x', 'Ask');

            expect(o.retryAllFailedWithResult(s.id)).toEqual({ result: 'no-retryable-tasks' });
        });

        it('returns 0 for nonexistent session', () => {
            expect(o.retryAllFailed('ghost')).toBe(0);
        });

        it('returns an explicit session-not-found outcome for nonexistent session', () => {
            expect(o.retryAllFailedWithResult('ghost')).toEqual({ result: 'session-not-found' });
        });

        it('emits only once for batch', () => {
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'a', 'Ask')!;
            const t2 = o.createTask(s.id, 'b', 'Ask')!;
            o.cancelTask(t1.id);
            o.cancelTask(t2.id);

            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });
            o.retryAllFailed(s.id);
            expect(emits).toBe(1);
            unsub();
        });
    });

    // ---------- cancelAllTasks ----------
    describe('cancelAllTasks', () => {
        it('cancels all pending tasks in a session', () => {
            const s = o.createSession('s', 'g')!;
            o.createTask(s.id, 'a', 'Ask');
            o.createTask(s.id, 'b', 'Ask');

            expect(o.cancelAllTasks(s.id)).toBe(2);
            const tasks = o.getTasksForSession(s.id);
            expect(tasks.every(t => t.status === 'canceled')).toBe(true);
        });

        it('returns an explicit canceled outcome for cancelAllTasksWithResult', () => {
            const s = o.createSession('s', 'g')!;
            o.createTask(s.id, 'a', 'Ask');
            o.createTask(s.id, 'b', 'Ask');

            expect(o.cancelAllTasksWithResult(s.id)).toEqual({ result: 'canceled', canceledCount: 2 });
        });

        it('skips completed/failed/canceled tasks', () => {
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'a', 'Ask')!;
            const t2 = o.createTask(s.id, 'b', 'Ask')!;
            o.cancelTask(t1.id);

            expect(o.cancelAllTasks(s.id)).toBe(1);
        });

        it('returns 0 for nonexistent session', () => {
            expect(o.cancelAllTasks('ghost')).toBe(0);
        });

        it('returns an explicit session-not-found outcome for nonexistent session', () => {
            expect(o.cancelAllTasksWithResult('ghost')).toEqual({ result: 'session-not-found' });
        });

        it('returns 0 when all tasks are already terminal', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'a', 'Ask')!;
            o.cancelTask(t.id);

            expect(o.cancelAllTasks(s.id)).toBe(0);
        });

        it('returns an explicit no-cancelable-tasks outcome when all tasks are already terminal', () => {
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'a', 'Ask')!;
            o.cancelTask(t.id);

            expect(o.cancelAllTasksWithResult(s.id)).toEqual({ result: 'no-cancelable-tasks' });
        });
    });

    // ---------- autoChain ----------
    describe('autoChain', () => {
        it('auto-dispatches next pending task in same session on completion', async () => {
            o.autoChain = true;
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;

            await o.dispatchTask(t1.id, a.worker.id);
            expect(o.getTask(t1.id)!.status).toBe('running');
            expect(o.getTask(t2.id)!.status).toBe('pending');

            a.completeWith({ summary: 'done' });
            await flush();

            expect(o.getTask(t1.id)!.status).toBe('completed');
            expect(o.getTask(t2.id)!.status).toBe('running');

            o.autoChain = false;
        });

        it('does nothing when autoChain is off', async () => {
            o.autoChain = false;
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'first', 'Ask')!;
            const t2 = o.createTask(s.id, 'second', 'Ask')!;

            await o.dispatchTask(t1.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            expect(o.getTask(t1.id)!.status).toBe('completed');
            expect(o.getTask(t2.id)!.status).toBe('pending');
        });

        it('skips when no pending tasks remain', async () => {
            o.autoChain = true;
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t1 = o.createTask(s.id, 'only', 'Ask')!;

            await o.dispatchTask(t1.id, a.worker.id);
            a.completeWith({ summary: 'done' });
            await flush();

            expect(o.getTask(t1.id)!.status).toBe('completed');
            expect(a.worker.status).toBe('available');
            o.autoChain = false;
        });

        it('fires onStateChange and onSave when autoChain changes', () => {
            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.autoChain = true;

            expect(o.autoChain).toBe(true);
            expect(emits).toBe(1);
            expect(saves).toBe(1);

            unsub();
        });

        it('is a no-op when setting autoChain to the same value', () => {
            o.autoChain = false;

            let emits = 0;
            const unsub = o.onStateChange.subscribe(() => { emits++; });
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.autoChain = false;

            expect(emits).toBe(0);
            expect(saves).toBe(0);

            unsub();
        });
    });

    // ---------- onSave / state events ----------
    describe('onSave hook', () => {
        it('fires onSave when state mutates', async () => {
            let saves = 0;
            o.setOnSave(() => { saves++; });

            o.createSession('s', 'g');
            const saveAfterSession = saves;
            expect(saveAfterSession).toBeGreaterThan(0);

            const s = o.getAllSessions()[0];
            o.createTask(s.id, 'x', 'Ask');
            expect(saves).toBeGreaterThan(saveAfterSession);
        });
    });

    // ---------- Streaming output (live preview) ----------
    describe('streaming output', () => {
        beforeEach(() => {
            // Use fake timers so we can deterministically advance the
            // orchestrator's 50ms emit-throttling debounce.
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('passes an onProgress callback to adapter.execute()', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            // streamChunk is a no-op if the orchestrator didn't wire a callback,
            // so the resulting streamingOutput is what proves wiring works.
            a.streamChunk('hello');
            expect(o.getTask(t.id)!.streamingOutput).toBe('hello');

            a.completeWith();
            await flush();
        });

        it('appends streamed chunks to task.streamingOutput in order', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('part 1 ');
            a.streamChunk('part 2');
            expect(o.getTask(t.id)!.streamingOutput).toBe('part 1 part 2');

            a.completeWith();
            await flush();
        });

        it('clears streamingOutput when the task completes', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('partial');
            expect(o.getTask(t.id)!.streamingOutput).toBe('partial');

            a.completeWith({ summary: 'final' });
            await flush();

            const done = o.getTask(t.id)!;
            expect(done.status).toBe('completed');
            expect(done.streamingOutput).toBeUndefined();
            expect(done.result?.summary).toBe('final');
        });

        it('clears streamingOutput when the task fails', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('halfway through');
            a.failWith(new Error('upstream blew up'));
            await flush();

            const failed = o.getTask(t.id)!;
            expect(failed.status).toBe('failed');
            expect(failed.streamingOutput).toBeUndefined();
        });

        it('clears streamingOutput when the task is canceled', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('mid-flight');
            o.cancelTask(t.id);
            await flush();

            const canceled = o.getTask(t.id)!;
            expect(canceled.status).toBe('canceled');
            expect(canceled.streamingOutput).toBeUndefined();
        });

        it('drops chunks that arrive after the task is no longer running', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            o.cancelTask(t.id);
            // After cancel, late chunks must not resurrect streamingOutput.
            a.streamChunk('too late');
            expect(o.getTask(t.id)!.streamingOutput).toBeUndefined();
            await flush();
        });

        it('ignores empty / non-string chunks defensively', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('');
            // The orchestrator's onProgress also ignores non-strings, but the
            // ProgressChunk type forbids them at compile time so we only test
            // the empty-string path here.
            expect(o.getTask(t.id)!.streamingOutput).toBeUndefined();

            a.streamChunk('real');
            expect(o.getTask(t.id)!.streamingOutput).toBe('real');

            a.completeWith();
            await flush();
        });

        it('throttles onStateChange emits via a 50ms debounce while streaming', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            // Dispatch \u2192 1 emit (status: queued/running)
            // Plus one for the 'running' transition itself.
            await o.dispatchTask(t.id, a.worker.id);
            const baseline = (() => {
                let n = 0;
                const sub = o.onStateChange.subscribe(() => { n++; });
                // Burst of 5 chunks within the same throttle window.
                for (let i = 0; i < 5; i++) a.streamChunk(`c${i}`);
                // Before the timer fires nothing has been emitted from streaming yet.
                expect(n).toBe(0);
                vi.advanceTimersByTime(50);
                expect(n).toBe(1);
                // Subsequent chunk schedules a new tick.
                a.streamChunk('next');
                expect(n).toBe(1);
                vi.advanceTimersByTime(50);
                expect(n).toBe(2);
                sub();
                return n;
            })();
            expect(baseline).toBe(2);

            a.completeWith();
            await flush();
        });

        it('resets streamingOutput on a re-dispatch after a failed task', async () => {
            const a = registerConnected(o, 'w1');
            const s = o.createSession('s', 'g')!;
            const t = o.createTask(s.id, 'p', 'Ask')!;

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('first run partial');
            a.failWith(new Error('boom'));
            await flush();

            // After failure, streamingOutput is cleared. retryTask flips the
            // task back to 'pending' but does not auto-dispatch; the next
            // dispatchTask is what kicks off a fresh execute() with a new
            // onProgress closure, which is when the buffer is reset.
            o.retryTask(t.id);
            expect(o.getTask(t.id)!.status).toBe('pending');
            expect(o.getTask(t.id)!.streamingOutput).toBeUndefined();

            await o.dispatchTask(t.id, a.worker.id);
            a.streamChunk('second run');
            expect(o.getTask(t.id)!.streamingOutput).toBe('second run');

            a.completeWith();
            await flush();
        });
    });
});
