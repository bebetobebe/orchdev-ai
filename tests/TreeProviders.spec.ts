import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock vscode module ────────────────────────────────────────────
vi.mock('vscode', () => import('./helpers/__mocks__/vscode'));

// Import after mock so tree providers see our stubs
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { SessionsTreeProvider } from '../src/view/SessionsTreeProvider';
import { TasksTreeProvider } from '../src/view/TasksTreeProvider';
import { ThemeIcon } from './helpers/__mocks__/vscode';

// ── Helpers ───────────────────────────────────────────────────────
function seedOrchestrator() {
    const orch = Orchestrator.getInstance();
    const s1 = orch.createSession('Session Alpha', 'Fix bugs')!;
    const s2 = orch.createSession('Session Beta', 'Add features')!;
    const t1 = orch.createTask(s1.id, 'Fix login', 'Execute')!;
    const t2 = orch.createTask(s1.id, 'Fix logout', 'Ask')!;
    const t3 = orch.createTask(s2.id, 'Add dark mode', 'Plan')!;
    return { orch, s1, s2, t1, t2, t3 };
}

// ── Tests ─────────────────────────────────────────────────────────
describe('SessionsTreeProvider', () => {
    beforeEach(() => {
        Orchestrator.__resetForTesting();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('returns one SessionItem per session', () => {
        const { s1, s2 } = seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        expect(items).toHaveLength(2);
        expect(items[0].label).toBe('Session Alpha');
        expect(items[1].label).toBe('Session Beta');
    });

    it('sets description to session goal', () => {
        seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        expect(items[0].description).toBe('Fix bugs');
        expect(items[1].description).toBe('Add features');
    });

    it('sets tooltip with name, goal, and task count', () => {
        seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        expect(items[0].tooltip).toContain('Session Alpha');
        expect(items[0].tooltip).toContain('Fix bugs');
        expect(items[0].tooltip).toContain('任务数：2');
    });

    it('sets contextValue to "session"', () => {
        seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        items.forEach(item => expect(item.contextValue).toBe('session'));
    });

    it('sets folder icon', () => {
        seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        items.forEach(item => {
            expect(item.iconPath).toBeInstanceOf(ThemeIcon);
            expect((item.iconPath as ThemeIcon).id).toBe('folder');
        });
    });

    it('sets command to select the session', () => {
        const { s1 } = seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        expect(items[0].command).toEqual({
            command: 'orchdev-ai.selectSession',
            title: '选择会话',
            arguments: [s1.id],
        });
    });

    it('returns no children for a child element (flat list)', () => {
        seedOrchestrator();
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();
        // Pass a SessionItem as the parent — should return empty
        expect(provider.getChildren(items[0])).toEqual([]);
    });

    it('shows a clickable new-session row when no sessions exist', () => {
        const provider = new SessionsTreeProvider();
        const items = provider.getChildren();

        expect(items).toHaveLength(1);
        expect(items[0].label).toBe('还没有会话');
        expect(items[0].description).toBe('点这里新建一个会话');
        expect((items[0].iconPath as ThemeIcon).id).toBe('add');
        expect(items[0].command).toEqual({
            command: 'orchdev-ai.newSession',
            title: '新建会话',
        });
    });

    it('marks the active session with an opened folder icon', () => {
        const { s1 } = seedOrchestrator();
        const provider = new SessionsTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        expect((items[0].iconPath as ThemeIcon).id).toBe('folder-opened');
    });
});

describe('TasksTreeProvider', () => {
    beforeEach(() => {
        Orchestrator.__resetForTesting();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('shows placeholder when no session is selected', () => {
        seedOrchestrator();
        const provider = new TasksTreeProvider();
        const items = provider.getChildren();

        expect(items).toHaveLength(1);
        expect(items[0].label).toBe('先选择或新建会话');
        expect(items[0].description).toBe('点击开始');
        expect((items[0].iconPath as ThemeIcon).id).toBe('add');
        expect(items[0].command).toEqual({
            command: 'orchdev-ai.newSession',
            title: '新建会话',
        });
    });

    it('returns tasks for the active session', () => {
        const { s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        expect(items).toHaveLength(2);
        expect(items[0].label).toContain('Fix login');
        expect(items[1].label).toContain('Fix logout');
    });

    it('shows placeholder when the active session has no tasks yet', () => {
        const orch = Orchestrator.getInstance();
        const session = orch.createSession('Empty Session', 'Start here')!;
        const provider = new TasksTreeProvider();
        provider.setActiveSession(session.id);

        const items = provider.getChildren();
        expect(items).toHaveLength(1);
        expect(items[0].label).toBe('新建任务');
        expect(items[0].description).toBe('添加到当前会话');
        expect((items[0].iconPath as ThemeIcon).id).toBe('add');
        expect(items[0].command).toEqual({
            command: 'orchdev-ai.newTask',
            title: '新建任务',
        });
    });

    it('prefixes label with [mode]', () => {
        const { s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        expect(items[0].label).toBe('[执行] Fix login');
        expect(items[1].label).toBe('[提问] Fix logout');
    });

    it('sets description to task status', () => {
        const { s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        items.forEach(item => expect(item.description).toBe('待处理'));
    });

    it('opens the main panel when a task row is clicked', () => {
        const { s1, t1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        expect(items[0].command).toEqual({
            command: 'orchdev-ai.openPanel',
            title: '打开编排面板',
            arguments: [t1],
        });
    });

    it('sets contextValue to "cancelableTask" for cancelable items', () => {
        const { s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        items.forEach(item => expect(item.contextValue).toBe('cancelableTask'));
    });

    it('maps pending status to clock icon', () => {
        const { s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        const items = provider.getChildren();
        items.forEach(item => {
            expect((item.iconPath as ThemeIcon).id).toBe('clock');
        });
    });

    it('switches to a different session', () => {
        const { s2 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s2.id);

        const items = provider.getChildren();
        expect(items).toHaveLength(1);
        expect(items[0].label).toContain('Add dark mode');
    });

    it('returns placeholder for a non-existent session', () => {
        seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession('nonexistent');

        const items = provider.getChildren();
        expect(items).toHaveLength(1);
        expect(items[0].label).toBe('先选择或新建会话');
        expect((items[0].iconPath as ThemeIcon).id).toBe('add');
    });

    it('returns no children for a child element (flat list)', () => {
        const { s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);
        const items = provider.getChildren();

        expect(provider.getChildren(items[0])).toEqual([]);
    });

    it('falls back to the placeholder when the active session is deleted', () => {
        const { orch, s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        orch.deleteSession(s1.id);

        const items = provider.getChildren();
        expect(items).toHaveLength(1);
        expect(items[0].label).toBe('先选择或新建会话');
        expect((items[0].iconPath as ThemeIcon).id).toBe('add');
    });

    it('maps each task status to the correct icon', () => {
        const { orch, s1 } = seedOrchestrator();
        const provider = new TasksTreeProvider();
        provider.setActiveSession(s1.id);

        // Manually tweak statuses to cover all branches
        const tasks = orch.getTasksForSession(s1.id);
        const statusToIcon: Record<string, string> = {
            pending: 'clock',
            queued: 'history',
            running: 'loading~spin',
            completed: 'check',
            failed: 'error',
            canceled: 'close',
        };

        for (const [status, expectedIcon] of Object.entries(statusToIcon)) {
            (tasks[0] as any).status = status;
            const items = provider.getChildren();
            expect((items[0].iconPath as ThemeIcon).id).toBe(expectedIcon);
        }
    });
});
