import * as vscode from 'vscode';
import { isAbsolute, relative, resolve } from 'node:path';
import {
    type CancelAllTasksOutcome,
    type CancelTaskResult,
    type CloneTaskOutcome,
    type ConnectWorkerResult,
    type CreateSessionOutcome,
    type CreateTaskOutcome,
    type DeleteSessionResult,
    type DeleteTaskResult,
    type DisconnectWorkerResult,
    type DispatchTaskResult,
    type RetryAllFailedOutcome,
    type RetryTaskResult,
    type SummarizeSessionOutcome,
    type UpdateSessionResult,
    type UpdateTaskPromptResult,
    Orchestrator
} from '../orchestrator/Orchestrator';
import { exportSessionMarkdown } from '../orchestrator/exportSession';
import { BRAND } from '../config/branding';
import { COMMAND_IDS, VIEW_IDS } from '../constants/ids';
import type { CustomApiHealthSnapshot, RelayHealthSnapshot, Task, Worker } from '../types';

const CONFIG_NS = 'aiDevOrchestrator';

export class MainPanel {
    public static currentPanel: MainPanel | undefined;
    /**
     * Last relay health snapshot pushed in by the extension's monitor.
     * Stored statically so a snapshot delivered before the panel is opened
     * is immediately available the first time `update()` runs.
     */
    private static _latestRelayHealth: RelayHealthSnapshot | undefined;
    private static _latestCustomApiHealth: CustomApiHealthSnapshot | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _activeSessionId: string | null = null;
    private _unsubscribeStateChange?: () => void;
    private _isDisposed = false;
    private _webviewReady = false;
    private _pendingWebviewMessages: unknown[] = [];

    public setActiveSession(sessionId: string | null): void {
        if (this._isDisposed) {
            return;
        }
        this._activeSessionId = sessionId;
        this.update();
    }

    /**
     * Receive a fresh relay-health snapshot from the extension's monitor.
     * Forwards to the live webview if one is open; otherwise just stashes it
     * so the next opened panel renders the latest pill immediately.
     */
    public static updateRelayHealth(snapshot: RelayHealthSnapshot | undefined): void {
        MainPanel._latestRelayHealth = snapshot;
        MainPanel.currentPanel?.update();
    }

    public static updateCustomApiHealth(snapshot: CustomApiHealthSnapshot | undefined): void {
        MainPanel._latestCustomApiHealth = snapshot;
        MainPanel.currentPanel?.update();
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MainPanel.currentPanel) {
            MainPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            VIEW_IDS.panel,
            BRAND.extensionDisplayName,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        MainPanel.currentPanel = new MainPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            message => {
                if (!isRecord(message) || typeof message.command !== 'string') {
                    return;
                }
                const data: Record<string, any> = isRecord(message.data) ? message.data : {};
                switch (message.command) {
                    case 'webview-ready':
                        this._webviewReady = true;
                        if (this._pendingWebviewMessages.length > 0) {
                            for (const pending of this._pendingWebviewMessages.splice(0)) {
                                void this._panel.webview.postMessage(pending);
                            }
                        }
                        this.update();
                        return;
                    case 'dispatch-task': {
                        const { taskId, workerId } = data;
                        void this._runWithActionState(
                            this._taskActionKey(taskId, 'dispatch'),
                            async () => {
                                const capabilityWarning = this._getExecuteCapabilityWarning(
                                    Orchestrator.getInstance().getTask(taskId),
                                    Orchestrator.getInstance().getWorker(workerId)
                                );
                                const result = await Orchestrator.getInstance().dispatchTask(taskId, workerId);
                                this._handleDispatchResult(result, workerId);
                                if ((result === 'started' || result === 'queued') && capabilityWarning) {
                                    this._postFeedback(capabilityWarning, 'warning');
                                }
                            }
                        );
                        return;
                    }
                    case 'create-session': {
                        const { name, goal } = data;
                        const createdSessionOutcome = Orchestrator.getInstance().createSessionWithResult(name, goal);
                        if (createdSessionOutcome.session) {
                            this._activeSessionId = createdSessionOutcome.session.id;
                            this.update();
                            void this._postWebviewMessage({ type: 'clearSessionCreator' });
                            void vscode.commands.executeCommand(COMMAND_IDS.selectSession, createdSessionOutcome.session.id);
                        } else {
                            this._handleCreateSessionResult(createdSessionOutcome);
                        }
                        return;
                    }
                    case 'summarize-session': {
                        const { sessionId } = data;
                        if (!Orchestrator.getInstance().getSession(sessionId)) {
                            vscode.window.showWarningMessage('未找到要更新摘要的会话。');
                            return;
                        }
                        if (!Orchestrator.getInstance().getTasksForSession(sessionId).some(task => task.status === 'completed')) {
                            vscode.window.showWarningMessage('至少完成一个任务才能更新会话摘要。');
                            return;
                        }
                        const workers = Orchestrator.getInstance().getAllWorkers();
                        const availableWorker = workers.find(w => w.status === 'available');
                        if (availableWorker) {
                            void this._runWithActionState(
                                this._sessionActionKey(sessionId, 'summarize'),
                                async () => {
                                    try {
                                        this._handleSummarizeSessionResult(
                                            sessionId,
                                            await Orchestrator.getInstance().summarizeSessionWithResult(sessionId, availableWorker.id)
                                        );
                                    } catch {
                                        vscode.window.showErrorMessage('更新会话摘要失败。');
                                    }
                                }
                            );
                        } else {
                            vscode.window.showWarningMessage('没有可用的执行器可生成摘要。');
                        }
                        return;
                    }
                    case 'set-active-session':
                        if (!Orchestrator.getInstance().getSession(data.sessionId)) {
                            this._clearMissingActiveSession(data.sessionId);
                            vscode.window.showWarningMessage('未找到要选择的会话。');
                            return;
                        }
                        this._activeSessionId = data.sessionId;
                        this.update();
                        vscode.commands.executeCommand(COMMAND_IDS.selectSession, data.sessionId);
                        return;
                    case 'create-task': {
                        void this._handleCreateTaskMessage(data);
                        return;
                    }
                    case 'toggle-auto-chain':
                        void this._runWithActionState(
                            this._appActionKey('auto-chain-toggle'),
                            async () => {
                                const enabled = data.enabled === true;
                                const previous = Orchestrator.getInstance().autoChain;
                                Orchestrator.getInstance().autoChain = enabled;
                                try {
                                    await this._persistAutoChainSetting(enabled);
                                } catch {
                                    Orchestrator.getInstance().autoChain = previous;
                                    vscode.window.showErrorMessage('保存自动接续设置失败。');
                                }
                            }
                        );
                        return;
                    case 'clone-task':
                        void this._runWithActionState(
                            this._taskActionKey(data.taskId, 'clone'),
                            () => this._handleCloneTaskResult(Orchestrator.getInstance().cloneTask(data.taskId))
                        );
                        return;
                    case 'retry-all-failed':
                        void this._runWithActionState(
                            this._sessionActionKey(data.sessionId, 'retry-all'),
                            () => this._handleRetryAllFailedResult(
                                data.sessionId,
                                Orchestrator.getInstance().retryAllFailedWithResult(data.sessionId)
                            )
                        );
                        return;
                    case 'cancel-all-tasks':
                        void this._runWithActionState(
                            this._sessionActionKey(data.sessionId, 'cancel-all'),
                            () => this._handleCancelAllTasksResult(
                                data.sessionId,
                                Orchestrator.getInstance().cancelAllTasksWithResult(data.sessionId)
                            )
                        );
                        return;
                    case 'edit-session':
                        void this._runWithActionState(
                            this._sessionActionKey(data.sessionId, 'edit'),
                            () => this._handleUpdateSessionResult(
                                Orchestrator.getInstance().updateSession(
                                    data.sessionId,
                                    data.name,
                                    data.goal
                                )
                            )
                        );
                        return;
                    case 'delete-session':
                        void this._runWithActionState(
                            this._sessionActionKey(data.sessionId, 'delete'),
                            () => {
                                const result = Orchestrator.getInstance().deleteSession(data.sessionId);
                                this._handleDeleteSessionResult(data.sessionId, result);
                            }
                        );
                        return;
                    case 'cancel-task':
                        void this._runWithActionState(
                            this._taskActionKey(data.taskId, 'cancel'),
                            () => this._handleCancelTaskResult(Orchestrator.getInstance().cancelTask(data.taskId))
                        );
                        return;
                    case 'auto-dispatch-task': {
                        const autoTaskId = data.taskId;
                        const chosen = Orchestrator.getInstance().pickAutoDispatchWorker();
                        if (chosen) {
                            void this._runWithActionState(
                                this._taskActionKey(autoTaskId, 'auto-dispatch'),
                                async () => {
                                    const capabilityWarning = this._getExecuteCapabilityWarning(
                                        Orchestrator.getInstance().getTask(autoTaskId),
                                        chosen
                                    );
                                    const result = await Orchestrator.getInstance().dispatchTask(autoTaskId, chosen.id);
                                    this._handleDispatchResult(result, chosen.id);
                                    if ((result === 'started' || result === 'queued') && capabilityWarning) {
                                        this._postFeedback(capabilityWarning, 'warning');
                                    }
                                }
                            );
                        } else {
                            vscode.window.showWarningMessage('没有已连接的执行器可用于自动派发。');
                        }
                        return;
                    }
                    case 'retry-task':
                        void this._runWithActionState(
                            this._taskActionKey(data.taskId, 'retry'),
                            () => this._handleRetryTaskResult(Orchestrator.getInstance().retryTask(data.taskId))
                        );
                        return;
                    case 'export-session': {
                        void this._runWithActionState(
                            this._sessionActionKey(data.sessionId, 'export'),
                            () => this._exportSessionToClipboard(data.sessionId)
                        );
                        return;
                    }
                    case 'edit-task-prompt':
                        void this._runWithActionState(
                            this._taskActionKey(data.taskId, 'edit-prompt'),
                            () => this._handleUpdateTaskPromptResult(
                                Orchestrator.getInstance().updateTaskPrompt(data.taskId, data.prompt)
                            )
                        );
                        return;
                    case 'delete-task':
                        void this._runWithActionState(
                            this._taskActionKey(data.taskId, 'delete'),
                            () => this._handleDeleteTaskResult(Orchestrator.getInstance().deleteTask(data.taskId))
                        );
                        return;
                    case 'connect-worker':
                        void this._runWithActionState(
                            this._workerActionKey(data.workerId, 'connect'),
                            () => this._connectWorker(data.workerId)
                        );
                        return;
                    case 'disconnect-worker':
                        void this._runWithActionState(
                            this._workerActionKey(data.workerId, 'disconnect'),
                            () => this._disconnectWorker(data.workerId)
                        );
                        return;
                    case 'open-settings':
                        void vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_NS);
                        return;
                    case 'quick-setup-custom-api':
                        void vscode.commands.executeCommand(COMMAND_IDS.quickSetupCustomApi);
                        return;
                    case 'test-custom-api':
                        void vscode.commands.executeCommand(COMMAND_IDS.testCustomApi);
                        return;
                    case 'create-self-check-task':
                        void this._runWithActionState(
                            this._appActionKey('self-check'),
                            async () => {
                                await vscode.commands.executeCommand(COMMAND_IDS.createSelfCheckTask);
                            }
                        );
                        return;
                    case 'set-custom-api-key':
                        void vscode.commands.executeCommand(COMMAND_IDS.setCustomApiKey);
                        return;
                    case 'open-workspace-file':
                        void this._openWorkspaceFile(data.path);
                        return;
                }
            },
            null,
            this._disposables
        );
        this._panel.webview.html = this._getHtmlForWebview();
        // Listen for state changes
        this._unsubscribeStateChange = Orchestrator.getInstance().onStateChange.subscribe(() => this.update());

        // Initial update
        this.update();
    }

    public update() {
        if (this._isDisposed) {
            return;
        }
        if (!this._webviewReady) {
            return;
        }
        const orchestrator = Orchestrator.getInstance();
        if (this._activeSessionId && !orchestrator.getSession(this._activeSessionId)) {
            this._activeSessionId = null;
        }
        this._panel.webview.postMessage({
            type: 'updateSessions',
            sessions: orchestrator.getAllSessions(),
            tasks: this._activeSessionId ? orchestrator.getTasksForSession(this._activeSessionId) : [],
            workers: orchestrator.getAllWorkers(),
            activeSessionId: this._activeSessionId,
            sessionStats: orchestrator.getSessionStats(),
            autoChain: orchestrator.autoChain,
            // `relayHealth` may be undefined when the monitor has never
            // produced a snapshot (e.g. relay disabled). The webview hides
            // the pill in that case rather than rendering a placeholder.
            relayHealth: MainPanel._latestRelayHealth,
            customApiHealth: MainPanel._latestCustomApiHealth
        });
    }

    private _sessionActionKey(sessionId: string, action: string): string {
        return `session:${sessionId}:${action}`;
    }

    private _workerActionKey(workerId: string, action: string): string {
        return `worker:${workerId}:${action}`;
    }

    private _appActionKey(action: string): string {
        return `app:${action}`;
    }

    private _taskActionKey(taskId: string, action: string): string {
        return `task:${taskId}:${action}`;
    }

    private async _postWebviewMessage(message: unknown): Promise<void> {
        if (this._isDisposed) {
            return;
        }
        if (!this._webviewReady) {
            this._pendingWebviewMessages.push(message);
            return;
        }
        try {
            await this._panel.webview.postMessage(message);
        } catch {
            // noop
        }
    }

    private async _runWithActionState(actionKey: string, operation: () => void | Promise<void>): Promise<void> {
        await this._postWebviewMessage({ type: 'setActionState', actionKey, pending: true });
        try {
            await operation();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`面板操作失败（${actionKey}）：`, error);
            this._postFeedback(`操作失败：${message || '未知错误'}`, 'error');
            vscode.window.showErrorMessage(`操作失败：${message || '未知错误'}`);
        } finally {
            await this._postWebviewMessage({ type: 'setActionState', actionKey, pending: false });
        }
    }

    private _postFeedback(message: string, tone: 'info' | 'warning' | 'error' = 'warning'): void {
        void this._postWebviewMessage({ type: 'clientFeedback', message, tone });
    }

    private async _openWorkspaceFile(rawPath: unknown): Promise<void> {
        const filePath = typeof rawPath === 'string' ? rawPath.trim() : '';
        if (!filePath) {
            vscode.window.showWarningMessage('没有可打开的修改文件路径。');
            return;
        }
        if (filePath.includes('\0')) {
            vscode.window.showWarningMessage('修改文件路径无效。');
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('请先打开一个项目文件夹，再打开修改文件。');
            return;
        }

        const workspaceRoot = resolve(workspaceFolder.uri.fsPath);
        const absolutePath = isAbsolute(filePath)
            ? resolve(filePath)
            : resolve(workspaceRoot, filePath);
        const relativeToRoot = relative(workspaceRoot, absolutePath);
        if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
            vscode.window.showWarningMessage('为了安全，只能打开当前项目内的修改文件。');
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
            await vscode.window.showTextDocument(document, { preview: false });
        } catch {
            vscode.window.showErrorMessage(`打开修改文件失败：${filePath}`);
        }
    }

    private async _handleCreateTaskMessage(data: Record<string, unknown>): Promise<void> {
        const prompt = typeof data.prompt === 'string' ? data.prompt : '';
        const mode = data.mode === 'Ask' || data.mode === 'Plan' || data.mode === 'Execute' ? data.mode : 'Execute';
        const autoCreateSession = data.autoCreateSession === true;
        const autoDispatch = data.autoDispatch === true;
        const orchestrator = Orchestrator.getInstance();

        if (!prompt.trim()) {
            this._postFeedback('任务提示词不能为空。');
            vscode.window.showWarningMessage('任务提示词不能为空。');
            return;
        }

        if (this._activeSessionId && !orchestrator.getSession(this._activeSessionId)) {
            this._activeSessionId = null;
            this.update();
            this._postFeedback('当前选中的会话已不存在，请重新选择一个会话。');
            vscode.window.showWarningMessage('当前选中的会话已不存在，请重新选择一个会话再创建任务。');
            return;
        }

        if (!this._activeSessionId && autoCreateSession) {
            const createdSession = orchestrator.createSessionWithResult(
                this._quickSessionName(prompt),
                '通过面板快速创建的会话。'
            );
            if (createdSession.session) {
                this._activeSessionId = createdSession.session.id;
                this.update();
                void vscode.commands.executeCommand(COMMAND_IDS.selectSession, createdSession.session.id);
            } else {
                this._handleCreateSessionResult(createdSession);
                return;
            }
        }

        if (!this._activeSessionId) {
            this._postFeedback('还没有会话。可以直接点击右侧“提问 / 规划 / 执行”自动创建快速会话，或先在左侧新建会话。');
            vscode.window.showWarningMessage('请先选择一个会话再创建任务。');
            return;
        }

        const createdTaskOutcome = orchestrator.createTaskWithResult(this._activeSessionId, prompt, mode);
        if (!createdTaskOutcome.task) {
            this._handleCreateTaskResult(createdTaskOutcome);
            return;
        }

        void this._postWebviewMessage({ type: 'clearTaskComposer' });

        if (!autoDispatch) {
            this._postFeedback(`已创建${this._modeLabel(mode)}任务，可在任务卡片中派发。`, 'info');
            return;
        }

        const chosen = orchestrator.pickAutoDispatchWorker();
        if (!chosen) {
            this._postFeedback('已创建任务，但还没有已连接的执行器。点击“启用固定 API”后再重试，或启用 Codex、Claude Code、Gemini、Aider、MCP 客户端等真实执行器。');
            vscode.window.showWarningMessage('已创建任务，但没有已连接的执行器可用于自动派发。');
            return;
        }

        const dispatchResult = await orchestrator.dispatchTask(createdTaskOutcome.task.id, chosen.id);
        this._handleDispatchResult(dispatchResult, chosen.id);
        if (dispatchResult === 'started') {
            const capabilityWarning = this._getExecuteCapabilityWarning(createdTaskOutcome.task, chosen);
            this._postFeedback(
                capabilityWarning
                    ? `已创建任务，并派发给 "${chosen.name}"。${capabilityWarning}`
                    : `已创建任务，并派发给 "${chosen.name}"。`,
                capabilityWarning ? 'warning' : 'info'
            );
        } else if (dispatchResult === 'queued') {
            const capabilityWarning = this._getExecuteCapabilityWarning(createdTaskOutcome.task, chosen);
            if (capabilityWarning) {
                this._postFeedback(`已创建任务，并加入 "${chosen.name}" 的队列。${capabilityWarning}`, 'warning');
            }
        }
    }

    private _getExecuteCapabilityWarning(task: Task | undefined, worker: Worker | undefined): string | undefined {
        if (!task || task.mode !== 'Execute' || !worker?.capabilities?.length) {
            return undefined;
        }
        const writeCapability = worker.capabilities.find(capability => capability.kind === 'workspace-write');
        if (!writeCapability) {
            return `提示：执行器“${worker.name}”没有声明项目写入能力，可能只能返回文字结果。`;
        }
        if (writeCapability.status === 'ready') {
            return undefined;
        }
        return `提示：执行器“${worker.name}”当前为“${writeCapability.label}”，可能无法真实修改项目文件。`;
    }

    private _quickSessionName(prompt: string): string {
        const compact = prompt.replace(/\s+/g, ' ').trim();
        if (!compact) return '快速会话';
        return compact.length > 18 ? `快速会话：${compact.slice(0, 18)}...` : `快速会话：${compact}`;
    }

    private _modeLabel(mode: 'Ask' | 'Plan' | 'Execute'): string {
        switch (mode) {
            case 'Ask': return '提问';
            case 'Plan': return '规划';
            case 'Execute': return '执行';
        }
    }

    private _handleDispatchResult(result: DispatchTaskResult, workerId: string): void {
        switch (result) {
            case 'queued':
                this._postFeedback(`任务已加入执行器 "${workerId}" 的队列。`, 'info');
                vscode.window.showInformationMessage(`任务已加入执行器 "${workerId}" 的队列。`);
                return;
            case 'worker-disconnected':
                this._postFeedback(`执行器 "${workerId}" 未连接，任务仍处于待处理状态。`);
                vscode.window.showWarningMessage(`执行器 "${workerId}" 未连接，任务仍处于待处理状态。`);
                return;
            case 'worker-not-found':
                this._postFeedback(`未找到执行器 "${workerId}"，请刷新或重新配置执行器。`);
                vscode.window.showWarningMessage(`未找到要派发的执行器 "${workerId}"。`);
                return;
            case 'task-not-pending':
                this._postFeedback('任务已不处于待处理状态，已跳过派发。');
                vscode.window.showWarningMessage('任务已不处于待处理状态，已跳过派发。');
                return;
            case 'task-not-found':
                this._postFeedback('未找到要派发的任务。');
                vscode.window.showWarningMessage('未找到要派发的任务。');
                return;
            case 'started':
            default:
                return;
        }
    }

    private _handleCancelTaskResult(result: CancelTaskResult): void {
        switch (result) {
            case 'task-not-found':
                vscode.window.showWarningMessage('未找到要取消的任务。');
                return;
            case 'task-not-cancelable':
                vscode.window.showWarningMessage('任务已无法取消。');
                return;
            case 'canceled':
            default:
                return;
        }
    }

    private _handleRetryTaskResult(result: RetryTaskResult): void {
        switch (result) {
            case 'task-not-found':
                vscode.window.showWarningMessage('未找到要重试的任务。');
                return;
            case 'task-not-retryable':
                vscode.window.showWarningMessage('任务已无法重试。');
                return;
            case 'retried':
            default:
                return;
        }
    }

    private _handleCreateSessionResult(outcome: CreateSessionOutcome): void {
        switch (outcome.result) {
            case 'name-required':
                vscode.window.showWarningMessage('创建会话需要填写会话名称。');
                return;
            case 'goal-required':
                vscode.window.showWarningMessage('创建会话需要填写会话目标。');
                return;
            case 'name-and-goal-required':
                vscode.window.showWarningMessage('创建会话需要填写会话名称和目标。');
                return;
            case 'created':
            default:
                return;
        }
    }

    private _handleCreateTaskResult(outcome: CreateTaskOutcome): void {
        switch (outcome.result) {
            case 'session-not-found':
                this._activeSessionId = null;
                this.update();
                vscode.window.showWarningMessage('所选会话已不存在，请在创建任务前选择一个会话。');
                return;
            case 'prompt-empty':
                vscode.window.showWarningMessage('任务提示词不能为空。');
                return;
            case 'created':
            default:
                return;
        }
    }

    private _handleUpdateSessionResult(result: UpdateSessionResult): void {
        switch (result) {
            case 'session-not-found':
                vscode.window.showWarningMessage('未找到要更新的会话。');
                return;
            case 'empty-update':
                vscode.window.showWarningMessage('请填写会话名称或目标后再保存修改。');
                return;
            case 'updated':
            default:
                return;
        }
    }

    private _handleDeleteSessionResult(sessionId: string, result: DeleteSessionResult): void {
        switch (result) {
            case 'session-not-found':
                vscode.window.showWarningMessage('未找到要删除的会话。');
                return;
            case 'deleted':
                if (this._activeSessionId === sessionId) {
                    this._activeSessionId = null;
                }
                this.update();
                return;
            default:
                return;
        }
    }

    private _handleSummarizeSessionResult(sessionId: string, outcome: SummarizeSessionOutcome): void {
        switch (outcome.result) {
            case 'session-not-found':
                this._clearMissingActiveSession(sessionId);
                vscode.window.showWarningMessage('会话不存在，无法更新摘要。');
                return;
            case 'no-completed-tasks':
                vscode.window.showWarningMessage('请至少完成一个任务后再更新会话摘要。');
                return;
            case 'worker-not-found':
                vscode.window.showWarningMessage('选定的执行器已无法生成摘要。');
                return;
            case 'summarized':
            default:
                return;
        }
    }

    private _handleRetryAllFailedResult(sessionId: string, outcome: RetryAllFailedOutcome): void {
        switch (outcome.result) {
            case 'session-not-found':
                this._clearMissingActiveSession(sessionId);
                vscode.window.showWarningMessage('未找到要重试任务的会话。');
                return;
            case 'no-retryable-tasks':
                vscode.window.showWarningMessage('没有失败或已取消的任务可重试。');
                return;
            case 'retried':
                vscode.window.showInformationMessage(`已重试 ${outcome.retriedCount} 个任务。`);
                return;
            default:
                return;
        }
    }

    private _handleCancelAllTasksResult(sessionId: string, outcome: CancelAllTasksOutcome): void {
        switch (outcome.result) {
            case 'session-not-found':
                this._clearMissingActiveSession(sessionId);
                vscode.window.showWarningMessage('未找到要取消任务的会话。');
                return;
            case 'no-cancelable-tasks':
                vscode.window.showWarningMessage('没有待处理、排队中或运行中的任务可取消。');
                return;
            case 'canceled':
                vscode.window.showInformationMessage(`已取消 ${outcome.canceledCount} 个任务。`);
                return;
            default:
                return;
        }
    }

    private _handleUpdateTaskPromptResult(result: UpdateTaskPromptResult): void {
        switch (result) {
            case 'task-not-found':
                vscode.window.showWarningMessage('未找到要更新提示词的任务。');
                return;
            case 'task-not-editable':
                vscode.window.showWarningMessage('只有处于待处理状态的任务才能更新提示词。');
                return;
            case 'prompt-empty':
                vscode.window.showWarningMessage('任务提示词不能为空。');
                return;
            case 'updated':
            default:
                return;
        }
    }

    private _handleDeleteTaskResult(result: DeleteTaskResult): void {
        switch (result) {
            case 'task-not-found':
                vscode.window.showWarningMessage('未找到要删除的任务。');
                return;
            case 'task-not-deletable':
                vscode.window.showWarningMessage('运行中或排队中的任务必须先取消才能删除。');
                return;
            case 'deleted':
            default:
                return;
        }
    }

    private _handleCloneTaskResult(outcome: CloneTaskOutcome): void {
        switch (outcome.result) {
            case 'task-not-found':
                vscode.window.showWarningMessage('未找到要克隆的任务。');
                return;
            case 'session-not-found':
                vscode.window.showWarningMessage('该任务所在的会话已不存在，无法克隆。');
                return;
            case 'cloned':
            default:
                return;
        }
    }

    private _clearMissingActiveSession(sessionId: string): void {
        if (this._activeSessionId === sessionId) {
            this._activeSessionId = null;
            this.update();
        }
    }

    private async _exportSessionToClipboard(sessionId: string): Promise<void> {
        const expSession = Orchestrator.getInstance().getSession(sessionId);
        if (!expSession) {
            this._clearMissingActiveSession(sessionId);
            vscode.window.showWarningMessage('未找到要导出的会话。');
            return;
        }
        const expTasks = Orchestrator.getInstance().getTasksForSession(expSession.id);
        const md = exportSessionMarkdown(expSession, expTasks);
        try {
            await vscode.env.clipboard.writeText(md);
            vscode.window.showInformationMessage('会话已以 Markdown 格式导出到剪贴板。');
        } catch {
            vscode.window.showErrorMessage('会话导出到剪贴板失败。');
        }
    }

    private async _connectWorker(workerId: string): Promise<void> {
        try {
            this._handleConnectWorkerResult(workerId, await Orchestrator.getInstance().connectWorker(workerId));
        } catch {
            vscode.window.showErrorMessage(`连接执行器 "${workerId}" 失败。`);
        }
    }

    private async _disconnectWorker(workerId: string): Promise<void> {
        try {
            this._handleDisconnectWorkerResult(workerId, await Orchestrator.getInstance().disconnectWorker(workerId));
        } catch {
            vscode.window.showErrorMessage(`断开执行器 "${workerId}" 失败。`);
        }
    }

    private _handleConnectWorkerResult(workerId: string, result: ConnectWorkerResult): void {
        switch (result) {
            case 'worker-not-found':
                vscode.window.showWarningMessage(`未找到要连接的执行器 "${workerId}"。`);
                return;
            case 'worker-already-connected':
                vscode.window.showWarningMessage(`执行器 "${workerId}" 已经连接。`);
                return;
            case 'worker-still-disconnected':
                vscode.window.showErrorMessage(`执行器 "${workerId}" 在连接后仍处于未连接状态。`);
                return;
            case 'connected':
            default:
                return;
        }
    }

    private _handleDisconnectWorkerResult(workerId: string, result: DisconnectWorkerResult): void {
        switch (result) {
            case 'worker-not-found':
                vscode.window.showWarningMessage(`未找到要断开的执行器 "${workerId}"。`);
                return;
            case 'worker-already-disconnected':
                vscode.window.showWarningMessage(`执行器 "${workerId}" 已经断开。`);
                return;
            case 'worker-busy':
                vscode.window.showWarningMessage(`执行器 "${workerId}" 正忙，暂时无法断开。`);
                return;
            case 'worker-still-connected':
                vscode.window.showErrorMessage(`执行器 "${workerId}" 在断开后仍处于连接状态。`);
                return;
            case 'disconnected':
            default:
                return;
        }
    }

    public dispose() {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        this._webviewReady = false;
        this._pendingWebviewMessages = [];
        MainPanel.currentPanel = undefined;
        this._unsubscribeStateChange?.();
        this._unsubscribeStateChange = undefined;
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
        this._panel.dispose();
    }

    private async _persistAutoChainSetting(enabled: boolean): Promise<void> {
        const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
        const inspected = cfg.inspect<boolean>('autoChain');
        const target = inspected?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await cfg.update('autoChain', enabled, target);
    }

    private _getHtmlForWebview() {
        const webview = this._panel.webview;
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const mainScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this._extensionUri, 'media', 'codicons', 'codicon.css'
        ));

        // Use a nonce to only allow specific scripts to be run
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
                <link href="${codiconsUri}" rel="stylesheet">
                <title>${BRAND.extensionDisplayName}</title>
            </head>
            <body>
                <div class="app-shell">
                    <header class="app-header">
                        <div class="brand-block">
                            <div class="brand-mark" aria-hidden="true"><i class="codicon codicon-extensions"></i></div>
                            <div>
                                <h1>${BRAND.extensionDisplayName}</h1>
                                <p>把开发工作拆成会话、任务和执行器队列；先接入真实执行器，再开始修改代码。</p>
                            </div>
                        </div>
                        <div class="header-actions">
                            <button class="create-self-check-btn header-self-check-btn" type="button"><i class="codicon codicon-beaker"></i><span>安全自检</span></button>
                            <button class="quick-setup-custom-api-btn header-setup-btn" type="button"><i class="codicon codicon-wand"></i><span>启用固定 API</span></button>
                            <div id="relay-health-pill" class="relay-health-pill is-hidden" role="status" aria-live="polite" title=""></div>
                        </div>
                    </header>

                    <div id="client-feedback" class="client-feedback" aria-live="polite"></div>

                    <section id="overview-panel" class="overview-panel" aria-label="当前概览"></section>

                    <section class="composer-panel" aria-label="创建任务">
                        <div class="composer-toolbar">
                            <div id="composer-session-hint" class="composer-session-hint">未选会话时会自动创建快速会话。</div>
                            <div class="composer-shortcut-hint">Cmd/Ctrl + Enter 直接执行</div>
                        </div>
                        <div class="composer-input-row">
                            <textarea id="task-prompt-input" rows="3" placeholder="输入要交给 AI 的开发任务，例如：分析这个项目并修复按钮点击无响应的问题"></textarea>
                            <div class="mode-actions" role="group" aria-label="任务模式">
                                <button class="mode-btn" data-mode="Ask"><i class="codicon codicon-comment-discussion"></i><span class="mode-btn-copy"><strong>提问</strong><small>创建并立即回答</small></span></button>
                                <button class="mode-btn" data-mode="Plan"><i class="codicon codicon-checklist"></i><span class="mode-btn-copy"><strong>规划</strong><small>创建并立即规划</small></span></button>
                                <button class="mode-btn" data-mode="Execute"><i class="codicon codicon-zap"></i><span class="mode-btn-copy"><strong>执行</strong><small>创建并立即派发</small></span></button>
                            </div>
                        </div>
                        <div id="presets-panel" class="presets-panel">
                            <button class="preset-btn" data-prompt="分析这个代码库并讲解整体架构" data-mode="Ask"><i class="codicon codicon-search"></i><span>分析</span></button>
                            <button class="preset-btn" data-prompt="为以下需求制定详细的实现方案：" data-mode="Plan"><i class="codicon codicon-checklist"></i><span>规划</span></button>
                            <button class="preset-btn" data-prompt="实现下面的功能：" data-mode="Execute"><i class="codicon codicon-zap"></i><span>执行</span></button>
                            <button class="preset-btn" data-prompt="审查并调试以下代码：" data-mode="Ask"><i class="codicon codicon-bug"></i><span>调试</span></button>
                            <button class="preset-btn" data-prompt="重构以下代码以提高质量：" data-mode="Execute"><i class="codicon codicon-tools"></i><span>重构</span></button>
                            <button class="preset-btn" data-prompt="为以下代码编写单元测试：" data-mode="Execute"><i class="codicon codicon-beaker"></i><span>测试</span></button>
                        </div>
                    </section>

                    <section id="workers-panel" class="workers-panel"></section>

                    <div class="workspace-layout">
                        <aside class="sidebar-column">
                            <section id="sessions-container" class="panel-section"></section>
                            <section id="create-session-container" class="panel-section create-session-section">
                                <div class="section-heading">
                                    <div>
                                        <h2>新建会话</h2>
                                        <p>名称与目标会用于组织后续任务。</p>
                                    </div>
                                </div>
                                <input type="text" id="session-name-input" placeholder="会话名称"/>
                                <input type="text" id="session-goal-input" placeholder="会话目标"/>
                                <button id="create-session-btn" type="button"><i class="codicon codicon-add"></i><span>创建会话</span></button>
                            </section>
                        </aside>

                        <main class="task-column">
                            <div id="task-filter-bar">
                                <input type="text" id="task-search-input" placeholder="搜索任务..." />
                                <button class="filter-btn active" data-filter="all">全部</button>
                                <button class="filter-btn" data-filter="pending">待处理</button>
                                <button class="filter-btn" data-filter="queued">排队中</button>
                                <button class="filter-btn" data-filter="running">运行中</button>
                                <button class="filter-btn" data-filter="completed">已完成</button>
                                <button class="filter-btn" data-filter="failed">失败</button>
                                <button class="filter-btn" data-filter="canceled">已取消</button>
                                <label class="auto-chain-toggle"><input type="checkbox" id="auto-chain-checkbox" /> <span class="toggle-track" aria-hidden="true"></span><span id="auto-chain-label">自动接续</span></label>
                            </div>
                            <section id="tasks-container" class="panel-section tasks-section"></section>
                        </main>
                    </div>
                </div>
                <script nonce="${nonce}" src="${mainScriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
