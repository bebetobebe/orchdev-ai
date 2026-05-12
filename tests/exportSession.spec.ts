import { describe, it, expect } from 'vitest';
import { exportSessionMarkdown } from '../src/orchestrator/exportSession';
import { Session, Task } from '../src/types';

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's-1',
        name: 'Test Session',
        goal: 'Build something great',
        createdAt: 1700000000000,
        taskIds: [],
        ...overrides,
    };
}

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't-1',
        sessionId: 's-1',
        prompt: 'Fix the bug',
        mode: 'Execute',
        status: 'completed',
        createdAt: 1700000001000,
        ...overrides,
    };
}

describe('exportSessionMarkdown', () => {
    it('includes session name as heading', () => {
        const md = exportSessionMarkdown(makeSession(), []);
        expect(md).toContain('# Test Session');
    });

    it('includes session goal', () => {
        const md = exportSessionMarkdown(makeSession(), []);
        expect(md).toContain('**目标：** Build something great');
    });

    it('includes session summary when present', () => {
        const md = exportSessionMarkdown(makeSession({ summary: 'All done!' }), []);
        expect(md).toContain('## 会话摘要');
        expect(md).toContain('All done!');
    });

    it('omits session summary section when absent', () => {
        const md = exportSessionMarkdown(makeSession(), []);
        expect(md).not.toContain('## 会话摘要');
    });

    it('includes task heading with mode and prompt', () => {
        const md = exportSessionMarkdown(makeSession(), [makeTask()]);
        expect(md).toContain('### [执行] Fix the bug');
    });

    it('includes task status', () => {
        const md = exportSessionMarkdown(makeSession(), [makeTask()]);
        expect(md).toContain('**状态：** 已完成');
    });

    it('includes completedAt when present', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({ completedAt: 1700000002000 }),
        ]);
        expect(md).toContain('**完成时间：**');
    });

    it('omits completedAt when absent', () => {
        const md = exportSessionMarkdown(makeSession(), [makeTask()]);
        expect(md).not.toContain('**完成时间：**');
    });

    it('includes worker ID when present', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({ workerId: 'codex-1' }),
        ]);
        expect(md).toContain('**执行器：** codex-1');
    });

    it('includes result summary', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({
                result: {
                    summary: 'Bug fixed successfully',
                    artifacts: [],
                    logs: [],
                },
            }),
        ]);
        expect(md).toContain('**结果：** Bug fixed successfully');
    });

    it('renders artifacts with name and content', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({
                result: {
                    summary: 'Done',
                    artifacts: [
                        { type: 'file', name: 'src/fix.ts', content: 'export const x = 1;' },
                        { type: 'snippet', name: 'snippet-ts-1', content: 'console.log("hi")' },
                    ],
                    logs: [],
                },
            }),
        ]);
        expect(md).toContain('#### 产物');
        expect(md).toContain('文件：src/fix.ts');
        expect(md).toContain('export const x = 1;');
        expect(md).toContain('代码片段：snippet-ts-1');
        expect(md).toContain('console.log("hi")');
    });

    it('renders modified files when provided by the worker', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({
                result: {
                    summary: 'Done',
                    artifacts: [],
                    logs: [],
                    modifiedFiles: ['src/fix.ts', 'tests/fix.test.ts'],
                },
            }),
        ]);
        expect(md).toContain('**修改文件：**');
        expect(md).toContain('- src/fix.ts');
        expect(md).toContain('- tests/fix.test.ts');
    });

    it('renders logs inside a details block', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({
                result: {
                    summary: 'Done',
                    artifacts: [],
                    logs: ['step 1', 'step 2'],
                },
            }),
        ]);
        expect(md).toContain('<details><summary>日志</summary>');
        expect(md).toContain('step 1\nstep 2');
    });

    it('omits artifacts section when there are none', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({
                result: { summary: 'ok', artifacts: [], logs: [] },
            }),
        ]);
        expect(md).not.toContain('#### 产物');
    });

    it('omits logs section when there are none', () => {
        const md = exportSessionMarkdown(makeSession(), [
            makeTask({
                result: { summary: 'ok', artifacts: [], logs: [] },
            }),
        ]);
        expect(md).not.toContain('日志</summary>');
    });

    it('handles multiple tasks', () => {
        const tasks = [
            makeTask({ id: 't-1', prompt: 'Task A', mode: 'Ask' }),
            makeTask({ id: 't-2', prompt: 'Task B', mode: 'Plan' }),
        ];
        const md = exportSessionMarkdown(makeSession(), tasks);
        expect(md).toContain('### [提问] Task A');
        expect(md).toContain('### [规划] Task B');
    });

    it('returns valid markdown with no tasks', () => {
        const md = exportSessionMarkdown(makeSession(), []);
        expect(md).toContain('# Test Session');
        expect(md).not.toContain('## 任务');
    });
});
