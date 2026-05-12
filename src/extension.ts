import * as vscode from 'vscode';
import { MainPanel } from './view/MainPanel';
import { Orchestrator, SerializedState } from './orchestrator/Orchestrator';
import { MCPWorkerAdapter } from './orchestrator/worker/MCPWorkerAdapter';
import { CodexWorkerAdapter } from './orchestrator/worker/CodexWorkerAdapter';
import { OpenCodeWorkerAdapter } from './orchestrator/worker/OpenCodeWorkerAdapter';
import { ClaudeCodeWorkerAdapter } from './orchestrator/worker/ClaudeCodeWorkerAdapter';
import { GeminiWorkerAdapter } from './orchestrator/worker/GeminiWorkerAdapter';
import { AiderWorkerAdapter } from './orchestrator/worker/AiderWorkerAdapter';
import { MCPClientWorkerAdapter } from './orchestrator/worker/MCPClientWorkerAdapter';
import { OpenAIRelayWorkerAdapter } from './orchestrator/worker/OpenAIRelayWorkerAdapter';
import { FIXED_API_CONFIG } from './config/fixedApiConfig';
import { RELAY_CONFIG } from './config/relayConfig';
import { RelayHealthMonitor } from './orchestrator/relayHealthMonitor';
import { SessionsTreeProvider } from './view/SessionsTreeProvider';
import { TasksTreeProvider } from './view/TasksTreeProvider';
import { COMMAND_IDS, CONTEXT_KEYS, EXTENSION_IDS, VIEW_IDS } from './constants/ids';
import type { CustomApiHealthSnapshot, Task, Worker, WorkerCapability } from './types';

const STATE_KEY = 'ai-dev-orchestrator.state';
const ACTIVE_SESSION_KEY = 'ai-dev-orchestrator.activeSessionId';
const CONFIG_NS = 'aiDevOrchestrator';

/**
 * Module-scoped state shared across `activate()` and `reconcileFromContext()`.
 * - `_relayHealthMonitor` is the singleton probe instance; recreated on every
 *   token rotation / settings change so config edits take effect immediately.
 * - `_currentAuthToken` is mirrored here so the monitor's `getAuthToken()`
 *   closure always reads the latest value without us having to rebuild the
 *   monitor on every keystroke.
 */
let _relayHealthMonitor: RelayHealthMonitor | undefined;
let _currentAuthToken: string | undefined;
let _currentCustomApiKey: string | undefined;

/**
 * Key under which the user's relay auth token is stored in
 * `context.secrets` (a.k.a. VS Code SecretStorage / OS keychain).
 *
 * The legacy `aiDevOrchestrator.relay.authToken` setting is still read once
 * at activation for migration purposes, then cleared from settings.
 */
const SECRET_KEY_RELAY_TOKEN = 'aiDevOrchestrator.relay.authToken';
const SECRET_KEY_CUSTOM_API_KEY = 'aiDevOrchestrator.customApi.apiKey';
const LEGACY_TOKEN_SETTING = 'relay.authToken';
const DEFAULT_FIXED_API_NAME = '固定 API';

export async function activate(context: vscode.ExtensionContext): Promise<void> {

	console.log('OrchDev AI 扩展已启动。');
	warnAboutLegacyInstall();

	const orchestrator = Orchestrator.getInstance();

	// Restore persisted state
	const saved = context.globalState.get<SerializedState>(STATE_KEY);
	if (saved) {
		orchestrator.deserialize(saved);
		console.log('已从 globalState 恢复编排状态。');
	}

	// Auto-save on state changes
	orchestrator.setOnSave(() => {
		context.globalState.update(STATE_KEY, orchestrator.serialize());
	});

	// Migrate any legacy plaintext token from settings.json to SecretStorage
	// before we touch the worker registry, so the first reconcile already
	// sees the migrated value.
	await migrateLegacyAuthToken(context.secrets);

	// Initial reconcile + react to config / secret changes
	await reconcileFromContext(orchestrator, context.secrets);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_NS)) {
				void reconcileFromContext(orchestrator, context.secrets);
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void reconcileFromContext(orchestrator, context.secrets);
		}),
		context.secrets.onDidChange(e => {
			if (e.key === SECRET_KEY_RELAY_TOKEN || e.key === SECRET_KEY_CUSTOM_API_KEY) {
				void reconcileFromContext(orchestrator, context.secrets);
			}
		})
	);

	// Register Tree Data Providers
	const sessionsProvider = new SessionsTreeProvider();
	const tasksProvider = new TasksTreeProvider();
	let activeSessionId: string | null = null;

	const sessionsView = vscode.window.createTreeView(VIEW_IDS.sessions, {
		treeDataProvider: sessionsProvider,
		showCollapseAll: true
	});
	const tasksView = vscode.window.createTreeView(VIEW_IDS.tasks, {
		treeDataProvider: tasksProvider,
		showCollapseAll: true
	});

	context.subscriptions.push(sessionsView, tasksView);

	const getFallbackSessionId = (excludeSessionId?: string | null): string | null => {
		const sessions = orchestrator.getAllSessions().filter(session => session.id !== excludeSessionId);
		return sessions.length > 0 ? sessions[sessions.length - 1].id : null;
	};

	const updateViewContext = () => {
		void vscode.commands.executeCommand('setContext', CONTEXT_KEYS.hasSessions, orchestrator.getAllSessions().length > 0);
		void vscode.commands.executeCommand('setContext', CONTEXT_KEYS.hasActiveSession, Boolean(activeSessionId && orchestrator.getSession(activeSessionId)));
	};

	const syncActiveSession = (sessionId: string | null): string | null => {
		const resolvedSessionId = sessionId && orchestrator.getSession(sessionId) ? sessionId : null;
		activeSessionId = resolvedSessionId;
		MainPanel.currentPanel?.setActiveSession(resolvedSessionId);
		sessionsProvider.setActiveSession(resolvedSessionId);
		tasksProvider.setActiveSession(resolvedSessionId);
		void context.globalState.update(ACTIVE_SESSION_KEY, resolvedSessionId);
		updateViewContext();
		return resolvedSessionId;
	};

	const openPanel = (target?: unknown) => {
		const targetSessionId = getSessionIdFromArgument(target);
		if (targetSessionId) {
			syncActiveSession(targetSessionId);
		}
		MainPanel.createOrShow(context.extensionUri);
		MainPanel.currentPanel?.setActiveSession(activeSessionId);
	};

	const refreshViews = () => {
		sessionsProvider.refresh();
		tasksProvider.refresh();
		updateViewContext();
	};

	const stateContextSubscription = orchestrator.onStateChange.subscribe(() => {
		if (activeSessionId && !orchestrator.getSession(activeSessionId)) {
			syncActiveSession(getFallbackSessionId(activeSessionId));
			return;
		}
		updateViewContext();
	});
	context.subscriptions.push({ dispose: stateContextSubscription });
	const restoredActiveSessionId = context.globalState.get<string | null>(ACTIVE_SESSION_KEY);
	const initialActiveSessionId = restoredActiveSessionId && orchestrator.getSession(restoredActiveSessionId)
		? restoredActiveSessionId
		: getFallbackSessionId();
	syncActiveSession(initialActiveSessionId);

	const handleCreateSessionResult = (result: ReturnType<Orchestrator['createSessionWithResult']>['result']) => {
		switch (result) {
			case 'name-required':
				void vscode.window.showWarningMessage('创建会话需要填写会话名称。');
				return;
			case 'goal-required':
				void vscode.window.showWarningMessage('创建会话需要填写会话目标。');
				return;
			case 'name-and-goal-required':
				void vscode.window.showWarningMessage('创建会话需要填写会话名称和目标。');
				return;
			case 'created':
			default:
				return;
		}
	};

	const handleCreateTaskResult = (result: ReturnType<Orchestrator['createTaskWithResult']>['result']) => {
		switch (result) {
			case 'session-not-found':
				syncActiveSession(null);
				void vscode.window.showWarningMessage('所选会话已不存在，请先选择一个会话。');
				return;
			case 'prompt-empty':
				void vscode.window.showWarningMessage('任务提示词不能为空。');
				return;
			case 'created':
			default:
				return;
		}
	};

	const getSessionIdFromArgument = (value: unknown): string | undefined => {
		if (typeof value === 'string') {
			return value;
		}
		if (value && typeof value === 'object') {
			const candidate = value as { session?: { id?: unknown }; sessionId?: unknown; task?: { sessionId?: unknown } };
			if (typeof candidate.session?.id === 'string') {
				return candidate.session.id;
			}
			if (typeof candidate.sessionId === 'string') {
				return candidate.sessionId;
			}
			if (typeof candidate.task?.sessionId === 'string') {
				return candidate.task.sessionId;
			}
		}
		return undefined;
	};

	const getTaskIdFromArgument = (value: unknown): string | undefined => {
		if (typeof value === 'string') {
			return value;
		}
		if (value && typeof value === 'object') {
			const candidate = value as { task?: { id?: unknown } };
			if (typeof candidate.task?.id === 'string') {
				return candidate.task.id;
			}
		}
		return undefined;
	};

		// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_IDS.start, () => {
			openPanel();
		}),
		vscode.commands.registerCommand(COMMAND_IDS.openPanel, (target?: unknown) => {
			openPanel(target);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.refreshViews, () => {
			refreshViews();
		}),
		vscode.commands.registerCommand(COMMAND_IDS.newSession, async () => {
			const name = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				prompt: '输入会话名称',
				placeHolder: '例如：修复登录流程',
			});
			if (name === undefined) return;

			const goal = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				prompt: '输入这次会话的目标',
				placeHolder: '例如：定位并修复登录失败，补充必要测试',
			});
			if (goal === undefined) return;

			const outcome = orchestrator.createSessionWithResult(name, goal);
			if (!outcome.session) {
				handleCreateSessionResult(outcome.result);
				return;
			}
			syncActiveSession(outcome.session.id);
			openPanel();
			void vscode.window.showInformationMessage(`已创建会话：${outcome.session.name}`);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.newTask, async (target?: unknown) => {
			const targetSessionId = getSessionIdFromArgument(target);
			if (targetSessionId) {
				syncActiveSession(targetSessionId);
			}

			let session = activeSessionId ? orchestrator.getSession(activeSessionId) : undefined;
			const sessions = orchestrator.getAllSessions();
			if (!session && sessions.length === 1) {
				session = orchestrator.getSession(syncActiveSession(sessions[0].id) ?? '');
			}
			if (!session && sessions.length > 1) {
				const pickedSession = await vscode.window.showQuickPick(sessions.map(candidate => ({
					label: candidate.name,
					description: candidate.goal,
					sessionId: candidate.id,
				})), {
					ignoreFocusOut: true,
					placeHolder: '选择要添加任务的会话',
				});
				if (!pickedSession) return;
				session = orchestrator.getSession(syncActiveSession(pickedSession.sessionId) ?? '');
			}
			if (!session) {
				void vscode.window.showWarningMessage('请先新建或选择一个会话。');
				return;
			}

				const prompt = await vscode.window.showInputBox({
					ignoreFocusOut: true,
					prompt: '输入任务提示词',
					placeHolder: '例如：实现固定 API 接入后的自动派发',
				});
			if (prompt === undefined) return;

			const pickedMode = await vscode.window.showQuickPick<vscode.QuickPickItem & { mode: Task['mode'] }>([
				{ label: '执行', description: '直接进入开发或修改代码', mode: 'Execute' },
				{ label: '规划', description: '先拆解方案和步骤', mode: 'Plan' },
				{ label: '提问', description: '只做分析和回答', mode: 'Ask' },
			], {
				ignoreFocusOut: true,
				placeHolder: '选择任务类型',
			});
			if (!pickedMode) return;

			const outcome = orchestrator.createTaskWithResult(session.id, prompt, pickedMode.mode);
			if (!outcome.task) {
				handleCreateTaskResult(outcome.result);
				return;
			}
			syncActiveSession(session.id);
			openPanel();
			void vscode.window.showInformationMessage('任务已添加到当前会话。');
		}),
		vscode.commands.registerCommand(COMMAND_IDS.selectSession, (target?: unknown) => {
			const sessionId = getSessionIdFromArgument(target);
			if (!sessionId) {
				syncActiveSession(null);
				void vscode.window.showWarningMessage('未找到要选择的会话。');
				return;
			}
			if (!orchestrator.getSession(sessionId)) {
				syncActiveSession(null);
				void vscode.window.showWarningMessage('未找到要选择的会话。');
				return;
			}
			syncActiveSession(sessionId);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.deleteSession, async (target?: unknown) => {
			const sessionId = getSessionIdFromArgument(target);
			if (!sessionId) {
				void vscode.window.showWarningMessage('未找到要删除的会话。');
				return;
			}
			const session = orchestrator.getSession(sessionId);
			if (!session) {
				void vscode.window.showWarningMessage('未找到要删除的会话。');
				return;
			}
			const confirmed = await vscode.window.showWarningMessage(
				`确认删除会话“${session.name}”？该会话下的任务会一并删除。`,
				{ modal: true },
				'删除'
			);
			if (confirmed !== '删除') {
				return;
			}
			if (orchestrator.deleteSession(sessionId) === 'session-not-found') {
				void vscode.window.showWarningMessage('未找到要删除的会话。');
				return;
			}
			if (sessionId === activeSessionId) {
				syncActiveSession(getFallbackSessionId(sessionId));
			}
		}),
		vscode.commands.registerCommand(COMMAND_IDS.cancelTask, (target?: unknown) => {
			const taskId = getTaskIdFromArgument(target);
			if (!taskId) {
				void vscode.window.showWarningMessage('未找到要取消的任务。');
				return;
			}
			switch (orchestrator.cancelTask(taskId)) {
				case 'task-not-found':
					void vscode.window.showWarningMessage('未找到要取消的任务。');
					return;
				case 'task-not-cancelable':
					void vscode.window.showWarningMessage('任务已无法取消。');
					return;
				case 'canceled':
				default:
					return;
			}
		}),
		vscode.commands.registerCommand(COMMAND_IDS.setRelayToken, async () => {
			const current = await context.secrets.get(SECRET_KEY_RELAY_TOKEN);
			const value = await vscode.window.showInputBox({
				password: true,
				ignoreFocusOut: true,
				prompt: `输入 ${RELAY_CONFIG.brandName} 令牌`,
				placeHolder: current ? '已保存令牌，输入新令牌可替换' : '',
				value: '',
			});
			if (value === undefined) return;
			if (value.length === 0) {
				void vscode.window.showWarningMessage('未保存空令牌。如需移除现有令牌，请使用“清除中继服务令牌”命令。');
				return;
			}
			await context.secrets.store(SECRET_KEY_RELAY_TOKEN, value);
			void vscode.window.showInformationMessage(`${RELAY_CONFIG.brandName} 令牌已保存到系统密钥存储。`);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.clearRelayToken, async () => {
			const current = await context.secrets.get(SECRET_KEY_RELAY_TOKEN);
			if (!current) {
				void vscode.window.showInformationMessage('当前没有保存中继服务令牌。');
				return;
			}
			await context.secrets.delete(SECRET_KEY_RELAY_TOKEN);
			void vscode.window.showInformationMessage(`${RELAY_CONFIG.brandName} 令牌已清除。`);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.setCustomApiKey, async () => {
			const fixedApi = getResolvedFixedApiConfig();
			const current = await context.secrets.get(SECRET_KEY_CUSTOM_API_KEY);
			const value = await vscode.window.showInputBox({
				password: true,
				ignoreFocusOut: true,
				prompt: `输入 ${fixedApi.name} 密钥`,
				placeHolder: current ? '已保存密钥，输入新密钥可替换' : '',
				value: '',
			});
			if (value === undefined) return;
			if (value.length === 0) {
				void vscode.window.showWarningMessage('未保存空 API 密钥。如需移除现有密钥，请使用“清除固定 API 密钥”命令。');
				return;
			}
			await context.secrets.store(SECRET_KEY_CUSTOM_API_KEY, value);
			await reconcileFromContext(orchestrator, context.secrets);
			void vscode.window.showInformationMessage('固定 API 密钥已保存到系统密钥存储。');
		}),
		vscode.commands.registerCommand(COMMAND_IDS.quickSetupCustomApi, async () => {
			await quickSetupCustomApi(context.secrets, orchestrator, openPanel);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.testCustomApi, async () => {
			await testCustomApiConnection(context.secrets);
		}),
		vscode.commands.registerCommand(COMMAND_IDS.createSelfCheckTask, async () => {
			await createSelfCheckTask(orchestrator, {
				getActiveSessionId: () => activeSessionId,
				syncActiveSession,
				openPanel,
			});
		}),
		vscode.commands.registerCommand(COMMAND_IDS.clearCustomApiKey, async () => {
			const current = await context.secrets.get(SECRET_KEY_CUSTOM_API_KEY);
			if (!current) {
				void vscode.window.showInformationMessage('当前没有保存固定 API 密钥。');
				return;
			}
			await context.secrets.delete(SECRET_KEY_CUSTOM_API_KEY);
			await reconcileFromContext(orchestrator, context.secrets);
			void vscode.window.showInformationMessage('固定 API 密钥已清除。');
		})
	);
}

function warnAboutLegacyInstall(): void {
	const legacyExtension = (vscode as typeof vscode & {
		extensions?: { getExtension: (id: string) => unknown };
	}).extensions?.getExtension(EXTENSION_IDS.legacy);
	if (!legacyExtension) {
		return;
	}
	void vscode.window.showWarningMessage(
		'检测到旧版“AI 开发编排”仍在安装列表中。建议先卸载旧版，只保留当前 OrchDev AI，否则两个版本可能会互相抢命令和视图，出现按钮无响应、会话状态错乱等问题。'
	);
}

interface SelfCheckTaskHost {
	getActiveSessionId(): string | null;
	syncActiveSession(sessionId: string | null): string | null;
	openPanel(): void;
}

async function createSelfCheckTask(orchestrator: Orchestrator, host: SelfCheckTaskHost): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		void vscode.window.showWarningMessage('请先打开一个项目文件夹，再创建安全自检任务。自检需要验证项目文件读取和写入能力。');
		return;
	}

	const sessionId = host.getActiveSessionId();
	let session = sessionId ? orchestrator.getSession(sessionId) : undefined;
	if (!session) {
		const createdSession = orchestrator.createSessionWithResult(
			'安全自检',
			'验证执行器能读取项目文件、写入安全自检文件，并回传修改结果。'
		);
		if (!createdSession.session) {
			void vscode.window.showWarningMessage('创建安全自检会话失败，请稍后重试。');
			return;
		}
		session = createdSession.session;
	}

	host.syncActiveSession(session.id);
	host.openPanel();

	const createdTask = orchestrator.createTaskWithResult(session.id, createSelfCheckPrompt(), 'Execute');
	if (!createdTask.task) {
		void vscode.window.showWarningMessage('创建安全自检任务失败，请稍后重试。');
		return;
	}

	const worker = orchestrator.pickAutoDispatchWorker();
	if (!worker) {
		void vscode.window.showWarningMessage('已创建安全自检任务，但还没有已连接的执行器。请先启用固定 API 或连接一个真实执行器，再点任务卡片里的“自动派发”。');
		return;
	}

	const result = await orchestrator.dispatchTask(createdTask.task.id, worker.id);
	switch (result) {
		case 'started':
			void vscode.window.showInformationMessage(`安全自检任务已创建，并派发给“${worker.name}”。`);
			return;
		case 'queued':
			void vscode.window.showInformationMessage(`安全自检任务已创建，并加入“${worker.name}”的队列。`);
			return;
		case 'worker-disconnected':
			void vscode.window.showWarningMessage(`安全自检任务已创建，但执行器“${worker.name}”已断开。`);
			return;
		case 'worker-not-found':
			void vscode.window.showWarningMessage('安全自检任务已创建，但未找到可用执行器。');
			return;
		case 'task-not-pending':
			void vscode.window.showWarningMessage('安全自检任务已创建，但状态已变化，未重复派发。');
			return;
		case 'task-not-found':
			void vscode.window.showWarningMessage('安全自检任务创建后未能找到，请刷新面板后重试。');
			return;
	}
}

function createSelfCheckPrompt(): string {
	return [
		'请执行一次安全自检，验证当前执行器是否能在这个项目里真实读取和修改文件。',
		'必须遵守以下限制：',
		'1. 只读取体量较小的项目元信息文件，例如 README.md、package.json、tsconfig.json、src 目录清单；不存在就记录为未找到，不要报错。',
		'2. 只能新建或更新 `.ai-orchestrator/self-check.md`，不要修改业务代码、配置文件、锁文件、密钥、环境变量或 git 元数据。',
		'3. 写入 `.ai-orchestrator/self-check.md` 的内容必须包含：执行时间、读取过的文件列表、能否读取项目、能否写入自检文件、下一步建议。',
		'4. 完成后用中文总结实际读取了哪些文件、修改了哪个文件，并在结果中附上 diff 或修改摘要。',
		'5. 不要运行会改变项目状态的命令；如需检测命令执行能力，只能说明本次未执行。',
	].join('\n');
}

export async function deactivate(): Promise<void> {
	// Dispose the webview first so state changes emitted during shutdown
	// don't try to post messages to a dying webview.
	MainPanel.currentPanel?.dispose();
	if (_relayHealthMonitor) {
		_relayHealthMonitor.dispose();
		_relayHealthMonitor = undefined;
	}
	await Orchestrator.getInstance().shutdown();
}

const MCP_WORKER_IDS = ['mcp-worker-1', 'mcp-worker-2'];
const CODEX_WORKER_ID = 'codex-worker';
const OPENCODE_WORKER_ID = 'opencode-worker';
const CLAUDE_WORKER_ID = 'claude-worker';
const GEMINI_WORKER_ID = 'gemini-worker';
const AIDER_WORKER_ID = 'aider-worker';
const MCP_CLIENT_WORKER_ID = 'mcp-client-worker';
const RELAY_HTTP_WORKER_ID = 'relay-http-worker';
const CUSTOM_API_WORKER_ID = 'custom-api-worker';

/**
 * Per-worker hash of the *full* options object last used to construct that
 * worker's adapter. When the hash differs (or the worker doesn't exist yet),
 * `shouldBuildWorker` tells the caller to rebuild. This is what makes
 * settings hot-reload work for ALL fields (cliPath, model, authToken, etc.)
 * — not just the auth token like the previous implementation.
 */
const _workerConfigHashes = new Map<string, string>();

function shouldBuildWorker(orchestrator: Orchestrator, id: string, hash: string): boolean {
	const lastHash = _workerConfigHashes.get(id);
	if (lastHash !== hash) {
		if (orchestrator.hasWorkerAdapter(id)) {
			orchestrator.unregisterWorkerAdapter(id);
		}
		_workerConfigHashes.set(id, hash);
		return true;
	}
	return !orchestrator.hasWorkerAdapter(id);
}

function unregisterWorker(orchestrator: Orchestrator, id: string): void {
	if (orchestrator.hasWorkerAdapter(id)) {
		orchestrator.unregisterWorkerAdapter(id);
	}
	_workerConfigHashes.delete(id);
}

function setWorkerCapabilities(worker: Worker, capabilities: WorkerCapability[]): void {
	worker.capabilities = capabilities;
}

function cliWorkerCapabilities(cwd: string | undefined, options: { sandbox?: string; codeFocused?: boolean } = {}): WorkerCapability[] {
	const hasWorkspace = Boolean(cwd);
	const capabilities: WorkerCapability[] = [
		{
			kind: 'cli-project',
			label: hasWorkspace ? '项目内运行' : '未打开项目',
			status: hasWorkspace ? 'ready' : 'warning',
			description: hasWorkspace
				? '执行器会在当前项目文件夹中运行。'
				: '没有打开项目文件夹，执行器可能只能在默认目录运行。',
		},
	];

	if (options.sandbox === 'read-only') {
		capabilities.push({
			kind: 'workspace-write',
			label: '只读沙箱',
			status: 'warning',
			description: '当前沙箱限制为只读，适合分析，不适合直接改代码。',
		});
	} else {
		capabilities.push({
			kind: 'workspace-write',
			label: hasWorkspace ? '可开发代码' : '需打开项目',
			status: hasWorkspace ? 'ready' : 'warning',
			description: options.codeFocused
				? '该执行器面向项目代码修改，实际权限仍受对应 CLI 和项目配置影响。'
				: '实际文件读写能力取决于对应 CLI、模型和项目权限。',
		});
	}

	return capabilities;
}

function mcpPlaceholderCapabilities(): WorkerCapability[] {
	return [{
		kind: 'placeholder',
		label: '占位执行器',
		status: 'warning',
		description: '仅用于演示调度，不建议用于真实项目开发。',
	}];
}

function mcpClientCapabilities(cwd: string | undefined): WorkerCapability[] {
	return [
		{
			kind: 'mcp-tool',
			label: 'MCP 工具',
			status: 'info',
			description: '真实能力取决于所连接的 MCP 服务和工具实现。',
		},
		{
			kind: 'cli-project',
			label: cwd ? '项目上下文' : '未打开项目',
			status: cwd ? 'ready' : 'warning',
			description: cwd ? '已把当前项目目录传给 MCP 服务。' : '未打开项目文件夹，MCP 服务可能没有项目上下文。',
		},
	];
}

function openAiWorkerCapabilities(options: {
	enableWorkspaceTools: boolean;
	allowCommandExecution: boolean;
	workspaceRoot?: string;
}): WorkerCapability[] {
	const hasWorkspace = Boolean(options.workspaceRoot);
	if (!options.enableWorkspaceTools) {
		return [
			{
				kind: 'api-tools',
				label: '仅文本响应',
				status: 'warning',
				description: '没有启用工作区工具，执行模式可能只能返回文字，不能直接改项目文件。',
			},
		];
	}
	if (!hasWorkspace) {
		return [
			{
				kind: 'workspace-read',
				label: '未打开项目',
				status: 'warning',
				description: '工作区工具已启用，但当前没有项目文件夹可读写。',
			},
			{
				kind: 'workspace-write',
				label: '写入不可用',
				status: 'disabled',
				description: '打开项目文件夹后，执行模式才能通过工作区工具写入文件。',
			},
		];
	}

	return [
		{
			kind: 'api-tools',
			label: '需测试工具调用',
			status: 'info',
			description: '请使用“测试固定 API”确认模型会返回 OpenAI 兼容工具调用。',
		},
		{
			kind: 'workspace-read',
			label: '可读项目',
			status: 'ready',
			description: '提问、规划和执行模式都可以读取、搜索当前项目文件。',
		},
		{
			kind: 'workspace-write',
			label: '执行可写',
			status: 'ready',
			description: '执行模式可以通过工作区工具修改当前项目文件。',
		},
		{
			kind: 'command-execution',
			label: options.allowCommandExecution ? '命令已开启' : '命令关闭',
			status: options.allowCommandExecution ? 'warning' : 'disabled',
			description: options.allowCommandExecution
				? '执行器可以在项目目录运行命令，请只在可信任务中开启。'
				: '默认不允许 API 执行器运行本地命令，文件读写仍可用。',
		},
	];
}

/**
 * Migrate any pre-existing plaintext relay token from settings.json into
 * the OS-backed SecretStorage and remove it from settings. Idempotent:
 * if SecretStorage already has the same value, just clears settings.
 */
async function migrateLegacyAuthToken(secrets: vscode.SecretStorage): Promise<void> {
	const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
	const legacy = (cfg.get<string>(LEGACY_TOKEN_SETTING) || '').trim();
	if (legacy.length === 0) return;

	const existing = await secrets.get(SECRET_KEY_RELAY_TOKEN);
	if (existing !== legacy) {
		await secrets.store(SECRET_KEY_RELAY_TOKEN, legacy);
	}
	// Best-effort wipe of the legacy setting — both global and workspace
	// scopes — so subsequent settings sync doesn't reintroduce it.
	try {
		await cfg.update(LEGACY_TOKEN_SETTING, undefined, vscode.ConfigurationTarget.Global);
	} catch { /* setting may not exist at this scope; ignore */ }
	try {
		await cfg.update(LEGACY_TOKEN_SETTING, undefined, vscode.ConfigurationTarget.Workspace);
	} catch { /* ignore */ }
	void vscode.window.showInformationMessage(
		`${RELAY_CONFIG.brandName} 中继服务令牌已从 settings.json 迁移到系统密钥存储。`
	);
}

interface ResolvedFixedApiConfig {
	enabled: boolean;
	name: string;
	baseUrl: string;
	wireApi: 'chat_completions' | 'responses';
	model: string;
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
	disableResponseStorage: boolean;
	systemPrompt: string | undefined;
	timeoutMs: number;
	enableWorkspaceTools: boolean;
	allowCommandExecution: boolean;
	maxToolIterations: number;
	apiKeyOptional: boolean;
}

function normalizeOpenAiBaseUrl(value: string): string {
	return value.trim().replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/g, '');
}

function getResolvedFixedApiConfig(): ResolvedFixedApiConfig {
	return {
		enabled: FIXED_API_CONFIG.enabled,
		name: nonEmpty(FIXED_API_CONFIG.name.trim()) || DEFAULT_FIXED_API_NAME,
		baseUrl: normalizeOpenAiBaseUrl(FIXED_API_CONFIG.baseUrl),
		wireApi: FIXED_API_CONFIG.wireApi,
		model: FIXED_API_CONFIG.model.trim(),
		reasoningEffort: FIXED_API_CONFIG.reasoningEffort,
		disableResponseStorage: FIXED_API_CONFIG.disableResponseStorage,
		systemPrompt: nonEmpty(FIXED_API_CONFIG.systemPrompt.trim()),
		timeoutMs: Math.max(1_000, FIXED_API_CONFIG.timeoutMs),
		enableWorkspaceTools: FIXED_API_CONFIG.enableWorkspaceTools,
		allowCommandExecution: FIXED_API_CONFIG.allowCommandExecution,
		maxToolIterations: Math.max(1, FIXED_API_CONFIG.maxToolIterations),
		apiKeyOptional: FIXED_API_CONFIG.apiKeyOptional,
	};
}

function getFixedApiSetupIssue(config = getResolvedFixedApiConfig()): string | undefined {
	if (!config.enabled) {
		return '固定 API 执行器已在 src/config/fixedApiConfig.ts 中关闭。';
	}
	if (!config.baseUrl || !config.model) {
		return '固定 API 还没有在 src/config/fixedApiConfig.ts 中配置 baseUrl 和 model。';
	}
	try {
		// eslint-disable-next-line no-new
		new URL(config.baseUrl);
	} catch {
		return '固定 API 的 baseUrl 不是合法 URL，请检查 src/config/fixedApiConfig.ts。';
	}
	return undefined;
}

async function quickSetupCustomApi(
	secrets: vscode.SecretStorage,
	orchestrator: Orchestrator,
	openPanel: () => void,
): Promise<void> {
	const fixedApi = getResolvedFixedApiConfig();
	const issue = getFixedApiSetupIssue(fixedApi);
	if (issue) {
		updateCustomApiHealth({ status: 'untested', name: fixedApi.name, model: fixedApi.model, message: issue });
		void vscode.window.showWarningMessage(issue);
		return;
	}

	const currentKey = await secrets.get(SECRET_KEY_CUSTOM_API_KEY);
	const apiKey = await vscode.window.showInputBox({
		password: true,
		ignoreFocusOut: true,
		prompt: fixedApi.apiKeyOptional ? `输入 ${fixedApi.name} 密钥，可留空` : `输入 ${fixedApi.name} 密钥`,
		placeHolder: currentKey
			? (
				fixedApi.apiKeyOptional
					? '已保存密钥，输入新密钥可替换；留空则清除旧密钥'
					: '已保存密钥，输入新密钥可替换；留空则继续使用当前密钥'
			)
			: fixedApi.apiKeyOptional ? '本地服务通常可留空' : 'sk-...',
		value: '',
	});
	if (apiKey === undefined) return;
	const trimmedApiKey = apiKey.trim();

	if (!fixedApi.apiKeyOptional && !trimmedApiKey && !currentKey) {
		void vscode.window.showWarningMessage(`固定 API“${fixedApi.name}”需要密钥。若你的接口确实不需要密钥，请在 src/config/fixedApiConfig.ts 中把 apiKeyOptional 改为 true。`);
		return;
	}

	if (trimmedApiKey) {
		await secrets.store(SECRET_KEY_CUSTOM_API_KEY, trimmedApiKey);
	} else if (fixedApi.apiKeyOptional && currentKey) {
		await secrets.delete(SECRET_KEY_CUSTOM_API_KEY);
	}

	await reconcileFromContext(orchestrator, secrets);
	openPanel();
	MainPanel.updateCustomApiHealth({
		status: 'untested',
		name: fixedApi.name,
		model: fixedApi.model,
		message: '已完成固定 API 设置，建议点击“测试固定 API”确认工具调用能力。',
		lastCheckedAt: Date.now(),
	});

	const workspaceNote = vscode.workspace.workspaceFolders?.length
		? ''
		: ' 请先打开项目文件夹，执行模式才能读取和修改项目文件。';
	const keyNote = trimmedApiKey
		? '已保存访问密钥。'
		: fixedApi.apiKeyOptional
			? currentKey ? '已清除旧密钥，当前按无密钥方式运行。' : '当前按无密钥方式运行。'
			: '继续使用已保存密钥。';
	const toolsNote = fixedApi.enableWorkspaceTools ? '已开启项目文件读写工具' : '当前未开启项目文件读写工具';
	const commandNote = fixedApi.allowCommandExecution ? '本地命令执行已开启' : '本地命令执行仍保持关闭';
	void vscode.window.showInformationMessage(
		`固定 API 执行器“${fixedApi.name}”已就绪，${keyNote} ${toolsNote}；${commandNote}。${workspaceNote}`
	);
}

async function testCustomApiConnection(secrets: vscode.SecretStorage): Promise<void> {
	const fixedApi = getResolvedFixedApiConfig();
	const baseUrl = fixedApi.baseUrl;
	const model = fixedApi.model;
	const name = fixedApi.name;
	const authToken = (await secrets.get(SECRET_KEY_CUSTOM_API_KEY)) || '';
	const shouldTestTools = fixedApi.enableWorkspaceTools;

	const issue = getFixedApiSetupIssue(fixedApi);
	if (issue) {
		updateCustomApiHealth({ status: 'untested', name, model, message: issue });
		void vscode.window.showWarningMessage(issue);
		return;
	}
	if (!fixedApi.apiKeyOptional && authToken.length === 0) {
		updateCustomApiHealth({ status: 'untested', name, model, message: '固定 API 需要密钥，但当前还没有保存。' });
		void vscode.window.showWarningMessage('固定 API 需要密钥，请先运行“设置固定 API 密钥”或“启用固定 API”。');
		return;
	}
	if (typeof globalThis.fetch !== 'function') {
		updateCustomApiHealth({ status: 'failed', name, model, message: '当前运行环境不支持 fetch。' });
		void vscode.window.showErrorMessage('当前运行环境不支持 fetch，无法测试固定 API 连接。');
		return;
	}

	updateCustomApiHealth({ status: 'testing', name, model, message: '正在测试基础连接和工具调用能力。' });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (authToken.length > 0) {
			headers.Authorization = `Bearer ${authToken}`;
		}
		const res = fixedApi.wireApi === 'responses'
			? await globalThis.fetch(`${baseUrl}/responses`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model,
					input: [{ role: 'user', content: [{ type: 'input_text', text: '请只回复 ok' }] }],
					...(fixedApi.reasoningEffort ? { reasoning: { effort: fixedApi.reasoningEffort } } : {}),
					...(fixedApi.disableResponseStorage ? { store: false } : {}),
				}),
				signal: controller.signal,
			})
			: await globalThis.fetch(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model,
					messages: [{ role: 'user', content: '请只回复 ok' }],
					stream: false,
					max_tokens: 8,
				}),
				signal: controller.signal,
			});
		if (!res.ok) {
			const body = await safeReadResponseText(res);
			const message = `HTTP ${res.status} ${truncateForMessage(body || res.statusText)}`;
			updateCustomApiHealth({ status: 'failed', name, model, message });
			void vscode.window.showErrorMessage(
				`${name} 连接测试失败：${message}`
			);
			return;
		}
		if (!shouldTestTools) {
			updateCustomApiHealth({ status: 'no-tools', name, model, message: '基础连接通过，但当前配置未启用工作区工具。' });
			void vscode.window.showInformationMessage(`${name} 连接测试通过，模型“${model}”可响应。`);
			return;
		}
		const toolResult = fixedApi.wireApi === 'responses'
			? await testCustomApiResponsesToolCalling(baseUrl, model, headers, controller.signal, fixedApi)
			: await testCustomApiToolCalling(baseUrl, model, headers, controller.signal);
		if (toolResult.ok) {
			updateCustomApiHealth({ status: 'ok', name, model, message: '基础连接和工具调用测试均通过。' });
			void vscode.window.showInformationMessage(`${name} 连接测试通过，模型“${model}”支持工具调用，可用于执行模式修改项目文件。`);
			return;
		}
		updateCustomApiHealth({ status: 'no-tools', name, model, message: toolResult.message });
		void vscode.window.showWarningMessage(
			`${name} 基础连接可用，但未确认工具调用能力：${toolResult.message} 执行模式可能只能返回文字，不能真实修改项目文件。`
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateCustomApiHealth({ status: 'failed', name, model, message });
		void vscode.window.showErrorMessage(`${name} 连接测试失败：${message}`);
	} finally {
		clearTimeout(timer);
	}
}

function updateCustomApiHealth(snapshot: Omit<CustomApiHealthSnapshot, 'lastCheckedAt'> & { lastCheckedAt?: number }): void {
	MainPanel.updateCustomApiHealth({
		...snapshot,
		lastCheckedAt: snapshot.lastCheckedAt ?? Date.now(),
	});
}

async function testCustomApiToolCalling(
	baseUrl: string,
	model: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
	const buildBody = (forceToolChoice: boolean): Record<string, unknown> => ({
		model,
		messages: [{ role: 'user', content: '请调用 workspace_capability_check 工具完成测试。' }],
		tools: [{
			type: 'function',
			function: {
				name: 'workspace_capability_check',
				description: '检测模型是否能返回 OpenAI 兼容工具调用。',
				parameters: {
					type: 'object',
					properties: {
						ok: { type: 'boolean', description: '固定传 true。' },
					},
					required: ['ok'],
					additionalProperties: false,
				},
			},
		}],
		...(forceToolChoice ? {
			tool_choice: {
				type: 'function',
				function: { name: 'workspace_capability_check' },
			},
		} : {}),
		stream: false,
		max_tokens: 32,
	});
	const request = async (forceToolChoice: boolean): Promise<Response> => await globalThis.fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(buildBody(forceToolChoice)),
		signal,
	});

	let res = await request(true);
	if (!res.ok) {
		const body = await safeReadResponseText(res);
		if (looksLikeToolChoiceCompatibilityError(res.status, body)) {
			res = await request(false);
			if (!res.ok) {
				const retryBody = await safeReadResponseText(res);
				return { ok: false, message: `工具调用测试 HTTP ${res.status} ${truncateForMessage(retryBody || res.statusText)}` };
			}
		} else {
			return { ok: false, message: `工具调用测试 HTTP ${res.status} ${truncateForMessage(body || res.statusText)}` };
		}
	}
	let payload: unknown;
	try {
		payload = await res.json();
	} catch {
		return { ok: false, message: '工具调用测试响应不是合法 JSON。' };
	}
	return hasWorkspaceCapabilityToolCall(payload)
		? { ok: true, message: '已返回工具调用。' }
		: { ok: false, message: '响应中没有工具调用。' };
}

async function testCustomApiResponsesToolCalling(
	baseUrl: string,
	model: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	config: ResolvedFixedApiConfig,
): Promise<{ ok: boolean; message: string }> {
	const tool = {
		type: 'function',
		name: 'workspace_capability_check',
		description: '检测模型是否能返回 OpenAI Responses 兼容工具调用。',
		parameters: {
			type: 'object',
			properties: {
				ok: { type: 'boolean', description: '固定传 true。' },
			},
			required: ['ok'],
			additionalProperties: false,
		},
	};
	const request = async (): Promise<Response> => await globalThis.fetch(`${baseUrl}/responses`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			model,
			input: [{ role: 'user', content: [{ type: 'input_text', text: '请调用 workspace_capability_check 工具完成测试。' }] }],
			tools: [tool],
			tool_choice: { type: 'function', name: 'workspace_capability_check' },
			...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
			...(config.disableResponseStorage ? { store: false } : {}),
		}),
		signal,
	});

	const res = await request();
	if (!res.ok) {
		const body = await safeReadResponseText(res);
		return { ok: false, message: `工具调用测试 HTTP ${res.status} ${truncateForMessage(body || res.statusText)}` };
	}
	let payload: unknown;
	try {
		payload = await res.json();
	} catch {
		return { ok: false, message: '工具调用测试响应不是合法 JSON。' };
	}
	return hasResponsesCapabilityToolCall(payload)
		? { ok: true, message: '已返回工具调用。' }
		: { ok: false, message: '响应中没有工具调用。' };
}

function looksLikeToolChoiceCompatibilityError(status: number, body: string): boolean {
	if (status !== 400 && status !== 422) return false;
	const normalized = body.toLowerCase();
	return normalized.includes('tool_choice')
		|| normalized.includes('unknown parameter')
		|| normalized.includes('unsupported parameter')
		|| normalized.includes('unrecognized request argument');
}

function hasWorkspaceCapabilityToolCall(payload: unknown): boolean {
	const response = payload as {
		choices?: Array<{
			message?: {
				tool_calls?: Array<{ function?: { name?: string } }>;
				function_call?: { name?: string };
			};
		}>;
	};
	const message = response.choices?.[0]?.message;
	const toolCalls = message?.tool_calls;
	return (Array.isArray(toolCalls)
		&& toolCalls.some(call => call.function?.name === 'workspace_capability_check')
		) || message?.function_call?.name === 'workspace_capability_check';
}

function hasResponsesCapabilityToolCall(payload: unknown): boolean {
	const response = payload as {
		output?: Array<{
			type?: string;
			name?: string;
		}>;
	};
	return Array.isArray(response.output)
		&& response.output.some(item => item.type === 'function_call' && item.name === 'workspace_capability_check');
}

async function safeReadResponseText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}

function truncateForMessage(text: string, max = 240): string {
	const compact = text.replace(/\s+/g, ' ').trim();
	return compact.length <= max ? compact : `${compact.slice(0, max)}...`;
}

async function reconcileFromContext(orchestrator: Orchestrator, secrets: vscode.SecretStorage): Promise<void> {
	const stored = await secrets.get(SECRET_KEY_RELAY_TOKEN);
	const authToken = stored && stored.length > 0 ? stored : undefined;
	const customStored = await secrets.get(SECRET_KEY_CUSTOM_API_KEY);
	const customApiKey = customStored && customStored.length > 0 ? customStored : undefined;
	_currentAuthToken = authToken;
	_currentCustomApiKey = customApiKey;
	registerWorkers(orchestrator, authToken, customApiKey);
	applyHealthCheckInterval(orchestrator);
	applyAutoChain(orchestrator);
	applyRecoveryOptions(orchestrator);
	applyRelayHealthMonitor();
}

/**
 * (Re)configure the relay health monitor based on current settings + token.
 *
 * Called on every reconcile, so toggling `relayHealth.intervalMs`, rotating
 * the token, or flipping `RELAY_CONFIG.enabled` immediately rebuilds the
 * probe loop. The monitor itself is resilient to "disabled" inputs and will
 * just emit a `disabled` snapshot rather than throwing.
 */
function applyRelayHealthMonitor(): void {
	const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
	const intervalMs = cfg.get<number>('relayHealth.intervalMs', 60_000);

	if (_relayHealthMonitor) {
		// Update in place rather than rebuild so an in-flight probe isn't
		// cancelled mid-tick by a config event the user didn't trigger.
		_relayHealthMonitor.updateOptions({
			intervalMs,
			getAuthToken: () => _currentAuthToken,
		});
		return;
	}

	_relayHealthMonitor = new RelayHealthMonitor({
		intervalMs,
		getAuthToken: () => _currentAuthToken,
		onChange: (snapshot) => {
			// Forward to the webview if it's open. The static stash inside
			// MainPanel keeps the latest snapshot ready even when the panel
			// is closed, so opening it later always shows the current state.
			MainPanel.updateRelayHealth(snapshot);
		},
	});
	_relayHealthMonitor.start();
}

function registerWorkers(orchestrator: Orchestrator, authToken: string | undefined, customApiKey: string | undefined): void {
	const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
	const mcpEnabled = cfg.get<boolean>('mcp.enabled', false);
	const codexEnabled = cfg.get<boolean>('codex.enabled', false);
	const opencodeEnabled = cfg.get<boolean>('opencode.enabled', false);
	const claudeEnabled = cfg.get<boolean>('claude.enabled', false);
	const geminiEnabled = cfg.get<boolean>('gemini.enabled', false);
	const aiderEnabled = cfg.get<boolean>('aider.enabled', false);
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	// --- MCP placeholder workers (no per-instance config beyond enabled) ---
	if (mcpEnabled) {
		MCP_WORKER_IDS.forEach((id, idx) => {
			if (!orchestrator.hasWorkerAdapter(id)) {
				const adapter = new MCPWorkerAdapter(id, `MCP 执行器 ${idx + 1}`);
				setWorkerCapabilities(adapter.worker, mcpPlaceholderCapabilities());
				orchestrator.registerWorkerAdapter(adapter);
				adapter.connect().catch(err => console.error(`Failed to connect ${id}:`, err));
			}
		});
	} else {
		MCP_WORKER_IDS.forEach(id => orchestrator.unregisterWorkerAdapter(id));
	}

	// --- Codex worker ---
	if (codexEnabled) {
		const opts = {
			cliPath: cfg.get<string>('codex.cliPath') || 'codex',
			model: nonEmpty(cfg.get<string>('codex.model')),
			sandbox: cfg.get<'read-only' | 'workspace-write' | 'danger-full-access'>('codex.sandbox') || undefined,
			cwd,
			authToken
		};
		if (shouldBuildWorker(orchestrator, CODEX_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new CodexWorkerAdapter(CODEX_WORKER_ID, 'Codex', opts);
			setWorkerCapabilities(adapter.worker, cliWorkerCapabilities(cwd, { sandbox: opts.sandbox, codeFocused: true }));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect Codex:', err));
		}
	} else {
		unregisterWorker(orchestrator, CODEX_WORKER_ID);
	}

	// --- OpenCode worker ---
	if (opencodeEnabled) {
		const opts = {
			cliPath: cfg.get<string>('opencode.cliPath') || 'opencode',
			model: nonEmpty(cfg.get<string>('opencode.model')),
			cwd,
			authToken
		};
		if (shouldBuildWorker(orchestrator, OPENCODE_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new OpenCodeWorkerAdapter(OPENCODE_WORKER_ID, 'OpenCode', opts);
			setWorkerCapabilities(adapter.worker, cliWorkerCapabilities(cwd, { codeFocused: true }));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect OpenCode:', err));
		}
	} else {
		unregisterWorker(orchestrator, OPENCODE_WORKER_ID);
	}

	// --- Claude Code worker ---
	if (claudeEnabled) {
		const opts = {
			cliPath: cfg.get<string>('claude.cliPath') || 'claude',
			model: nonEmpty(cfg.get<string>('claude.model')),
			cwd,
			authToken
		};
		if (shouldBuildWorker(orchestrator, CLAUDE_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new ClaudeCodeWorkerAdapter(CLAUDE_WORKER_ID, 'Claude Code', opts);
			setWorkerCapabilities(adapter.worker, cliWorkerCapabilities(cwd, { codeFocused: true }));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect Claude Code:', err));
		}
	} else {
		unregisterWorker(orchestrator, CLAUDE_WORKER_ID);
	}

	// --- Gemini worker ---
	if (geminiEnabled) {
		const opts = {
			cliPath: cfg.get<string>('gemini.cliPath') || 'gemini',
			model: nonEmpty(cfg.get<string>('gemini.model')),
			cwd,
			authToken
		};
		if (shouldBuildWorker(orchestrator, GEMINI_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new GeminiWorkerAdapter(GEMINI_WORKER_ID, 'Gemini', opts);
			setWorkerCapabilities(adapter.worker, cliWorkerCapabilities(cwd, { codeFocused: true }));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect Gemini:', err));
		}
	} else {
		unregisterWorker(orchestrator, GEMINI_WORKER_ID);
	}

	// --- Aider worker ---
	if (aiderEnabled) {
		const opts = {
			cliPath: cfg.get<string>('aider.cliPath') || 'aider',
			model: nonEmpty(cfg.get<string>('aider.model')),
			autoConfirm: cfg.get<boolean>('aider.autoConfirm', true),
			cwd,
			authToken
		};
		if (shouldBuildWorker(orchestrator, AIDER_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new AiderWorkerAdapter(AIDER_WORKER_ID, 'Aider', opts);
			setWorkerCapabilities(adapter.worker, cliWorkerCapabilities(cwd, { codeFocused: true }));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect Aider:', err));
		}
	} else {
		unregisterWorker(orchestrator, AIDER_WORKER_ID);
	}

	// --- MCP client worker (real MCP via @modelcontextprotocol/sdk) ---
	const mcpClientEnabled = cfg.get<boolean>('mcpClient.enabled', false);
	const mcpCommand = cfg.get<string>('mcpClient.command') || '';
	const mcpToolName = cfg.get<string>('mcpClient.toolName') || '';
	if (mcpClientEnabled && mcpCommand.length > 0 && mcpToolName.length > 0) {
		const opts = {
			command: mcpCommand,
			args: cfg.get<string[]>('mcpClient.args') || [],
			toolName: mcpToolName,
			promptArgName: cfg.get<string>('mcpClient.promptArgName') || 'prompt',
			cwd
		};
		if (shouldBuildWorker(orchestrator, MCP_CLIENT_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new MCPClientWorkerAdapter(MCP_CLIENT_WORKER_ID, 'MCP Client', opts);
			setWorkerCapabilities(adapter.worker, mcpClientCapabilities(cwd));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect MCP client:', err));
		}
	} else {
		unregisterWorker(orchestrator, MCP_CLIENT_WORKER_ID);
		if (mcpClientEnabled && (mcpCommand.length === 0 || mcpToolName.length === 0)) {
			console.warn('MCP client worker is enabled but command or toolName is empty; skipping registration.');
		}
	}

	// --- HTTP Relay worker (built-in, no CLI dependency) ---
	const relayHttpEnabled = cfg.get<boolean>('relayHttp.enabled', false) && RELAY_CONFIG.enabled;
	if (relayHttpEnabled) {
		const opts = {
			authToken,
			model: nonEmpty(cfg.get<string>('relayHttp.model')),
			systemPrompt: nonEmpty(cfg.get<string>('relayHttp.systemPrompt')),
			timeoutMs: cfg.get<number>('relayHttp.timeoutMs', 120_000),
			enableWorkspaceTools: cfg.get<boolean>('relayHttp.enableWorkspaceTools', false),
			allowCommandExecution: cfg.get<boolean>('relayHttp.allowCommandExecution', false),
			maxToolIterations: cfg.get<number>('relayHttp.maxToolIterations', 20),
			workspaceRoot: cwd,
		};
		if (shouldBuildWorker(orchestrator, RELAY_HTTP_WORKER_ID, JSON.stringify(opts))) {
			const adapter = new OpenAIRelayWorkerAdapter(RELAY_HTTP_WORKER_ID, RELAY_CONFIG.brandName, opts);
			setWorkerCapabilities(adapter.worker, openAiWorkerCapabilities({
				enableWorkspaceTools: opts.enableWorkspaceTools,
				allowCommandExecution: opts.allowCommandExecution,
				workspaceRoot: opts.workspaceRoot,
			}));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect HTTP relay:', err));
		}
	} else {
		unregisterWorker(orchestrator, RELAY_HTTP_WORKER_ID);
	}

	// --- Fixed OpenAI-compatible API worker (source-configured, no CLI dependency) ---
	const fixedApi = getResolvedFixedApiConfig();
	const fixedApiCanAuthenticate = fixedApi.apiKeyOptional || Boolean(customApiKey);
	if (!getFixedApiSetupIssue(fixedApi) && fixedApiCanAuthenticate) {
		const opts = {
			authToken: customApiKey,
			baseUrl: fixedApi.baseUrl,
			wireApi: fixedApi.wireApi,
			model: fixedApi.model,
			reasoningEffort: fixedApi.reasoningEffort,
			disableResponseStorage: fixedApi.disableResponseStorage,
			systemPrompt: fixedApi.systemPrompt,
			timeoutMs: fixedApi.timeoutMs,
			requireRelayEnabled: false,
			enableWorkspaceTools: fixedApi.enableWorkspaceTools,
			allowCommandExecution: fixedApi.allowCommandExecution,
			maxToolIterations: fixedApi.maxToolIterations,
			workspaceRoot: cwd,
		};
		const name = fixedApi.name;
		if (shouldBuildWorker(orchestrator, CUSTOM_API_WORKER_ID, JSON.stringify({ name, ...opts }))) {
			const adapter = new OpenAIRelayWorkerAdapter(CUSTOM_API_WORKER_ID, name, opts);
			setWorkerCapabilities(adapter.worker, openAiWorkerCapabilities({
				enableWorkspaceTools: opts.enableWorkspaceTools,
				allowCommandExecution: opts.allowCommandExecution,
				workspaceRoot: opts.workspaceRoot,
			}));
			orchestrator.registerWorkerAdapter(adapter);
			adapter.connect().catch(err => console.error('Failed to connect custom API worker:', err));
		}
	} else {
		unregisterWorker(orchestrator, CUSTOM_API_WORKER_ID);
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	return value && value.length > 0 ? value : undefined;
}

function applyHealthCheckInterval(orchestrator: Orchestrator): void {
	const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
	const intervalMs = cfg.get<number>('healthCheck.intervalMs', 30_000);
	orchestrator.startHealthCheck(intervalMs);
}

function applyAutoChain(orchestrator: Orchestrator): void {
	const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
	orchestrator.autoChain = cfg.get<boolean>('autoChain', false);
}

function applyRecoveryOptions(orchestrator: Orchestrator): void {
	const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
	orchestrator.configureRecovery({
		autoRetry: cfg.get<boolean>('recovery.autoRetry', true),
		maxRetries: cfg.get<number>('recovery.maxRetries', 3),
		baseDelayMs: cfg.get<number>('recovery.baseDelayMs', 10_000),
		maxDelayMs: cfg.get<number>('recovery.maxDelayMs', 30_000),
	});
}

// Test-only hook to reset module-scoped state between tests. Safe to call
// from production but generally a no-op in real usage.
export function __resetWorkerConfigHashesForTesting(): void {
	_workerConfigHashes.clear();
	if (_relayHealthMonitor) {
		_relayHealthMonitor.dispose();
		_relayHealthMonitor = undefined;
	}
	_currentAuthToken = undefined;
	_currentCustomApiKey = undefined;
}
