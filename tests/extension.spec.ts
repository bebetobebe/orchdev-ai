import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const tasksProviderInstances: Array<{ setActiveSession: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }> = [];
    const sessionsProviderInstances: Array<{ setActiveSession: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }> = [];
    const showWarningMessage = vi.fn().mockResolvedValue(undefined);
    const showInformationMessage = vi.fn().mockResolvedValue(undefined);
    const showErrorMessage = vi.fn().mockResolvedValue(undefined);
    const showInputBox = vi.fn().mockResolvedValue(undefined);
    const showQuickPick = vi.fn().mockResolvedValue(undefined);
    const createTreeView = vi.fn(() => ({ dispose: vi.fn() }));
    const onDidChangeConfiguration = vi.fn(() => ({ dispose: vi.fn() }));
    const onDidChangeWorkspaceFolders = vi.fn(() => ({ dispose: vi.fn() }));
    const getExtension = vi.fn(() => undefined);
    let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined = undefined;
    const registerCommand = vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose: vi.fn() };
    });
    const executeCommand = vi.fn((id: string, ...args: unknown[]) => {
        if (id === 'setContext') {
            return Promise.resolve(undefined);
        }
        const handler = commands.get(id);
        return Promise.resolve(handler?.(...args));
    });
    const globalStateGet = vi.fn();
    const globalStateUpdate = vi.fn().mockResolvedValue(undefined);
    const configValues: Record<string, unknown> = {
        'mcp.enabled': false,
        'codex.enabled': false,
        'opencode.enabled': false,
        'healthCheck.intervalMs': 0,
        'autoChain': false,
    };
    const configUpdate = vi.fn().mockResolvedValue(undefined);
    const getConfiguration = vi.fn(() => ({
        get: <T>(key: string, defaultValue?: T): T => (key in configValues ? configValues[key] as T : defaultValue as T),
        update: configUpdate,
    }));
    const mainPanelCurrent = {
        setActiveSession: vi.fn(),
        dispose: vi.fn(),
    };
    const mainPanel = {
        currentPanel: mainPanelCurrent as { setActiveSession: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } | undefined,
        createOrShow: vi.fn(),
        updateCustomApiHealth: vi.fn(),
    };

    class MockSessionsTreeProvider {
        setActiveSession = vi.fn();
        refresh = vi.fn();
        constructor() {
            sessionsProviderInstances.push(this);
        }
    }

    class MockTasksTreeProvider {
        setActiveSession = vi.fn();
        refresh = vi.fn();
        constructor() {
            tasksProviderInstances.push(this);
        }
    }

    class MockWorkerAdapter {
        static __ctorCalls: Array<{ id: string; name: string; opts: unknown }> = [];
        static reset() { MockWorkerAdapter.__ctorCalls = []; }
        worker: { id: string; name: string; type: 'mcp'; status: 'disconnected' };
        constructor(id: string, name: string, opts?: unknown) {
            MockWorkerAdapter.__ctorCalls.push({ id, name, opts });
            this.worker = { id, name, type: 'mcp' as const, status: 'disconnected' as const };
        }
        connect = vi.fn().mockResolvedValue(undefined);
        disconnect = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn();
    }

    return {
        commands,
        tasksProviderInstances,
        sessionsProviderInstances,
        showWarningMessage,
        showInformationMessage,
        showErrorMessage,
        showInputBox,
        showQuickPick,
        getExtension,
        createTreeView,
        onDidChangeConfiguration,
        onDidChangeWorkspaceFolders,
        get workspaceFolders() { return workspaceFolders; },
        set workspaceFolders(value: Array<{ uri: { fsPath: string } }> | undefined) { workspaceFolders = value; },
        registerCommand,
        executeCommand,
        globalStateGet,
        globalStateUpdate,
        getConfiguration,
        configValues,
        configUpdate,
        mainPanelCurrent,
        mainPanel,
        MockSessionsTreeProvider,
        MockTasksTreeProvider,
        MockWorkerAdapter,
    };
});

vi.mock('vscode', () => ({
    window: {
        createTreeView: mocks.createTreeView,
        showWarningMessage: mocks.showWarningMessage,
        showInformationMessage: mocks.showInformationMessage,
        showErrorMessage: mocks.showErrorMessage,
        showInputBox: mocks.showInputBox,
        showQuickPick: mocks.showQuickPick,
    },
    commands: {
        registerCommand: mocks.registerCommand,
        executeCommand: mocks.executeCommand,
    },
    extensions: {
        getExtension: mocks.getExtension,
    },
    workspace: {
        getConfiguration: mocks.getConfiguration,
        onDidChangeConfiguration: mocks.onDidChangeConfiguration,
        onDidChangeWorkspaceFolders: mocks.onDidChangeWorkspaceFolders,
        get workspaceFolders() { return mocks.workspaceFolders; },
    },
    ConfigurationTarget: {
        Global: 1,
        Workspace: 2,
        WorkspaceFolder: 3,
    },
}));

vi.mock('../src/view/MainPanel', () => ({
    MainPanel: mocks.mainPanel,
}));

vi.mock('../src/view/SessionsTreeProvider', () => ({
    SessionsTreeProvider: mocks.MockSessionsTreeProvider,
}));

vi.mock('../src/view/TasksTreeProvider', () => ({
    TasksTreeProvider: mocks.MockTasksTreeProvider,
}));

vi.mock('../src/orchestrator/worker/MCPWorkerAdapter', () => ({
    MCPWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/CodexWorkerAdapter', () => ({
    CodexWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/OpenCodeWorkerAdapter', () => ({
    OpenCodeWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/ClaudeCodeWorkerAdapter', () => ({
    ClaudeCodeWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/GeminiWorkerAdapter', () => ({
    GeminiWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/AiderWorkerAdapter', () => ({
    AiderWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/MCPClientWorkerAdapter', () => ({
    MCPClientWorkerAdapter: mocks.MockWorkerAdapter,
}));

vi.mock('../src/orchestrator/worker/OpenAIRelayWorkerAdapter', () => ({
    OpenAIRelayWorkerAdapter: mocks.MockWorkerAdapter,
}));

import { activate, __resetWorkerConfigHashesForTesting } from '../src/extension';
import { FIXED_API_CONFIG, type FixedApiConfig } from '../src/config/fixedApiConfig';
import { Orchestrator } from '../src/orchestrator/Orchestrator';

const DEFAULT_FIXED_API_CONFIG: FixedApiConfig = { ...FIXED_API_CONFIG };

function resetFixedApiConfig(): void {
    Object.assign(FIXED_API_CONFIG, DEFAULT_FIXED_API_CONFIG);
}

function useFixedApiConfig(overrides: Partial<FixedApiConfig> = {}): void {
    Object.assign(FIXED_API_CONFIG, DEFAULT_FIXED_API_CONFIG, overrides);
}

interface FakeSecrets {
    get: ReturnType<typeof vi.fn>;
    store: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    onDidChange: ReturnType<typeof vi.fn>;
    _store: Map<string, string>;
    _listeners: Array<(e: { key: string }) => void>;
    _emit(key: string): void;
}

function makeFakeSecrets(): FakeSecrets {
    const store = new Map<string, string>();
    const listeners: Array<(e: { key: string }) => void> = [];
    const fake: FakeSecrets = {
        _store: store,
        _listeners: listeners,
        _emit(key: string) {
            listeners.forEach(l => l({ key }));
        },
        get: vi.fn(async (key: string) => store.get(key)),
        store: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
            listeners.forEach(l => l({ key }));
        }),
        delete: vi.fn(async (key: string) => {
            store.delete(key);
            listeners.forEach(l => l({ key }));
        }),
        onDidChange: vi.fn((cb: (e: { key: string }) => void) => {
            listeners.push(cb);
            return { dispose: vi.fn(() => {
                const idx = listeners.indexOf(cb);
                if (idx >= 0) listeners.splice(idx, 1);
            }) };
        }),
    };
    return fake;
}

function createContext(secrets: FakeSecrets = makeFakeSecrets()) {
    return {
        subscriptions: [],
        extensionUri: { path: '/extension', fsPath: '/extension' },
        globalState: {
            get: mocks.globalStateGet,
            update: mocks.globalStateUpdate,
        },
        secrets,
    } as never;
}

function getCommand(id: string): (...args: unknown[]) => unknown {
    const command = mocks.commands.get(id);
    if (!command) {
        throw new Error(`Command ${id} was not registered.`);
    }
    return command;
}

describe('extension commands', () => {
    beforeEach(() => {
        Orchestrator.__resetForTesting();
        __resetWorkerConfigHashesForTesting();
        resetFixedApiConfig();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        mocks.commands.clear();
        mocks.tasksProviderInstances.length = 0;
        mocks.sessionsProviderInstances.length = 0;
        mocks.showWarningMessage.mockReset().mockResolvedValue(undefined);
        mocks.showInformationMessage.mockReset().mockResolvedValue(undefined);
        mocks.showErrorMessage.mockReset().mockResolvedValue(undefined);
        mocks.showInputBox.mockReset().mockResolvedValue(undefined);
        mocks.showQuickPick.mockReset().mockResolvedValue(undefined);
        mocks.executeCommand.mockClear();
        mocks.createTreeView.mockClear();
        mocks.onDidChangeConfiguration.mockClear();
        mocks.onDidChangeWorkspaceFolders.mockClear();
        mocks.registerCommand.mockClear();
        mocks.globalStateGet.mockReset().mockReturnValue(undefined);
        mocks.globalStateUpdate.mockReset().mockResolvedValue(undefined);
        mocks.getConfiguration.mockClear();
        mocks.configUpdate.mockReset().mockResolvedValue(undefined);
        mocks.MockWorkerAdapter.reset();
        // Reset legacy-token setting between tests so migration tests start clean.
        delete mocks.configValues['relay.authToken'];
        delete mocks.configValues['codex.sandbox'];
        delete mocks.configValues['customApi.enabled'];
        delete mocks.configValues['customApi.name'];
        delete mocks.configValues['customApi.baseUrl'];
        delete mocks.configValues['customApi.model'];
        delete mocks.configValues['customApi.systemPrompt'];
        delete mocks.configValues['customApi.timeoutMs'];
        delete mocks.configValues['customApi.enableWorkspaceTools'];
        delete mocks.configValues['customApi.allowCommandExecution'];
        delete mocks.configValues['customApi.maxToolIterations'];
        mocks.workspaceFolders = undefined;
        mocks.mainPanel.createOrShow.mockClear();
        mocks.mainPanel.updateCustomApiHealth.mockClear();
        mocks.mainPanel.currentPanel = mocks.mainPanelCurrent;
        mocks.mainPanelCurrent.setActiveSession.mockReset();
        mocks.mainPanelCurrent.dispose.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        Orchestrator.__resetForTesting();
        __resetWorkerConfigHashesForTesting();
        resetFixedApiConfig();
    });

    it('selectSession syncs the panel and task tree for an existing session', async () => {
        await activate(createContext());
        const session = Orchestrator.getInstance().createSession('s', 'g')!;

        getCommand('orchdev-ai.selectSession')(session.id);

        expect(mocks.mainPanelCurrent.setActiveSession).toHaveBeenCalledWith(session.id);
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenCalledWith(session.id);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenCalledWith(session.id);
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });

    it('selectSession clears stale selection and warns when the session is missing', async () => {
        await activate(createContext());

        getCommand('orchdev-ai.selectSession')('ghost');

        expect(mocks.mainPanelCurrent.setActiveSession).toHaveBeenCalledWith(null);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenCalledWith(null);
        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要选择的会话。');
    });

    it('restores the last active session after activation', async () => {
        const seed = Orchestrator.getInstance();
        const first = seed.createSession('first', 'g1')!;
        const second = seed.createSession('second', 'g2')!;
        const saved = seed.serialize();
        Orchestrator.__resetForTesting();
        mocks.globalStateGet.mockImplementation((key: string) => {
            if (key === 'ai-dev-orchestrator.state') return saved;
            if (key === 'ai-dev-orchestrator.activeSessionId') return first.id;
            return undefined;
        });

        await activate(createContext());

        expect(second).toBeDefined();
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenCalledWith(first.id);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenCalledWith(first.id);
    });

    it('newSession creates, selects, and opens a session from sidebar input', async () => {
        await activate(createContext());
        mocks.showInputBox
            .mockResolvedValueOnce('侧边栏会话')
            .mockResolvedValueOnce('从侧边栏开始开发');

        await getCommand('orchdev-ai.newSession')();

        const sessions = Orchestrator.getInstance().getAllSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].name).toBe('侧边栏会话');
        expect(sessions[0].goal).toBe('从侧边栏开始开发');
        expect(mocks.mainPanel.createOrShow).toHaveBeenCalledWith({ path: '/extension', fsPath: '/extension' });
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenCalledWith(sessions[0].id);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenCalledWith(sessions[0].id);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('已创建会话：侧边栏会话');
    });

    it('newSession aborts when the first input is canceled', async () => {
        await activate(createContext());
        mocks.showInputBox.mockResolvedValueOnce(undefined);

        await getCommand('orchdev-ai.newSession')();

        expect(Orchestrator.getInstance().getAllSessions()).toHaveLength(0);
        expect(mocks.mainPanel.createOrShow).not.toHaveBeenCalled();
    });

    it('newTask warns when there is no active session', async () => {
        await activate(createContext());

        await getCommand('orchdev-ai.newTask')();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('请先新建或选择一个会话。');
        expect(mocks.showInputBox).not.toHaveBeenCalled();
    });

    it('newTask creates a task for the active session', async () => {
        await activate(createContext());
        const orchestrator = Orchestrator.getInstance();
        const session = orchestrator.createSession('s', 'g')!;
        getCommand('orchdev-ai.selectSession')(session.id);
        mocks.showInputBox.mockResolvedValueOnce('实现侧边栏入口');
        mocks.showQuickPick.mockResolvedValueOnce({ label: '规划', mode: 'Plan' });

        await getCommand('orchdev-ai.newTask')();

        const tasks = orchestrator.getTasksForSession(session.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].prompt).toBe('实现侧边栏入口');
        expect(tasks[0].mode).toBe('Plan');
        expect(mocks.mainPanel.createOrShow).toHaveBeenCalledWith({ path: '/extension', fsPath: '/extension' });
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('任务已添加到当前会话。');
    });

    it('newTask asks for a session when multiple sessions exist and none is active', async () => {
        await activate(createContext());
        const orchestrator = Orchestrator.getInstance();
        const first = orchestrator.createSession('first', 'g1')!;
        const second = orchestrator.createSession('second', 'g2')!;
        mocks.showQuickPick
            .mockResolvedValueOnce({ label: second.name, sessionId: second.id })
            .mockResolvedValueOnce({ label: '提问', mode: 'Ask' });
        mocks.showInputBox.mockResolvedValueOnce('先分析一下');

        await getCommand('orchdev-ai.newTask')();

        expect(orchestrator.getTasksForSession(first.id)).toHaveLength(0);
        const tasks = orchestrator.getTasksForSession(second.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].prompt).toBe('先分析一下');
        expect(tasks[0].mode).toBe('Ask');
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenCalledWith(second.id);
    });

    it('newTask can target a session item from the tree context menu', async () => {
        await activate(createContext());
        const orchestrator = Orchestrator.getInstance();
        const session = orchestrator.createSession('s', 'g')!;
        mocks.showInputBox.mockResolvedValueOnce('右键添加任务');
        mocks.showQuickPick.mockResolvedValueOnce({ label: '执行', mode: 'Execute' });

        await getCommand('orchdev-ai.newTask')({ session });

        const tasks = orchestrator.getTasksForSession(session.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].mode).toBe('Execute');
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenCalledWith(session.id);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenCalledWith(session.id);
    });

    it('createSelfCheckTask creates a safe execute task and dispatches it to a connected worker', async () => {
        mocks.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
        await activate(createContext());
        const orchestrator = Orchestrator.getInstance();
        const session = orchestrator.createSession('s', 'g')!;
        getCommand('orchdev-ai.selectSession')(session.id);
        const execute = vi.fn(async () => ({
            summary: 'ok',
            artifacts: [],
            logs: [],
            modifiedFiles: ['.ai-orchestrator/self-check.md'],
        }));
        orchestrator.registerWorkerAdapter({
            worker: { id: 'local-api', name: 'Local API', type: 'cli', status: 'available' },
            execute,
            connect: vi.fn(async () => undefined),
            disconnect: vi.fn(async () => undefined),
        });

        await getCommand('orchdev-ai.createSelfCheckTask')();

        const tasks = orchestrator.getTasksForSession(session.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].mode).toBe('Execute');
        expect(tasks[0].prompt).toContain('.ai-orchestrator/self-check.md');
        expect(tasks[0].prompt).toContain('不要修改业务代码');
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: tasks[0].id }), expect.any(Object));
        expect(mocks.mainPanel.createOrShow).toHaveBeenCalledWith({ path: '/extension', fsPath: '/extension' });
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('安全自检任务已创建，并派发给“Local API”。');
    });

    it('createSelfCheckTask creates a pending diagnostic task when no worker is connected', async () => {
        mocks.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
        await activate(createContext());

        await getCommand('orchdev-ai.createSelfCheckTask')();

        const sessions = Orchestrator.getInstance().getAllSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].name).toBe('安全自检');
        const tasks = Orchestrator.getInstance().getTasksForSession(sessions[0].id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe('pending');
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('已创建安全自检任务，但还没有已连接的执行器'));
    });

    it('createSelfCheckTask warns when no project folder is open', async () => {
        await activate(createContext());

        await getCommand('orchdev-ai.createSelfCheckTask')();

        expect(Orchestrator.getInstance().getAllSessions()).toHaveLength(0);
        expect(mocks.showWarningMessage).toHaveBeenCalledWith('请先打开一个项目文件夹，再创建安全自检任务。自检需要验证项目文件读取和写入能力。');
    });

    it('refreshViews refreshes both tree providers', async () => {
        await activate(createContext());

        getCommand('orchdev-ai.refreshViews')();

        expect(mocks.sessionsProviderInstances[0].refresh).toHaveBeenCalled();
        expect(mocks.tasksProviderInstances[0].refresh).toHaveBeenCalled();
    });

    it('openPanel can focus the session of a task item', async () => {
        await activate(createContext());
        const session = Orchestrator.getInstance().createSession('s', 'g')!;

        getCommand('orchdev-ai.openPanel')({ task: { sessionId: session.id } });

        expect(mocks.mainPanel.createOrShow).toHaveBeenCalledWith({ path: '/extension', fsPath: '/extension' });
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenCalledWith(session.id);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenCalledWith(session.id);
    });

    it('deleteSession warns when the session is missing', async () => {
        await activate(createContext());

        await getCommand('orchdev-ai.deleteSession')('ghost');

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要删除的会话。');
    });

    it('deleteSession keeps the session when confirmation is canceled', async () => {
        await activate(createContext());
        const session = Orchestrator.getInstance().createSession('s', 'g')!;

        await getCommand('orchdev-ai.deleteSession')(session.id);

        expect(Orchestrator.getInstance().getSession(session.id)).toBeDefined();
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            '确认删除会话“s”？该会话下的任务会一并删除。',
            { modal: true },
            '删除'
        );
    });

    it('deleteSession removes an existing session after confirmation', async () => {
        await activate(createContext());
        const session = Orchestrator.getInstance().createSession('s', 'g')!;
        mocks.showWarningMessage.mockResolvedValueOnce('删除');

        await getCommand('orchdev-ai.deleteSession')(session.id);

        expect(Orchestrator.getInstance().getSession(session.id)).toBeUndefined();
    });

    it('deleteSession falls back to another session after deleting the active one', async () => {
        await activate(createContext());
        const orchestrator = Orchestrator.getInstance();
        const first = orchestrator.createSession('first', 'g1')!;
        const second = orchestrator.createSession('second', 'g2')!;
        getCommand('orchdev-ai.selectSession')(first.id);
        mocks.showWarningMessage.mockResolvedValueOnce('删除');

        await getCommand('orchdev-ai.deleteSession')(first.id);

        expect(orchestrator.getSession(first.id)).toBeUndefined();
        expect(mocks.sessionsProviderInstances[0].setActiveSession).toHaveBeenLastCalledWith(second.id);
        expect(mocks.tasksProviderInstances[0].setActiveSession).toHaveBeenLastCalledWith(second.id);
    });

    it('cancelTask warns when the task is missing', async () => {
        await activate(createContext());

        getCommand('orchdev-ai.cancelTask')('ghost-task');

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('未找到要取消的任务。');
    });

    it('cancelTask warns when the task is no longer cancelable', async () => {
        await activate(createContext());
        const orchestrator = Orchestrator.getInstance();
        const session = orchestrator.createSession('s', 'g')!;
        const task = orchestrator.createTask(session.id, 'done', 'Ask')!;
        orchestrator.cancelTask(task.id);

        getCommand('orchdev-ai.cancelTask')(task.id);

        expect(mocks.showWarningMessage).toHaveBeenCalledWith('任务已无法取消。');
    });
});

describe('extension SecretStorage relay token', () => {
    beforeEach(() => {
        Orchestrator.__resetForTesting();
        __resetWorkerConfigHashesForTesting();
        resetFixedApiConfig();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        mocks.commands.clear();
        mocks.showWarningMessage.mockReset().mockResolvedValue(undefined);
        mocks.showInformationMessage.mockReset().mockResolvedValue(undefined);
        mocks.showInputBox.mockReset().mockResolvedValue(undefined);
        mocks.showQuickPick.mockReset().mockResolvedValue(undefined);
        mocks.executeCommand.mockClear();
        mocks.mainPanel.updateCustomApiHealth.mockClear();
        mocks.configUpdate.mockReset().mockResolvedValue(undefined);
        delete mocks.configValues['relay.authToken'];
    });
    afterEach(() => {
        vi.restoreAllMocks();
        Orchestrator.__resetForTesting();
        __resetWorkerConfigHashesForTesting();
        resetFixedApiConfig();
    });

    it('setRelayToken stores the entered value into SecretStorage', async () => {
        const secrets = makeFakeSecrets();
        await activate(createContext(secrets));

        mocks.showInputBox.mockResolvedValueOnce('sk-new');
        await getCommand('orchdev-ai.setRelayToken')();

        expect(secrets.store).toHaveBeenCalledWith('aiDevOrchestrator.relay.authToken', 'sk-new');
        expect(secrets._store.get('aiDevOrchestrator.relay.authToken')).toBe('sk-new');
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/已保存到系统密钥存储/));
    });

    it('setRelayToken aborts silently when the user cancels the input box', async () => {
        const secrets = makeFakeSecrets();
        await activate(createContext(secrets));

        mocks.showInputBox.mockResolvedValueOnce(undefined);
        await getCommand('orchdev-ai.setRelayToken')();

        expect(secrets.store).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it('setRelayToken warns and does nothing when the user submits an empty string', async () => {
        const secrets = makeFakeSecrets();
        await activate(createContext(secrets));

        mocks.showInputBox.mockResolvedValueOnce('');
        await getCommand('orchdev-ai.setRelayToken')();

        expect(secrets.store).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/未保存空令牌/));
    });

    it('clearRelayToken deletes the existing token from SecretStorage', async () => {
        const secrets = makeFakeSecrets();
        await secrets.store('aiDevOrchestrator.relay.authToken', 'sk-old');
        secrets.store.mockClear();
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.clearRelayToken')();

        expect(secrets.delete).toHaveBeenCalledWith('aiDevOrchestrator.relay.authToken');
        expect(secrets._store.has('aiDevOrchestrator.relay.authToken')).toBe(false);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/已清除/));
    });

    it('clearRelayToken is a no-op (with informational message) when no token is stored', async () => {
        const secrets = makeFakeSecrets();
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.clearRelayToken')();

        expect(secrets.delete).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/当前没有保存中继服务令牌/));
    });

    it('setCustomApiKey stores the entered value into SecretStorage', async () => {
        const secrets = makeFakeSecrets();
        await activate(createContext(secrets));

        mocks.showInputBox.mockResolvedValueOnce('sk-custom');
        await getCommand('orchdev-ai.setCustomApiKey')();

        expect(secrets.store).toHaveBeenCalledWith('aiDevOrchestrator.customApi.apiKey', 'sk-custom');
        expect(secrets._store.get('aiDevOrchestrator.customApi.apiKey')).toBe('sk-custom');
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('固定 API 密钥已保存到系统密钥存储。');
    });

    it('quickSetupCustomApi stores the fixed API key and opens the panel', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: '固定 DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
        });
        await activate(createContext(secrets));
        mocks.MockWorkerAdapter.reset();
        mocks.configUpdate.mockClear();

        mocks.showInputBox.mockResolvedValueOnce('sk-quick-setup');

        await getCommand('orchdev-ai.quickSetupCustomApi')();

        expect(mocks.configUpdate).not.toHaveBeenCalled();
        expect(secrets.store).toHaveBeenCalledWith('aiDevOrchestrator.customApi.apiKey', 'sk-quick-setup');
        expect(mocks.mainPanel.createOrShow).toHaveBeenCalled();
        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenCalledWith(expect.objectContaining({
            status: 'untested',
            name: '固定 DeepSeek',
            model: 'deepseek-chat',
        }));
        expect(mocks.MockWorkerAdapter.__ctorCalls.some(call => call.id === 'custom-api-worker' && call.name === '固定 DeepSeek')).toBe(true);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('固定 API 执行器“固定 DeepSeek”已就绪'));
    });

    it('quickSetupCustomApi warns when the fixed API source config is incomplete', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({ baseUrl: '', model: '' });
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.quickSetupCustomApi')();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('fixedApiConfig.ts'));
        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(secrets.store).not.toHaveBeenCalled();
    });

    it('quickSetupCustomApi allows a fixed local API without an API key', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: '本地 Ollama',
            baseUrl: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
            apiKeyOptional: true,
        });
        await secrets.store('aiDevOrchestrator.customApi.apiKey', 'old-key');
        secrets.delete.mockClear();
        await activate(createContext(secrets));

        mocks.showInputBox.mockResolvedValueOnce('');

        await getCommand('orchdev-ai.quickSetupCustomApi')();

        expect(secrets.delete).toHaveBeenCalledWith('aiDevOrchestrator.customApi.apiKey');
        expect(mocks.showWarningMessage).not.toHaveBeenCalledWith(expect.stringMatching(/需要密钥/));
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('本地 Ollama'));
    });

    it('testCustomApi sends a lightweight chat completion request', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1/chat/completions',
            wireApi: 'chat_completions',
            model: 'deepseek-chat',
        });
        await secrets.store('aiDevOrchestrator.customApi.apiKey', 'sk-test');
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (Array.isArray(body.tools)) {
                return new Response(JSON.stringify({
                    choices: [{ message: { tool_calls: [{ function: { name: 'workspace_capability_check' } }] } }],
                }), { status: 200 });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.testCustomApi')();

        expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/v1/chat/completions', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                Authorization: 'Bearer sk-test',
            }),
        }));
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
            model: 'deepseek-chat',
            stream: false,
            max_tokens: 8,
        });
        expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toMatchObject({
            model: 'deepseek-chat',
            tool_choice: {
                type: 'function',
                function: { name: 'workspace_capability_check' },
            },
        });
        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenCalledWith(expect.objectContaining({
            status: 'testing',
            name: 'DeepSeek',
            model: 'deepseek-chat',
        }));
        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'ok',
            name: 'DeepSeek',
            model: 'deepseek-chat',
            message: expect.stringContaining('工具调用测试均通过'),
        }));
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('DeepSeek 连接测试通过，模型“deepseek-chat”支持工具调用，可用于执行模式修改项目文件。');
    });

    it('testCustomApi supports Responses API probes for fixed API providers', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'MintAPI',
            baseUrl: 'https://mintapi.cn/v1',
            wireApi: 'responses',
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            disableResponseStorage: true,
            apiKeyOptional: true,
        });
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (Array.isArray(body.tools)) {
                return new Response(JSON.stringify({
                    output: [{ type: 'function_call', name: 'workspace_capability_check', call_id: 'call-1', arguments: '{"ok":true}' }],
                }), { status: 200 });
            }
            return new Response(JSON.stringify({
                output_text: 'ok',
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.testCustomApi')();

        expect(fetchMock).toHaveBeenCalledWith('https://mintapi.cn/v1/responses', expect.objectContaining({
            method: 'POST',
        }));
        const baseBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(baseBody).toMatchObject({
            model: 'gpt-5.5',
            reasoning: { effort: 'high' },
            store: false,
        });
        expect(baseBody.input[0].content[0]).toMatchObject({ type: 'input_text' });
        const toolBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
        expect(toolBody.tools[0]).toMatchObject({
            type: 'function',
            name: 'workspace_capability_check',
        });
        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'ok',
            name: 'MintAPI',
            model: 'gpt-5.5',
        }));
    });

    it('testCustomApi warns when chat works but tool calling is unavailable', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'TextOnly',
            baseUrl: 'https://text.test/v1',
            wireApi: 'chat_completions',
            model: 'text-only-model',
            apiKeyOptional: true,
        });
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.testCustomApi')();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'no-tools',
            name: 'TextOnly',
            model: 'text-only-model',
        }));
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('基础连接可用，但未确认工具调用能力'));
    });

    it('testCustomApi falls back when tool_choice is not supported', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'Compat API',
            baseUrl: 'https://compat.test/v1',
            wireApi: 'chat_completions',
            model: 'compat-model',
            apiKeyOptional: true,
        });
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (!Array.isArray(body.tools)) {
                return new Response(JSON.stringify({
                    choices: [{ message: { content: 'ok' } }],
                }), { status: 200 });
            }
            if (body.tool_choice) {
                return new Response('unknown parameter: tool_choice', { status: 400, statusText: 'Bad Request' });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { tool_calls: [{ function: { name: 'workspace_capability_check' } }] } }],
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.testCustomApi')();

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).tool_choice).toBeTruthy();
        expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).tool_choice).toBeUndefined();
        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'ok',
            name: 'Compat API',
            model: 'compat-model',
        }));
    });

    it('testCustomApi accepts legacy function_call probe responses', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'Legacy API',
            baseUrl: 'https://legacy.test/v1',
            wireApi: 'chat_completions',
            model: 'legacy-model',
            apiKeyOptional: true,
        });
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (Array.isArray(body.tools)) {
                return new Response(JSON.stringify({
                    choices: [{ message: { function_call: { name: 'workspace_capability_check' } } }],
                }), { status: 200 });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.testCustomApi')();

        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'ok',
            name: 'Legacy API',
            model: 'legacy-model',
        }));
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('Legacy API 连接测试通过，模型“legacy-model”支持工具调用，可用于执行模式修改项目文件。');
    });

    it('testCustomApi reports HTTP failures with response details', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'OpenRouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            wireApi: 'chat_completions',
            model: 'openai/gpt-4o-mini',
        });
        await secrets.store('aiDevOrchestrator.customApi.apiKey', 'sk-test');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401, statusText: 'Unauthorized' })));
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.testCustomApi')();

        expect(mocks.mainPanel.updateCustomApiHealth).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'failed',
            name: 'OpenRouter',
            model: 'openai/gpt-4o-mini',
            message: expect.stringContaining('HTTP 401'),
        }));
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('OpenRouter 连接测试失败：HTTP 401 bad key'));
    });

    it('clearCustomApiKey deletes the existing custom API key from SecretStorage', async () => {
        const secrets = makeFakeSecrets();
        await secrets.store('aiDevOrchestrator.customApi.apiKey', 'sk-old-custom');
        secrets.store.mockClear();
        await activate(createContext(secrets));

        await getCommand('orchdev-ai.clearCustomApiKey')();

        expect(secrets.delete).toHaveBeenCalledWith('aiDevOrchestrator.customApi.apiKey');
        expect(secrets._store.has('aiDevOrchestrator.customApi.apiKey')).toBe(false);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith('固定 API 密钥已清除。');
    });

    it('migrates a legacy plaintext token from settings.json into SecretStorage on activation', async () => {
        const secrets = makeFakeSecrets();
        mocks.configValues['relay.authToken'] = 'legacy-plaintext';

        await activate(createContext(secrets));

        expect(secrets._store.get('aiDevOrchestrator.relay.authToken')).toBe('legacy-plaintext');
        expect(mocks.configUpdate).toHaveBeenCalledWith('relay.authToken', undefined, 1);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/已从 settings\.json 迁移到系统密钥存储/));
    });

    it('does not run migration when the legacy setting is empty', async () => {
        const secrets = makeFakeSecrets();
        mocks.configValues['relay.authToken'] = '';

        await activate(createContext(secrets));

        expect(secrets.store).not.toHaveBeenCalled();
        expect(mocks.configUpdate).not.toHaveBeenCalled();
    });
});

describe('extension hot-reload of worker configuration', () => {
    beforeEach(() => {
        Orchestrator.__resetForTesting();
        __resetWorkerConfigHashesForTesting();
        resetFixedApiConfig();
        mocks.MockWorkerAdapter.reset();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.commands.clear();
        mocks.showInformationMessage.mockReset().mockResolvedValue(undefined);
        mocks.showWarningMessage.mockReset().mockResolvedValue(undefined);
        mocks.showInputBox.mockReset();
        mocks.showQuickPick.mockReset().mockResolvedValue(undefined);
        mocks.executeCommand.mockClear();
        mocks.mainPanel.updateCustomApiHealth.mockClear();
        mocks.configUpdate.mockReset().mockResolvedValue(undefined);
        mocks.onDidChangeConfiguration.mockReset();
        mocks.onDidChangeWorkspaceFolders.mockReset();
        mocks.workspaceFolders = undefined;
        delete mocks.configValues['relay.authToken'];
        // Default: codex enabled with a known cliPath. Disable everything else.
        mocks.configValues['mcp.enabled'] = false;
        mocks.configValues['codex.enabled'] = true;
        mocks.configValues['codex.cliPath'] = '/bin/codex-v1';
        delete mocks.configValues['codex.sandbox'];
        mocks.configValues['relayHttp.enabled'] = false;
    });
    afterEach(() => {
        vi.restoreAllMocks();
        Orchestrator.__resetForTesting();
        __resetWorkerConfigHashesForTesting();
        resetFixedApiConfig();
        mocks.MockWorkerAdapter.reset();
        delete mocks.configValues['codex.enabled'];
        delete mocks.configValues['codex.cliPath'];
        delete mocks.configValues['codex.sandbox'];
        delete mocks.configValues['relayHttp.enabled'];
        mocks.workspaceFolders = undefined;
    });

    function getCodexCalls() {
        return mocks.MockWorkerAdapter.__ctorCalls.filter(c => c.id === 'codex-worker');
    }

    function getCustomApiCalls() {
        return mocks.MockWorkerAdapter.__ctorCalls.filter(c => c.id === 'custom-api-worker');
    }

    it('rebuilds the Codex worker when its cliPath changes via configuration', async () => {
        // Capture the config-change listener so we can fire it manually.
        let configListener: ((e: { affectsConfiguration: (ns: string) => boolean }) => void) | undefined;
        mocks.onDidChangeConfiguration.mockImplementation((cb: typeof configListener) => {
            configListener = cb;
            return { dispose: vi.fn() };
        });

        await activate(createContext());
        expect(getCodexCalls()).toHaveLength(1);
        expect((getCodexCalls()[0].opts as { cliPath: string }).cliPath).toBe('/bin/codex-v1');

        // Mutate config and replay the change event.
        mocks.configValues['codex.cliPath'] = '/bin/codex-v2';
        await configListener!({ affectsConfiguration: (ns: string) => ns === 'aiDevOrchestrator' });

        // Wait one microtask for the async reconcile to complete.
        await new Promise(resolve => setTimeout(resolve, 0));

        const calls = getCodexCalls();
        expect(calls.length).toBe(2);
        expect((calls[1].opts as { cliPath: string }).cliPath).toBe('/bin/codex-v2');
    });

    it('does NOT rebuild a worker when an unrelated config change fires', async () => {
        let configListener: ((e: { affectsConfiguration: (ns: string) => boolean }) => void) | undefined;
        mocks.onDidChangeConfiguration.mockImplementation((cb: typeof configListener) => {
            configListener = cb;
            return { dispose: vi.fn() };
        });

        await activate(createContext());
        expect(getCodexCalls()).toHaveLength(1);

        // Replay the listener WITHOUT changing any value — same hash → same adapter.
        await configListener!({ affectsConfiguration: (ns: string) => ns === 'aiDevOrchestrator' });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(getCodexCalls()).toHaveLength(1);
    });

    it('rebuilds relay-aware workers when the SecretStorage token changes', async () => {
        const secrets = makeFakeSecrets();
        await activate(createContext(secrets));
        expect(getCodexCalls()).toHaveLength(1);
        expect((getCodexCalls()[0].opts as { authToken?: string }).authToken).toBeUndefined();

        // Simulate the user running "Set Relay Token" in another window.
        await secrets.store('aiDevOrchestrator.relay.authToken', 'sk-rotated');
        await new Promise(resolve => setTimeout(resolve, 0));

        const calls = getCodexCalls();
        expect(calls.length).toBe(2);
        expect((calls[1].opts as { authToken?: string }).authToken).toBe('sk-rotated');
    });

    it('registers the fixed API worker from source config and SecretStorage', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            name: 'OpenRouter',
            baseUrl: 'https://openrouter.test/api/v1',
            wireApi: 'chat_completions',
            model: 'openai/gpt-4o-mini',
            systemPrompt: 'Be concise.',
            timeoutMs: 90000,
        });
        await secrets.store('aiDevOrchestrator.customApi.apiKey', 'sk-custom');
        mocks.workspaceFolders = [{ uri: { fsPath: '/workspace/project' } }];

        await activate(createContext(secrets));

        const calls = getCustomApiCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('OpenRouter');
        expect(calls[0].opts).toMatchObject({
            authToken: 'sk-custom',
            baseUrl: 'https://openrouter.test/api/v1',
            wireApi: 'chat_completions',
            model: 'openai/gpt-4o-mini',
            systemPrompt: 'Be concise.',
            timeoutMs: 90000,
            requireRelayEnabled: false,
            enableWorkspaceTools: true,
            allowCommandExecution: false,
            workspaceRoot: '/workspace/project',
        });
        expect(Orchestrator.getInstance().getWorker('custom-api-worker')?.capabilities).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'workspace-read', label: '可读项目', status: 'ready' }),
            expect.objectContaining({ kind: 'workspace-write', label: '执行可写', status: 'ready' }),
            expect.objectContaining({ kind: 'command-execution', label: '命令关闭', status: 'disabled' }),
        ]));
    });

    it('marks Codex as read-only when its sandbox is read-only', async () => {
        mocks.workspaceFolders = [{ uri: { fsPath: '/workspace/project' } }];
        mocks.configValues['codex.sandbox'] = 'read-only';

        await activate(createContext());

        expect(Orchestrator.getInstance().getWorker('codex-worker')?.capabilities).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'cli-project', label: '项目内运行', status: 'ready' }),
            expect.objectContaining({ kind: 'workspace-write', label: '只读沙箱', status: 'warning' }),
        ]));
    });

    it('registers the fixed API worker when its SecretStorage key changes', async () => {
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            baseUrl: 'https://api.test/v1',
            model: 'model-a',
            apiKeyOptional: false,
        });

        await activate(createContext(secrets));
        expect(getCustomApiCalls()).toHaveLength(0);

        await secrets.store('aiDevOrchestrator.customApi.apiKey', 'sk-new-custom');
        await new Promise(resolve => setTimeout(resolve, 0));

        const calls = getCustomApiCalls();
        expect(calls).toHaveLength(1);
        expect((calls[0].opts as { authToken?: string }).authToken).toBe('sk-new-custom');
    });

    it('rebuilds workspace-tool workers when the workspace folder changes', async () => {
        let folderListener: (() => void) | undefined;
        mocks.onDidChangeWorkspaceFolders.mockImplementation((cb: typeof folderListener) => {
            folderListener = cb;
            return { dispose: vi.fn() };
        });
        const secrets = makeFakeSecrets();
        useFixedApiConfig({
            baseUrl: 'https://api.test/v1',
            model: 'model-a',
            apiKeyOptional: true,
        });

        await activate(createContext(secrets));
        expect(getCustomApiCalls()).toHaveLength(1);
        expect((getCustomApiCalls()[0].opts as { workspaceRoot?: string }).workspaceRoot).toBeUndefined();

        mocks.workspaceFolders = [{ uri: { fsPath: '/workspace/project' } }];
        folderListener!();
        await new Promise(resolve => setTimeout(resolve, 0));

        const calls = getCustomApiCalls();
        expect(calls).toHaveLength(2);
        expect((calls[1].opts as { workspaceRoot?: string }).workspaceRoot).toBe('/workspace/project');
    });
});
