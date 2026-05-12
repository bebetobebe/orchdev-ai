import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: {
        messageHandler?: (message: { command: string; data: Record<string, unknown> }) => void;
        panel?: {
            webview: {
                postMessage: ReturnType<typeof vi.fn>;
            };
        };
    } = {};
    const showInformationMessage = vi.fn();
    const showWarningMessage = vi.fn();
    const showErrorMessage = vi.fn();
    const executeCommand = vi.fn();
    const clipboardWriteText = vi.fn();
    let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
    const openTextDocument = vi.fn(async (uri: { fsPath: string }) => ({ uri }));
    const showTextDocument = vi.fn().mockResolvedValue(undefined);
    const configurationInspect = vi.fn(() => ({ workspaceValue: undefined }));
    const configurationUpdate = vi.fn().mockResolvedValue(undefined);
    const getConfiguration = vi.fn(() => ({
        inspect: configurationInspect,
        update: configurationUpdate,
    }));
    const createWebviewPanel = vi.fn(() => {
        const panel = {
            webview: {
                html: '',
                cspSource: 'vscode-webview',
                asWebviewUri: (uri: { path?: string; fsPath?: string }) => uri.path ?? uri.fsPath ?? '',
                postMessage: vi.fn().mockResolvedValue(true),
                onDidReceiveMessage: vi.fn((cb: typeof state.messageHandler, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
                    state.messageHandler = cb;
                    const disposable = { dispose: vi.fn() };
                    disposables?.push(disposable);
                    return disposable;
                }),
            },
            onDidDispose: vi.fn((_cb: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
                const disposable = { dispose: vi.fn() };
                disposables?.push(disposable);
                return disposable;
            }),
            dispose: vi.fn(),
            reveal: vi.fn(),
        };
        state.panel = panel;
        return panel;
    });
    return {
        state,
        showInformationMessage,
        showWarningMessage,
        showErrorMessage,
        executeCommand,
        clipboardWriteText,
        get workspaceFolders() {
            return workspaceFolders;
        },
        set workspaceFolders(value: Array<{ uri: { fsPath: string } }> | undefined) {
            workspaceFolders = value;
        },
        openTextDocument,
        showTextDocument,
        configurationInspect,
        configurationUpdate,
        getConfiguration,
        createWebviewPanel,
    };
});

vi.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        createWebviewPanel: mocks.createWebviewPanel,
        showInformationMessage: mocks.showInformationMessage,
        showWarningMessage: mocks.showWarningMessage,
        showErrorMessage: mocks.showErrorMessage,
        showTextDocument: mocks.showTextDocument,
    },
    commands: {
        executeCommand: mocks.executeCommand,
    },
    env: {
        clipboard: {
            writeText: mocks.clipboardWriteText,
        },
    },
    workspace: {
        getConfiguration: mocks.getConfiguration,
        get workspaceFolders() {
            return mocks.workspaceFolders;
        },
        openTextDocument: mocks.openTextDocument,
    },
    Uri: {
        joinPath: (...parts: Array<string | { path?: string; fsPath?: string }>) => {
            const path = parts.map(part => typeof part === 'string' ? part : part.path ?? part.fsPath ?? '').join('/');
            return { path, fsPath: path };
        },
        file: (fsPath: string) => ({ fsPath, path: fsPath }),
    },
    ViewColumn: {
        One: 1,
    },
    ConfigurationTarget: {
        Workspace: 1,
        Global: 2,
    },
}));

import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { MainPanel } from '../src/view/MainPanel';
import { FakeAdapter, flush } from './helpers/FakeAdapter';

function openPanel() {
    MainPanel.currentPanel = undefined;
    MainPanel.createOrShow({ path: '/extension', fsPath: '/extension' } as never);
    if (!mocks.state.messageHandler) {
        throw new Error('MainPanel did not register a webview message handler.');
    }
}

function post(command: string, data: Record<string, unknown>) {
    if (!mocks.state.messageHandler) {
        throw new Error('No message handler registered.');
    }
    mocks.state.messageHandler({ command, data });
}

async function settleAction() {
    await flush();
    await flush();
}

describe('MainPanel', () => {
    beforeEach(() => {
        Orchestrator.__resetForTesting();
        MainPanel.currentPanel = undefined;
        MainPanel.updateCustomApiHealth(undefined);
        mocks.state.messageHandler = undefined;
        mocks.state.panel = undefined;
        mocks.createWebviewPanel.mockClear();
        mocks.executeCommand.mockReset();
        mocks.clipboardWriteText.mockReset().mockResolvedValue(undefined);
        mocks.workspaceFolders = undefined;
        mocks.openTextDocument.mockReset().mockImplementation(async (uri: { fsPath: string }) => ({ uri }));
        mocks.showTextDocument.mockReset().mockResolvedValue(undefined);
        mocks.configurationInspect.mockReset().mockReturnValue({ workspaceValue: undefined });
        mocks.configurationUpdate.mockReset().mockResolvedValue(undefined);
        mocks.getConfiguration.mockClear();
        mocks.showInformationMessage.mockReset().mockResolvedValue(undefined);
        mocks.showWarningMessage.mockReset().mockResolvedValue(undefined);
        mocks.showErrorMessage.mockReset().mockResolvedValue(undefined);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        MainPanel.currentPanel = undefined;
        vi.restoreAllMocks();
    });

    it('shows an information message when retry-all-failed retries tasks', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const t1 = o.createTask(session.id, 'first', 'Ask')!;
        const t2 = o.createTask(session.id, 'second', 'Ask')!;
        o.cancelTask(t1.id);
        o.cancelTask(t2.id);

        openPanel();
        post('retry-all-failed', { sessionId: session.id });
        await settleAction();

        expect(mocks.showInformationMessage).toHaveBeenCalledWith('已重试 2 个任务。');
        expect(o.getTask(t1.id)?.status).toBe('pending');
        expect(o.getTask(t2.id)?.status).toBe('pending');
    });

    it('pushes custom API health snapshots to the webview update payload', async () => {
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        MainPanel.updateCustomApiHealth({
            status: 'ok',
            name: 'DeepSeek',
            model: 'deepseek-chat',
            message: '工具调用已通过。',
            lastCheckedAt: 1700000000000,
        });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'updateSessions',
            customApiHealth: expect.objectContaining({
                status: 'ok',
                name: 'DeepSeek',
                model: 'deepseek-chat',
            }),
        }));
    });

    it('shows a warning when retry-all-failed has nothing to retry', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        o.createTask(session.id, 'still pending', 'Ask');

        openPanel();
        post('retry-all-failed', { sessionId: session.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('没有失败或已取消的任务可重试。');
    });

    it('shows an information message when cancel-all-tasks cancels tasks', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        o.createTask(session.id, 'first', 'Ask');
        o.createTask(session.id, 'second', 'Execute');

        openPanel();
        post('cancel-all-tasks', { sessionId: session.id });
        await settleAction();

        expect(mocks.showInformationMessage).toHaveBeenCalledWith('已取消 2 个任务。');
    });

    it('shows a warning when cancel-all-tasks has nothing to cancel', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;

        openPanel();
        post('cancel-all-tasks', { sessionId: session.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('没有待处理、排队中或运行中的任务可取消。');
    });

    it('clears session creator inputs only after successful create-session', async () => {
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        post('create-session', { name: 'session', goal: 'goal' });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'clearSessionCreator' });
        expect(mocks.showWarningMessage).not.toHaveBeenCalledWith('创建会话需要填写会话名称和目标。');
    });

    it('preserves session creator inputs when create-session is invalid', async () => {
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        post('create-session', { name: '', goal: '' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('创建会话需要填写会话名称和目标。');
        expect(postMessage).not.toHaveBeenCalledWith({ type: 'clearSessionCreator' });
    });

    it('shows a targeted warning when create-session is missing only the name', async () => {
        openPanel();
        post('create-session', { name: '   ', goal: 'goal' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('创建会话需要填写会话名称。');
    });

    it('shows a targeted warning when create-session is missing only the goal', async () => {
        openPanel();
        post('create-session', { name: 'name', goal: '   ' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('创建会话需要填写会话目标。');
    });

    it('clears task composer only after successful create-task', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('set-active-session', { sessionId: session.id });
        post('create-task', { prompt: 'ship it', mode: 'Execute' });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'clearTaskComposer' });
        expect(o.getTasksForSession(session.id)).toHaveLength(1);
    });

    it('preserves task composer input when create-task cannot run', async () => {
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        post('create-task', { prompt: 'ship it', mode: 'Execute' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('请先选择一个会话再创建任务。');
        expect(postMessage).not.toHaveBeenCalledWith({ type: 'clearTaskComposer' });
    });

    it('auto-creates a quick session and dispatches when create-task asks for quick execution', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1', 'Custom API');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('create-task', {
            prompt: '实现登录按钮加载状态',
            mode: 'Execute',
            autoCreateSession: true,
            autoDispatch: true,
        });
        await settleAction();

        const sessions = o.getAllSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].name).toMatch(/^快速会话：/);
        const tasks = o.getTasksForSession(sessions[0].id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe('running');
        expect(adapter.pendingTaskId).toBe(tasks[0].id);
        expect(postMessage).toHaveBeenCalledWith({ type: 'clearTaskComposer' });
        expect(postMessage).toHaveBeenCalledWith({ type: 'clientFeedback', message: '已创建任务，并派发给 "Custom API"。', tone: 'info' });
    });

    it('warns when an Execute task is dispatched to a worker without write capability', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1', 'Text API');
        adapter.worker.capabilities = [{
            kind: 'workspace-write',
            label: '写入不可用',
            status: 'disabled',
            description: '没有项目写入工具。',
        }];
        o.registerWorkerAdapter(adapter);
        await adapter.connect();

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('create-task', {
            prompt: '修改按钮点击逻辑',
            mode: 'Execute',
            autoCreateSession: true,
            autoDispatch: true,
        });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({
            type: 'clientFeedback',
            message: expect.stringContaining('当前为“写入不可用”，可能无法真实修改项目文件'),
            tone: 'warning',
        });
    });

    it('keeps the quick-created task pending and explains when no worker is connected', async () => {
        const o = Orchestrator.getInstance();

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('create-task', {
            prompt: '分析项目结构',
            mode: 'Ask',
            autoCreateSession: true,
            autoDispatch: true,
        });
        await settleAction();

        const session = o.getAllSessions()[0];
        expect(session).toBeTruthy();
        const task = o.getTasksForSession(session.id)[0];
        expect(task.status).toBe('pending');
        expect(postMessage).toHaveBeenCalledWith({
            type: 'clientFeedback',
            message: '已创建任务，但还没有已连接的执行器。点击“启用固定 API”后再重试，或启用 Codex、Claude Code、Gemini、Aider、MCP 客户端等真实执行器。',
            tone: 'warning',
        });
        expect(mocks.showWarningMessage).toHaveBeenCalledWith('已创建任务，但没有已连接的执行器可用于自动派发。');
    });

    it('routes webview setup buttons to quick setup, test, self-check, settings, and API key commands', async () => {
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        post('quick-setup-custom-api', {});
        post('test-custom-api', {});
        post('create-self-check-task', {});
        post('open-settings', {});
        post('set-custom-api-key', {});
        await settleAction();

        expect(mocks.executeCommand).toHaveBeenCalledWith('ai-dev-orchestrator.quickSetupCustomApi');
        expect(mocks.executeCommand).toHaveBeenCalledWith('ai-dev-orchestrator.testCustomApi');
        expect(mocks.executeCommand).toHaveBeenCalledWith('ai-dev-orchestrator.createSelfCheckTask');
        expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'aiDevOrchestrator');
        expect(mocks.executeCommand).toHaveBeenCalledWith('ai-dev-orchestrator.setCustomApiKey');
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'app:self-check', pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'app:self-check', pending: false });
    });

    it('opens a modified workspace file from the webview', async () => {
        mocks.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
        openPanel();

        post('open-workspace-file', { path: 'src/demo.ts' });
        await settleAction();

        expect(mocks.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            fsPath: '/workspace/src/demo.ts',
        }));
        expect(mocks.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                uri: expect.objectContaining({ fsPath: '/workspace/src/demo.ts' }),
            }),
            { preview: false }
        );
    });

    it('warns when trying to open a modified file without an open workspace', async () => {
        openPanel();

        post('open-workspace-file', { path: 'src/demo.ts' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('请先打开一个项目文件夹，再打开修改文件。');
        expect(mocks.openTextDocument).not.toHaveBeenCalled();
    });

    it('blocks opening a modified file outside the workspace root', async () => {
        mocks.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
        openPanel();

        post('open-workspace-file', { path: '../secret.txt' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('为了安全，只能打开当前项目内的修改文件。');
        expect(mocks.openTextDocument).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
    });

    it('shows a warning when set-active-session targets a missing session', async () => {
        openPanel();
        post('set-active-session', { sessionId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要选择的会话。');
        expect(mocks.executeCommand).not.toHaveBeenCalledWith('ai-dev-orchestrator.selectSession', 'ghost');
    });

    it('posts action-state lifecycle around toggle-auto-chain', async () => {
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        post('toggle-auto-chain', { enabled: true });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'app:auto-chain-toggle', pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'app:auto-chain-toggle', pending: false });
        expect(Orchestrator.getInstance().autoChain).toBe(true);
        expect(mocks.configurationUpdate).toHaveBeenCalledWith('autoChain', true, 2);
    });

    it('rolls back auto-chain when persisting the toggle fails', async () => {
        mocks.configurationUpdate.mockRejectedValueOnce(new Error('denied'));
        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;

        post('toggle-auto-chain', { enabled: true });
        await settleAction();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith('保存自动接续设置失败。');
        expect(Orchestrator.getInstance().autoChain).toBe(false);
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'app:auto-chain-toggle', pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'app:auto-chain-toggle', pending: false });
    });

    it('posts action-state lifecycle around edit-session', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('before', 'goal')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('edit-session', { sessionId: session.id, name: 'after', goal: 'new goal' });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:edit`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:edit`, pending: false });
        expect(o.getSession(session.id)?.name).toBe('after');
        expect(o.getSession(session.id)?.goal).toBe('new goal');
    });

    it('shows a warning when edit-session targets a missing session', async () => {
        openPanel();
        post('edit-session', { sessionId: 'ghost', name: 'after' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要更新的会话。');
    });

    it('shows a warning when edit-session submits an empty update', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('before', 'goal')!;

        openPanel();
        post('edit-session', { sessionId: session.id, name: '   ', goal: '' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('请填写会话名称或目标后再保存修改。');
    });

    it('shows an error when exporting to the clipboard fails', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        mocks.clipboardWriteText.mockRejectedValueOnce(new Error('denied'));

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('export-session', { sessionId: session.id });
        await settleAction();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith('会话导出到剪贴板失败。');
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:export`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:export`, pending: false });
    });

    it('shows a warning when export-session targets a missing session', async () => {
        openPanel();
        post('export-session', { sessionId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要导出的会话。');
    });

    it('shows a warning when summarizing a missing session', () => {
        openPanel();
        post('summarize-session', { sessionId: 'ghost' });

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要更新摘要的会话。');
    });

    it('shows a warning when summarizing without any completed tasks', () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        o.createTask(session.id, 'pending task', 'Ask');

        openPanel();
        post('summarize-session', { sessionId: session.id });

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('至少完成一个任务才能更新会话摘要。');
    });

    it('shows an error when summary generation fails', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'complete me', 'Ask')!;
        await o.dispatchTask(task.id, adapter.worker.id);
        adapter.completeWith({ summary: 'done' });
        await flush();

        openPanel();
        post('summarize-session', { sessionId: session.id });
        await flush();
        adapter.failWith(new Error('summary failed'));
        await settleAction();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith('更新会话摘要失败。');
    });

    it('shows a warning when the selected summary worker is no longer available', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'complete me', 'Ask')!;
        await o.dispatchTask(task.id, adapter.worker.id);
        adapter.completeWith({ summary: 'done' });
        await flush();
        vi.spyOn(o, 'summarizeSessionWithResult').mockResolvedValueOnce({ result: 'worker-not-found' });

        openPanel();
        post('summarize-session', { sessionId: session.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('选定的执行器已无法生成摘要。');
    });

    it('shows a warning when retry-all-failed targets a missing session', async () => {
        openPanel();
        post('retry-all-failed', { sessionId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要重试任务的会话。');
    });

    it('shows a warning when cancel-all-tasks targets a missing session', async () => {
        openPanel();
        post('cancel-all-tasks', { sessionId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要取消任务的会话。');
    });

    it('shows an error when connecting a worker fails', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        adapter.setNextConnectError(new Error('offline'));
        o.registerWorkerAdapter(adapter);

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('connect-worker', { workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith('连接执行器 "w1" 失败。');
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'worker:w1:connect', pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: 'worker:w1:connect', pending: false });
    });

    it('shows an error when a connect attempt leaves the worker disconnected', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        vi.spyOn(adapter, 'connect').mockResolvedValueOnce(undefined);

        openPanel();
        post('connect-worker', { workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith('执行器 "w1" 在连接后仍处于未连接状态。');
        expect(adapter.worker.status).toBe('disconnected');
    });

    it('shows a warning when connect-worker targets a missing worker', async () => {
        openPanel();
        post('connect-worker', { workerId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要连接的执行器 "ghost"。');
    });

    it('posts action-state lifecycle around delete-session', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('delete-session', { sessionId: session.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:delete`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:delete`, pending: false });
        expect(o.getSession(session.id)).toBeUndefined();
    });

    it('shows a warning when delete-session targets a missing session', async () => {
        openPanel();
        post('delete-session', { sessionId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要删除的会话。');
    });

    it('posts action-state lifecycle around retry-all-failed', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'first', 'Ask')!;
        o.cancelTask(task.id);

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('retry-all-failed', { sessionId: session.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:retry-all`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `session:${session.id}:retry-all`, pending: false });
    });

    it('posts action-state lifecycle around dispatch-task', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'ship it', 'Execute')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('dispatch-task', { taskId: task.id, workerId: adapter.worker.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:dispatch`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:dispatch`, pending: false });
        expect(o.getTask(task.id)?.status).toBe('running');
    });

    it('posts action-state lifecycle around auto-dispatch-task', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'auto go', 'Execute')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('auto-dispatch-task', { taskId: task.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:auto-dispatch`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:auto-dispatch`, pending: false });
        expect(o.getTask(task.id)?.status).toBe('running');
    });

    it('posts action-state lifecycle around retry-task', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'retry me', 'Ask')!;
        o.cancelTask(task.id);

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('retry-task', { taskId: task.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:retry`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:retry`, pending: false });
        expect(o.getTask(task.id)?.status).toBe('pending');
    });

    it('posts action-state lifecycle around cancel-task', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'cancel me', 'Ask')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('cancel-task', { taskId: task.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:cancel`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:cancel`, pending: false });
        expect(o.getTask(task.id)?.status).toBe('canceled');
    });

    it('posts action-state lifecycle around edit-task-prompt', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'draft prompt', 'Ask')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('edit-task-prompt', { taskId: task.id, prompt: 'updated prompt' });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:edit-prompt`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:edit-prompt`, pending: false });
        expect(o.getTask(task.id)?.prompt).toBe('updated prompt');
    });

    it('posts action-state lifecycle around delete-task', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'delete me', 'Ask')!;

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('delete-task', { taskId: task.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:delete`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:delete`, pending: false });
        expect(o.getTask(task.id)).toBeUndefined();
    });

    it('posts action-state lifecycle around clone-task', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'clone me', 'Ask')!;
        o.cancelTask(task.id);

        openPanel();
        const postMessage = mocks.state.panel!.webview.postMessage;
        post('clone-task', { taskId: task.id });
        await settleAction();

        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:clone`, pending: true });
        expect(postMessage).toHaveBeenCalledWith({ type: 'setActionState', actionKey: `task:${task.id}:clone`, pending: false });
        expect(o.getTasksForSession(session.id)).toHaveLength(2);
        expect(o.getTasksForSession(session.id).some(item => item.id !== task.id && item.status === 'pending' && item.prompt === task.prompt)).toBe(true);
    });

    it('shows a warning when retry-task is no longer retryable', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'still pending', 'Ask')!;

        openPanel();
        post('retry-task', { taskId: task.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('任务已无法重试。');
    });

    it('shows a warning when retry-task targets a missing task', async () => {
        openPanel();
        post('retry-task', { taskId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要重试的任务。');
    });

    it('shows a warning when cancel-task is no longer cancelable', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'done', 'Ask')!;
        await o.dispatchTask(task.id, adapter.worker.id);
        adapter.completeWith({ summary: 'done' });
        await flush();

        openPanel();
        post('cancel-task', { taskId: task.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('任务已无法取消。');
    });

    it('shows a warning when editing a non-pending task prompt', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'locked prompt', 'Ask')!;
        o.cancelTask(task.id);

        openPanel();
        post('edit-task-prompt', { taskId: task.id, prompt: 'new value' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('只有处于待处理状态的任务才能更新提示词。');
    });

    it('shows a warning when editing a missing task prompt', async () => {
        openPanel();
        post('edit-task-prompt', { taskId: 'ghost', prompt: 'new value' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要更新提示词的任务。');
    });

    it('shows a warning when edit-task-prompt submits an empty prompt', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'draft prompt', 'Ask')!;

        openPanel();
        post('edit-task-prompt', { taskId: task.id, prompt: '   ' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('任务提示词不能为空。');
    });

    it('shows a warning when deleting a running task', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'busy', 'Execute')!;
        await o.dispatchTask(task.id, adapter.worker.id);

        openPanel();
        post('delete-task', { taskId: task.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('运行中或排队中的任务必须先取消才能删除。');
        expect(o.getTask(task.id)?.status).toBe('running');
    });

    it('shows a warning when delete-task targets a missing task', async () => {
        openPanel();
        post('delete-task', { taskId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要删除的任务。');
    });

    it('shows a warning when clone-task targets a missing task', async () => {
        openPanel();
        post('clone-task', { taskId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要克隆的任务。');
    });

    it('shows an info message when dispatch queues on a busy worker', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const first = o.createTask(session.id, 'first', 'Execute')!;
        const second = o.createTask(session.id, 'second', 'Execute')!;
        await o.dispatchTask(first.id, adapter.worker.id);

        openPanel();
        post('dispatch-task', { taskId: second.id, workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showInformationMessage).toHaveBeenCalledWith(`任务已加入执行器 "${adapter.worker.id}" 的队列。`);
        expect(o.getTask(second.id)?.status).toBe('queued');
    });

    it('shows a warning when dispatch targets a disconnected worker', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'auto go', 'Execute')!;

        openPanel();
        post('dispatch-task', { taskId: task.id, workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith(`执行器 "${adapter.worker.id}" 未连接，任务仍处于待处理状态。`);
        expect(o.getTask(task.id)?.status).toBe('pending');
    });

    it('shows a warning when dispatch targets a missing worker', async () => {
        const o = Orchestrator.getInstance();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'auto go', 'Execute')!;

        openPanel();
        post('dispatch-task', { taskId: task.id, workerId: 'ghost-worker' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要派发的执行器 "ghost-worker"。');
    });

    it('shows a warning when dispatch targets a missing task', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();

        openPanel();
        post('dispatch-task', { taskId: 'ghost-task', workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要派发的任务。');
    });

    it('shows an error when disconnecting a worker fails', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        vi.spyOn(adapter, 'disconnect').mockRejectedValueOnce(new Error('still busy'));

        openPanel();
        post('disconnect-worker', { workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith('断开执行器 "w1" 失败。');
    });

    it('shows a warning when disconnect-worker targets a busy worker', async () => {
        const o = Orchestrator.getInstance();
        const adapter = new FakeAdapter('w1');
        o.registerWorkerAdapter(adapter);
        await adapter.connect();
        const session = o.createSession('s', 'g')!;
        const task = o.createTask(session.id, 'busy', 'Execute')!;
        await o.dispatchTask(task.id, adapter.worker.id);

        openPanel();
        post('disconnect-worker', { workerId: adapter.worker.id });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('执行器 "w1" 正忙，暂时无法断开。');
        expect(o.getTask(task.id)?.status).toBe('running');
    });

    it('shows a warning when disconnect-worker targets a missing worker', async () => {
        openPanel();
        post('disconnect-worker', { workerId: 'ghost' });
        await settleAction();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要断开的执行器 "ghost"。');
    });
});
