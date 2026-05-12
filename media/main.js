// @ts-ignore

const vscode = acquireVsCodeApi();

let activeSessionId = null;
let activeFilter = 'all';
let lastTasks = [];
let lastSessions = [];
let lastWorkers = [];
let sessionStats = {};
let searchQuery = '';
let customApiHealth = null;
const pendingActions = new Set();
let clientFeedbackTimer = null;
const invalidInputTimers = new WeakMap();

function clearSessionCreatorInputs() {
    const nameInput = document.getElementById('session-name-input');
    const goalInput = document.getElementById('session-goal-input');
    if (nameInput) {
        nameInput.value = '';
        clearInvalidInput(nameInput);
    }
    if (goalInput) {
        goalInput.value = '';
        clearInvalidInput(goalInput);
    }
}

function clearTaskComposerInput() {
    const promptInput = document.getElementById('task-prompt-input');
    if (promptInput) {
        promptInput.value = '';
        clearInvalidInput(promptInput);
    }
}

function clearClientFeedback() {
    const feedback = document.getElementById('client-feedback');
    if (clientFeedbackTimer) {
        clearTimeout(clientFeedbackTimer);
        clientFeedbackTimer = null;
    }
    if (!feedback) return;
    feedback.textContent = '';
    feedback.className = 'client-feedback';
}

function showClientFeedback(message, tone = 'warning') {
    const feedback = document.getElementById('client-feedback');
    if (!feedback) return;
    if (clientFeedbackTimer) {
        clearTimeout(clientFeedbackTimer);
    }
    feedback.textContent = message;
    feedback.className = `client-feedback is-visible is-${tone}`;
    clientFeedbackTimer = setTimeout(() => {
        clearClientFeedback();
    }, 3500);
}

function clearInvalidInput(input) {
    if (!input) return;
    const timer = invalidInputTimers.get(input);
    if (timer) {
        clearTimeout(timer);
        invalidInputTimers.delete(input);
    }
    input.classList.remove('is-invalid-input');
}

function sessionActionKey(sessionId, action) {
    return `session:${sessionId}:${action}`;
}

function workerActionKey(workerId, action) {
    return `worker:${workerId}:${action}`;
}

function taskActionKey(taskId, action) {
    return `task:${taskId}:${action}`;
}

function isActionPending(actionKey) {
    return pendingActions.has(actionKey);
}

function updateStaticActionButtons() {
    const selfCheckPending = isActionPending('app:self-check');
    document.querySelectorAll('.create-self-check-btn').forEach(btn => {
        btn.disabled = selfCheckPending;
        btn.classList.toggle('is-pending', selfCheckPending);
        const label = btn.querySelector('span');
        if (label) {
            label.textContent = selfCheckPending ? '创建中...' : '安全自检';
        }
    });
}

function statusLabel(status) {
    switch (status) {
        case 'pending': return '待处理';
        case 'queued': return '排队中';
        case 'running': return '运行中';
        case 'completed': return '已完成';
        case 'failed': return '失败';
        case 'canceled': return '已取消';
        default: return status || '未知';
    }
}

function modeLabel(mode) {
    switch (mode) {
        case 'Ask': return '提问';
        case 'Plan': return '规划';
        case 'Dispatch': return '派发';
        case 'Execute': return '执行';
        default: return mode || '未知';
    }
}

function workerStatusLabel(status) {
    switch (status) {
        case 'available': return '空闲';
        case 'busy': return '忙碌';
        case 'disconnected': return '未连接';
        default: return status || '未知';
    }
}

function workerTypeLabel(type) {
    switch (type) {
        case 'mcp': return 'MCP';
        case 'cli': return '命令行/API';
        default: return type || '未知';
    }
}

function renderWorkerCapabilities(worker) {
    const caps = Array.isArray(worker.capabilities) ? worker.capabilities : [];
    const chips = [
        `<span class="worker-meta-chip"><i class="codicon codicon-chip"></i>${workerTypeLabel(worker.type)}</span>`
    ];
    const healthChip = renderCustomApiHealthChip(worker);
    if (healthChip) {
        chips.push(healthChip);
    }
    caps.forEach(capability => {
        const status = capability.status || 'info';
        const title = capability.description ? ` title="${escapeHtml(capability.description)}"` : '';
        chips.push(`<span class="worker-capability-chip capability-${escapeHtml(status)}"${title}>${escapeHtml(capability.label || '能力')}</span>`);
    });
    return chips.join('');
}

function renderWorkerSelectorCapabilities(worker) {
    const caps = Array.isArray(worker.capabilities) ? worker.capabilities : [];
    const importantCaps = caps.filter(capability => [
        'api-tools',
        'workspace-read',
        'workspace-write',
        'command-execution',
        'cli-project',
        'mcp-tool',
        'placeholder',
    ].includes(capability.kind));
    if (importantCaps.length === 0) return '';
    return `
        <span class="worker-selector-caps">
            ${importantCaps.slice(0, 4).map(capability => {
                const status = capability.status || 'info';
                const title = capability.description ? ` title="${escapeHtml(capability.description)}"` : '';
                return `<span class="worker-selector-cap capability-${escapeHtml(status)}"${title}>${escapeHtml(capability.label || '能力')}</span>`;
            }).join('')}
        </span>
    `;
}

function renderCustomApiHealthChip(worker) {
    if (worker.id !== 'custom-api-worker' || !customApiHealth) return '';
    const status = customApiHealth.status || 'untested';
    const label = customApiHealthLabel(status);
    const titleParts = [];
    if (customApiHealth.name) titleParts.push(customApiHealth.name);
    if (customApiHealth.model) titleParts.push(`模型：${customApiHealth.model}`);
    if (customApiHealth.message) titleParts.push(customApiHealth.message);
    if (typeof customApiHealth.lastCheckedAt === 'number') {
        const dt = new Date(customApiHealth.lastCheckedAt);
        if (!isNaN(dt.getTime())) titleParts.push(`检查时间：${dt.toLocaleTimeString()}`);
    }
    const title = titleParts.length ? ` title="${escapeHtml(titleParts.join('\n'))}"` : '';
    return `<span class="custom-api-health-chip custom-api-health-${escapeHtml(status)}"${title}>${escapeHtml(label)}</span>`;
}

function customApiHealthLabel(status) {
    switch (status) {
        case 'testing': return 'API 测试中';
        case 'ok': return '工具调用已通过';
        case 'no-tools': return '未确认工具调用';
        case 'failed': return 'API 测试失败';
        case 'untested':
        default: return 'API 未测试';
    }
}

function filterLabel(filter) {
    if (filter === 'all') return '全部';
    return statusLabel(filter);
}

function renderOverview(sessions, tasks, workers) {
    const panel = document.getElementById('overview-panel');
    if (!panel) return;

    const activeTasks = tasks.filter(task => task.status === 'running' || task.status === 'queued').length;
    const availableWorkers = workers.filter(worker => worker.status === 'available').length;
    const connectedWorkers = workers.filter(worker => worker.status !== 'disconnected').length;
    const completedTasks = tasks.filter(task => task.status === 'completed').length;

    const cards = [
        {
            icon: 'codicon-comment-discussion',
            label: '会话',
            value: sessions.length,
            meta: sessions.length ? '用于组织目标与任务' : '先创建会话'
        },
        {
            icon: 'codicon-list-unordered',
            label: '任务',
            value: tasks.length,
            meta: completedTasks ? `已完成 ${completedTasks} 个` : '当前会话中的任务总数'
        },
        {
            icon: 'codicon-pulse',
            label: '活跃任务',
            value: activeTasks,
            meta: activeTasks ? '运行中或排队中' : '当前没有活动任务'
        },
        {
            icon: 'codicon-server-process',
            label: '可用执行器',
            value: availableWorkers,
            meta: connectedWorkers ? `已连接 ${connectedWorkers} 个` : '当前没有已连接执行器'
        }
    ];

    panel.innerHTML = cards.map(card => `
        <article class="overview-card">
            <div class="overview-card-icon"><i class="codicon ${card.icon}"></i></div>
            <div class="overview-card-body">
                <div class="overview-card-label">${card.label}</div>
                <div class="overview-card-value">${card.value}</div>
                <div class="overview-card-meta">${card.meta}</div>
            </div>
        </article>
    `).join('');
}

function renderComposerSessionHint(sessions) {
    const hint = document.getElementById('composer-session-hint');
    if (!hint) return;
    if (!activeSessionId) {
        hint.textContent = sessions.length === 0
            ? '还没有会话，点击右侧按钮会自动创建快速会话。'
            : '当前未选会话，点击右侧按钮会自动创建快速会话。';
        hint.className = 'composer-session-hint is-empty';
        return;
    }
    const active = sessions.find(session => session.id === activeSessionId);
    if (!active) {
        hint.textContent = '当前会话已失效，点击右侧按钮会自动创建快速会话。';
        hint.className = 'composer-session-hint is-empty';
        return;
    }
    hint.textContent = `当前会话：${active.name}`;
    hint.className = 'composer-session-hint is-active';
}

function renderSessions(sessions) {
    const container = document.getElementById('sessions-container');
    if (!container) return;
    container.innerHTML = `
        <div class="section-heading">
            <div>
                <h2>会话</h2>
                <p>${sessions.length ? '选择一个会话查看任务流。' : '先创建一个会话开始编排。'}</p>
            </div>
            <span class="section-count">${sessions.length}</span>
        </div>
    `;
    if (sessions.length === 0) {
        container.innerHTML += '<div class="empty-state"><i class="codicon codicon-comment-discussion"></i><span>还没有会话，可在下方新建。</span></div>';
        return;
    }
    sessions.forEach(session => {
        const stats = sessionStats[session.id] || {};
        const canSummarize = !!stats.completed;
        const canRetryAll = !!stats.failed || !!stats.canceled;
        const canCancelAll = !!stats.pending || !!stats.queued || !!stats.running;
        const editPending = isActionPending(sessionActionKey(session.id, 'edit'));
        const deletePending = isActionPending(sessionActionKey(session.id, 'delete'));
        const summarizePending = isActionPending(sessionActionKey(session.id, 'summarize'));
        const exportPending = isActionPending(sessionActionKey(session.id, 'export'));
        const retryAllPending = isActionPending(sessionActionKey(session.id, 'retry-all'));
        const cancelAllPending = isActionPending(sessionActionKey(session.id, 'cancel-all'));
        const hasPendingSessionAction = editPending || deletePending || summarizePending || exportPending || retryAllPending || cancelAllPending;
        const sessionElement = document.createElement('div');
        sessionElement.className = `session ${session.id === activeSessionId ? 'active' : ''}`;
        sessionElement.dataset.sessionId = session.id;
        sessionElement.innerHTML = `
            <div class="session-header">
                <h3 class="session-title">${escapeHtml(session.name)}</h3>
                <button class="edit-session-btn icon-btn${editPending ? ' is-pending' : ''}" data-session-id="${session.id}" data-name="${escapeHtml(session.name)}" data-goal="${escapeHtml(session.goal)}" title="编辑会话" aria-label="编辑会话" ${hasPendingSessionAction ? 'disabled' : ''}>
                    ${editPending ? '保存中...' : '<i class="codicon codicon-edit"></i>'}
                </button>
            </div>
            <p class="session-goal">${escapeHtml(session.goal)}</p>
            ${renderSessionStats(session.id)}
            ${session.summary ? `<div class="summary"><h4>摘要：</h4><p>${escapeHtml(session.summary)}</p></div>` : ''}
            <div class="session-actions">
                <button class="summarize-btn${summarizePending ? ' is-pending' : ''}" data-session-id="${session.id}" ${!canSummarize || hasPendingSessionAction ? 'disabled' : ''}>${summarizePending ? '更新中...' : '更新摘要'}</button>
                <button class="export-session-btn${exportPending ? ' is-pending' : ''}" data-session-id="${session.id}" ${hasPendingSessionAction ? 'disabled' : ''}>${exportPending ? '导出中...' : '导出'}</button>
                <button class="retry-all-btn${retryAllPending ? ' is-pending' : ''}" data-session-id="${session.id}" ${!canRetryAll || hasPendingSessionAction ? 'disabled' : ''}>${retryAllPending ? '重试中...' : '重试失败项'}</button>
                <button class="cancel-all-btn${cancelAllPending ? ' is-pending' : ''}" data-session-id="${session.id}" ${!canCancelAll || hasPendingSessionAction ? 'disabled' : ''}>${cancelAllPending ? '取消中...' : '全部取消'}</button>
                <button class="delete-session-btn${deletePending ? ' is-pending' : ''}" data-session-id="${session.id}" ${hasPendingSessionAction ? 'disabled' : ''}>${deletePending ? '删除中...' : '删除'}</button>
            </div>
        `;
        container.appendChild(sessionElement);
    });
}

window.addEventListener('message', event => {
    const message = event.data; // The JSON data our extension sent

    switch (message.type) {
        case 'updateSessions':
            const { sessions, tasks, workers, activeSessionId: serverActiveId, sessionStats: stats, autoChain, relayHealth, customApiHealth: apiHealth } = message;
            if (serverActiveId !== undefined) {
                activeSessionId = serverActiveId;
            }
            lastSessions = sessions;
            lastTasks = tasks;
            lastWorkers = workers;
            sessionStats = stats || {};
            customApiHealth = apiHealth || null;
            renderOverview(sessions, tasks, workers);
            renderSessions(sessions);
            renderTasks(tasks);
            renderWorkers(workers);
            renderComposerSessionHint(sessions);
            renderRelayHealthPill(relayHealth);
            updateStaticActionButtons();
            updateFilterCounts(tasks);
            const acCheckbox = document.getElementById('auto-chain-checkbox');
            if (acCheckbox && autoChain !== undefined) { acCheckbox.checked = autoChain; }
            const acLabel = document.getElementById('auto-chain-label');
            const autoChainPending = isActionPending('app:auto-chain-toggle');
            if (acCheckbox) {
                acCheckbox.disabled = autoChainPending;
            }
            if (acLabel) {
                acLabel.textContent = autoChainPending ? '保存自动接续中...' : '自动接续';
            }
            // Restore search input value (re-renders don't touch the filter bar, but just in case)
            const searchInput = document.getElementById('task-search-input');
            if (searchInput && searchInput.value !== searchQuery) { searchInput.value = searchQuery; }
            break;
        case 'setActionState':
            if (message.pending) {
                pendingActions.add(message.actionKey);
            } else {
                pendingActions.delete(message.actionKey);
            }
            renderOverview(lastSessions, lastTasks, lastWorkers);
            renderSessions(lastSessions);
            renderTasks(lastTasks);
            renderWorkers(lastWorkers);
            renderComposerSessionHint(lastSessions);
            updateStaticActionButtons();
            const pendingCheckbox = document.getElementById('auto-chain-checkbox');
            const pendingLabel = document.getElementById('auto-chain-label');
            const autoChainPendingState = isActionPending('app:auto-chain-toggle');
            if (pendingCheckbox) {
                pendingCheckbox.disabled = autoChainPendingState;
            }
            if (pendingLabel) {
                pendingLabel.textContent = autoChainPendingState ? '保存自动接续中...' : '自动接续';
            }
            break;
        case 'clearSessionCreator':
            clearSessionCreatorInputs();
            clearClientFeedback();
            break;
        case 'clearTaskComposer':
            clearTaskComposerInput();
            document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
            clearClientFeedback();
            break;
        case 'clientFeedback':
            showClientFeedback(message.message || '', message.tone || 'warning');
            break;
    }
});

function renderTasks(tasks) {
    const container = document.getElementById('tasks-container');
    if (!container) return;
    let filtered = activeFilter === 'all' ? tasks : tasks.filter(t => t.status === activeFilter);
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(t => t.prompt.toLowerCase().includes(q) || (t.result && t.result.summary.toLowerCase().includes(q)));
    }
    const taskCountLabel = filtered.length !== tasks.length ? `${filtered.length}/${tasks.length}` : `${tasks.length}`;
    container.innerHTML = `
        <div class="section-heading">
            <div>
                <h2>任务</h2>
                <p>${tasks.length ? '围绕当前会话管理任务、结果与产物。' : '选中会话后在上方输入提示词创建任务。'}</p>
            </div>
            <span class="section-count">${taskCountLabel}</span>
        </div>
    `;
    if (tasks.length === 0) {
        container.innerHTML += '<div class="empty-state"><i class="codicon codicon-list-unordered"></i><span>当前会话还没有任务，可在上方输入提示词创建。</span></div>';
        return;
    }
    if (filtered.length === 0) {
        const activeLabel = filterLabel(activeFilter);
        const label = searchQuery
            ? `没有匹配“${escapeHtml(searchQuery)}”的任务${activeFilter === 'all' ? '' : `（${activeLabel}）`}。`
            : activeFilter === 'all'
                ? '暂无可显示的任务。'
                : `没有${activeLabel}任务。`;
        container.innerHTML += `<div class="empty-state"><i class="codicon codicon-search"></i><span>${label}</span></div>`;
        return;
    }
    filtered.forEach(task => {
        const taskElement = document.createElement('div');
        taskElement.className = `task task-${task.status}`;
        const dispatchPending = isActionPending(taskActionKey(task.id, 'dispatch'));
        const autoDispatchPending = isActionPending(taskActionKey(task.id, 'auto-dispatch'));
        const cancelPending = isActionPending(taskActionKey(task.id, 'cancel'));
        const retryPending = isActionPending(taskActionKey(task.id, 'retry'));
        const editPromptPending = isActionPending(taskActionKey(task.id, 'edit-prompt'));
        const deletePending = isActionPending(taskActionKey(task.id, 'delete'));
        const clonePending = isActionPending(taskActionKey(task.id, 'clone'));
        const hasPendingDispatchAction = dispatchPending || autoDispatchPending;
        const hasPendingTaskAction = hasPendingDispatchAction || cancelPending || retryPending || editPromptPending || deletePending || clonePending;
        const hasAvailableWorker = lastWorkers.some(worker => worker.status === 'available');
        const hasConnectedWorker = lastWorkers.some(worker => worker.status !== 'disconnected');

        let detailHtml = '';
        // Live preview: show partial output while a task is still running.
        // Cleared by the orchestrator the moment `task.result` is set so this
        // branch and the `task.result` branch below never both render.
        if (task.status === 'running' && typeof task.streamingOutput === 'string' && task.streamingOutput.length > 0) {
            detailHtml += `<div class="task-streaming"><div class="task-streaming-header"><span class="streaming-indicator" aria-hidden="true"></span><strong>正在输出...</strong></div><pre class="task-streaming-body">${escapeHtml(task.streamingOutput)}</pre></div>`;
        }
        const recovery = task.recovery || (task.result && task.result.recovery);
        if (recovery) {
            detailHtml += renderTaskRecovery(recovery);
        }
        if (task.result) {
            const suppressIntermediateSummary = task.status === 'queued' && recovery && recovery.autoRetry;
            if (!suppressIntermediateSummary) {
                detailHtml += `<div class="task-result-summary"><strong>结果：</strong> ${escapeHtml(task.result.summary)}</div>`;
            }
            if (task.result.modifiedFiles && task.result.modifiedFiles.length > 0) {
                detailHtml += `<div class="modified-files"><strong>修改文件</strong>${task.result.modifiedFiles.map(path => `<button class="modified-file-btn" type="button" data-path="${escapeHtml(path)}" title="打开文件">${escapeHtml(path)}</button>`).join('')}</div>`;
            } else if (shouldShowNoModificationNotice(task)) {
                detailHtml += `<div class="task-no-modifications"><i class="codicon codicon-warning"></i><div><strong>未检测到文件修改</strong><span>这次执行器没有通过工作区工具回传修改文件。若你期望它改代码，请先点击“测试固定 API”，并确认执行器卡片显示“工具调用已通过”和“执行可写”。</span></div></div>`;
            }
            if (task.result.artifacts && task.result.artifacts.length > 0) {
                detailHtml += `<details class="task-detail"><summary>产物 (${task.result.artifacts.length})</summary>`;
                task.result.artifacts.forEach(a => {
                    detailHtml += renderArtifact(a);
                });
                detailHtml += `</details>`;
            }
            if (task.result.logs && task.result.logs.length > 0) {
                detailHtml += `<details class="task-detail"><summary>日志 (${task.result.logs.length})</summary>`;
                task.result.logs.forEach(log => {
                    detailHtml += `<div class="log-line">${escapeHtml(log)}</div>`;
                });
                detailHtml += `</details>`;
            }
        }

        let actionsHtml = '';
        if (task.status === 'pending') {
            actionsHtml = `
                <div class="worker-selection-container" data-task-id="${task.id}"></div>
                <div class="task-actions">
                    <button class="dispatch-btn${dispatchPending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction || !hasAvailableWorker ? 'disabled' : ''}>${dispatchPending ? '派发中...' : '派发'}</button>
                    <button class="auto-dispatch-btn${autoDispatchPending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction || !hasConnectedWorker ? 'disabled' : ''}>${autoDispatchPending ? '自动派发中...' : '自动派发'}</button>
                    <button class="cancel-task-btn${cancelPending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${cancelPending ? '取消中...' : '取消'}</button>
                    <button class="delete-task-btn${deletePending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${deletePending ? '删除中...' : '删除'}</button>
                </div>
            `;
        } else if (task.status === 'queued' || task.status === 'running') {
            actionsHtml = `<button class="cancel-task-btn${cancelPending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${cancelPending ? '取消中...' : '取消'}</button>`;
        } else if (task.status === 'failed' || task.status === 'canceled') {
            actionsHtml = `<button class="retry-task-btn${retryPending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${retryPending ? '重试中...' : '重试'}</button><button class="clone-task-btn${clonePending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${clonePending ? '复制中...' : '复制'}</button><button class="delete-task-btn${deletePending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${deletePending ? '删除中...' : '删除'}</button>`;
        } else if (task.status === 'completed') {
            actionsHtml = `<button class="clone-task-btn${clonePending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${clonePending ? '复制中...' : '复制'}</button><button class="delete-task-btn${deletePending ? ' is-pending' : ''}" data-task-id="${task.id}" ${hasPendingTaskAction ? 'disabled' : ''}>${deletePending ? '删除中...' : '删除'}</button>`;
        }

        const promptHtml = task.status === 'pending'
            ? `<div class="task-title-row"><strong class="editable-prompt task-title" data-task-id="${task.id}">${escapeHtml(task.prompt)}</strong><button class="edit-prompt-btn icon-btn${editPromptPending ? ' is-pending' : ''}" data-task-id="${task.id}" title="编辑提示词" aria-label="编辑提示词" ${hasPendingTaskAction ? 'disabled' : ''}>${editPromptPending ? '保存中...' : '<i class="codicon codicon-edit"></i>'}</button></div>`
            : `<div class="task-title-row"><strong class="task-title">${escapeHtml(task.prompt)}</strong></div>`;

        const metaBits = [
            `<span class="status-badge status-${task.status}">${statusLabel(task.status)}</span>`,
            `<span class="task-meta-chip"><i class="codicon codicon-symbol-enum"></i>${modeLabel(task.mode)}</span>`
        ];
        if (task.workerId) {
            metaBits.push(`<span class="task-meta-chip"><i class="codicon codicon-hubot"></i>${escapeHtml(task.workerId)}</span>`);
        }
        if (task.completedAt) {
            metaBits.push(`<span class="task-meta-chip"><i class="codicon codicon-history"></i>${formatDuration(task.createdAt, task.completedAt)}</span>`);
        }
        if (task.recovery && task.recovery.autoRetry) {
            const attempt = task.recovery.attempt && task.recovery.maxAttempts
                ? `${task.recovery.attempt}/${task.recovery.maxAttempts}`
                : '自动重试';
            metaBits.push(`<span class="task-meta-chip recovery-chip"><i class="codicon codicon-sync"></i>${attempt}</span>`);
        }

        taskElement.innerHTML = `
            ${promptHtml}
            <div class="task-meta-row">${metaBits.join('')}</div>
            ${detailHtml}
            ${actionsHtml}
        `;
        container.appendChild(taskElement);
    });
}

function shouldShowNoModificationNotice(task) {
    if (!task || task.mode !== 'Execute' || task.status !== 'completed' || !task.result) return false;
    if (Array.isArray(task.result.modifiedFiles) && task.result.modifiedFiles.length > 0) return false;
    const worker = task.workerId ? lastWorkers.find(candidate => candidate.id === task.workerId) : null;
    const caps = Array.isArray(worker?.capabilities) ? worker.capabilities : [];
    return caps.some(capability => capability.kind === 'api-tools');
}

function renderSessionStats(sessionId) {
    const s = sessionStats[sessionId];
    if (!s || s.total === 0) return '';
    const parts = [];
    if (s.completed) parts.push(`<span class="stat-badge status-completed">${s.completed} 已完成</span>`);
    if (s.running) parts.push(`<span class="stat-badge status-running">${s.running} 运行中</span>`);
    if (s.pending) parts.push(`<span class="stat-badge status-pending">${s.pending} 待处理</span>`);
    if (s.queued) parts.push(`<span class="stat-badge status-queued">${s.queued} 排队中</span>`);
    if (s.failed) parts.push(`<span class="stat-badge status-failed">${s.failed} 失败</span>`);
    if (s.canceled) parts.push(`<span class="stat-badge status-canceled">${s.canceled} 已取消</span>`);
    return `<div class="session-stats">${parts.join(' ')}</div>`;
}

function updateFilterCounts(tasks) {
    const counts = { all: tasks.length, pending: 0, running: 0, queued: 0, completed: 0, failed: 0, canceled: 0 };
    tasks.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
    document.querySelectorAll('.filter-btn').forEach(btn => {
        const f = btn.dataset.filter;
        const count = counts[f] || 0;
        const label = filterLabel(f);
        btn.textContent = `${label} (${count})`;
        btn.classList.toggle('active', f === activeFilter);
    });
}

function formatDuration(startMs, endMs) {
    const diff = endMs - startMs;
    if (diff < 1000) return `${diff}毫秒`;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}秒`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}分 ${remSecs}秒`;
}

function flashInvalidInput(input) {
    if (!input) return;
    clearInvalidInput(input);
    input.classList.add('is-invalid-input');
    const timer = setTimeout(() => {
        input.classList.remove('is-invalid-input');
        invalidInputTimers.delete(input);
    }, 2000);
    invalidInputTimers.set(input, timer);
}

function revertInlineSessionEdit(target) {
    renderSessions(lastSessions);
}

function escapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Relay health pill ---

function renderRelayHealthPill(snapshot) {
    const pill = document.getElementById('relay-health-pill');
    if (!pill) return;
    // No monitor / never produced a snapshot → keep the pill hidden so the
    // header doesn't reserve empty space.
    if (!snapshot || snapshot.status === 'disabled') {
        pill.className = 'relay-health-pill is-hidden';
        pill.innerHTML = '';
        pill.title = '';
        return;
    }
    const { status, message, usage, lastCheckedAt, lastLatencyMs } = snapshot;
    const label = relayHealthLabel(status);
    const statusClass = `is-${status}`;
    let usageText = '';
    if (usage && usage.limit > 0) {
        const pct = Math.min(100, Math.round((usage.used / usage.limit) * 100));
        usageText = ` <span class="relay-health-usage">${formatNumber(usage.used)} / ${formatNumber(usage.limit)} (${pct}%)</span>`;
    }
    pill.className = `relay-health-pill ${statusClass}`;
    pill.innerHTML = `
        <span class="relay-health-dot" aria-hidden="true"></span>
        <span class="relay-health-label">中继服务：${escapeHtml(label)}</span>${usageText}
    `;
    // Stuff every detail into the title attribute so hovering the pill shows
    // a deeper tooltip without inflating the visible UI. Plain text only —
    // VS Code webview won't render rich tooltips here.
    const lines = [`中继服务：${label}`];
    if (message) lines.push(message);
    if (usage && usage.resetAt) lines.push(`重置时间：${usage.resetAt}`);
    if (typeof lastLatencyMs === 'number') lines.push(`延迟：${lastLatencyMs} 毫秒`);
    if (typeof lastCheckedAt === 'number') {
        const dt = new Date(lastCheckedAt);
        if (!isNaN(dt.getTime())) lines.push(`检查时间：${dt.toLocaleTimeString()}`);
    }
    pill.title = lines.join('\n');
}

function relayHealthLabel(status) {
    switch (status) {
        case 'ok': return '正常';
        case 'degraded': return '降级';
        case 'down': return '异常';
        case 'unauthorized': return '未授权';
        case 'unknown': return '未知';
        default: return status || '未知';
    }
}

function formatNumber(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
    return n.toLocaleString();
}

function formatDelay(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '马上';
    if (ms < 1000) return `${Math.round(ms)}毫秒`;
    return `${Math.ceil(ms / 1000)}秒`;
}

function renderTaskRecovery(recovery) {
    const tone = recovery.autoRetry ? 'is-retrying' : (recovery.retryable ? 'is-actionable' : 'is-blocked');
    const retryMeta = recovery.autoRetry
        ? `将在 ${formatDelay(recovery.delayMs)} 后自动重试${recovery.attempt && recovery.maxAttempts ? `（${recovery.attempt}/${recovery.maxAttempts}）` : ''}`
        : (recovery.retryable ? '可手动处理后重试' : '需要人工处理');
    const icon = recovery.autoRetry ? 'codicon-sync' : (recovery.retryable ? 'codicon-tools' : 'codicon-warning');
    return `
        <div class="task-recovery ${tone}">
            <div class="task-recovery-header">
                <i class="codicon ${icon}"></i>
                <strong>${escapeHtml(recovery.title || '恢复提示')}</strong>
                <span>${escapeHtml(retryMeta)}</span>
            </div>
            <p>${escapeHtml(recovery.message || '')}</p>
            <div class="task-recovery-action">${escapeHtml(recovery.action || '')}</div>
        </div>
    `;
}

// --- Artifact rendering ---

function renderArtifact(a) {
    const icon = a.type === 'file' ? 'codicon-file-code' : 'codicon-code';
    const lang = a.type === 'snippet' ? extractSnippetLang(a.name) : '';
    const isDiff = a.type === 'file' && /^diff --git /m.test(a.content || '');
    const bodyHtml = isDiff
        ? renderDiffBody(a.content)
        : `<pre><code>${escapeHtml(a.content)}</code></pre>`;
    // Stash the raw content on the element so the copy button can grab it
    // without having to re-escape HTML. encodeURIComponent is safe inside
    // a double-quoted attribute.
    const payload = encodeURIComponent(a.content || '');
    return `
        <div class="artifact" data-artifact-content="${payload}">
            <div class="artifact-header">
                <span class="artifact-icon codicon ${icon}" aria-hidden="true"></span>
                <span class="artifact-name">${escapeHtml(a.name)}</span>
                ${lang ? `<span class="artifact-lang">${escapeHtml(lang)}</span>` : ''}
                <button class="artifact-copy-btn" type="button">复制</button>
            </div>
            ${bodyHtml}
        </div>
    `;
}

function renderDiffBody(content) {
    const rows = (content || '').split('\n').map(line => {
        let cls = 'diff-line';
        if (line.startsWith('diff --git') || line.startsWith('index ') ||
            line.startsWith('--- ') || line.startsWith('+++ ')) {
            cls += ' diff-header';
        } else if (line.startsWith('@@')) {
            cls += ' diff-hunk';
        } else if (line.startsWith('+')) {
            cls += ' diff-add';
        } else if (line.startsWith('-')) {
            cls += ' diff-del';
        } else {
            cls += ' diff-ctx';
        }
        return `<span class="${cls}">${escapeHtml(line)}</span>`;
    }).join('\n');
    return `<pre class="diff"><code>${rows}</code></pre>`;
}

function extractSnippetLang(name) {
    // Parser produces names like "snippet-ts-1"; return the middle token.
    const m = /^snippet-([^-]+)-\d+$/.exec(name || '');
    return m ? m[1] : '';
}

// Task search input + auto-chain toggle
document.addEventListener('input', event => {
    const target = event.target;
    if (target.matches('#task-search-input')) {
        searchQuery = target.value.trim();
        renderTasks(lastTasks);
        return;
    }
    if (target.matches('#task-prompt-input, #session-name-input, #session-goal-input, .edit-prompt-input, .edit-session-name, .edit-session-goal')) {
        clearInvalidInput(target);
        clearClientFeedback();
    }
});

document.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('#auto-chain-checkbox')) {
        postMessage('toggle-auto-chain', { enabled: target.checked });
        return;
    }
    if (target.matches('.worker-selector')) {
        clearClientFeedback();
    }
});

// Filter button click
document.addEventListener('click', event => {
    const rawTarget = event.target;
    const clickedElement = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;
    const target = clickedElement?.closest?.('button') || clickedElement;
    if (!target || typeof target.matches !== 'function') return;
    if (target.matches('.filter-btn')) {
        activeFilter = target.dataset.filter;
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === activeFilter));
        renderTasks(lastTasks);
        return;
    }
    if (target.matches('#create-session-btn')) {
        const nameInput = document.getElementById('session-name-input');
        const goalInput = document.getElementById('session-goal-input');
        const name = nameInput.value.trim();
        const goal = goalInput.value.trim();
        if (name && goal) {
            postMessage('create-session', { name, goal });
        } else {
            if (!name) flashInvalidInput(nameInput);
            if (!goal) flashInvalidInput(goalInput);
            showClientFeedback('创建会话时必须填写名称和目标。');
        }
    } else if (target.matches('.edit-session-btn')) {
        const sessionId = target.dataset.sessionId;
        const curName = target.dataset.name || '';
        const curGoal = target.dataset.goal || '';
        const sessionEl = target.closest('.session');
        if (!sessionEl) return;
        const titleEl = sessionEl.querySelector('.session-title');
        const goalEl = sessionEl.querySelector('.session-goal');
        if (titleEl) {
            titleEl.innerHTML = `<input type="text" class="edit-session-name" data-session-id="${sessionId}" value="${escapeHtml(curName)}" placeholder="会话名称" />`;
        }
        if (goalEl) {
            goalEl.innerHTML = `<input type="text" class="edit-session-goal" data-session-id="${sessionId}" value="${escapeHtml(curGoal)}" placeholder="会话目标" /> <button class="save-session-btn" data-session-id="${sessionId}">保存</button>`;
        }
        const nameInput = sessionEl.querySelector('.edit-session-name');
        if (nameInput) { nameInput.focus(); nameInput.select(); }
    } else if (target.matches('.save-session-btn')) {
        const sessionId = target.dataset.sessionId;
        const sessionEl = target.closest('.session');
        const nameInput = sessionEl?.querySelector('.edit-session-name');
        const goalInput = sessionEl?.querySelector('.edit-session-goal');
        const name = nameInput ? nameInput.value.trim() : '';
        const goal = goalInput ? goalInput.value.trim() : '';
        if (name || goal) {
            postMessage('edit-session', { sessionId, name: name || undefined, goal: goal || undefined });
        } else {
            if (nameInput) flashInvalidInput(nameInput);
            if (goalInput) flashInvalidInput(goalInput);
            showClientFeedback('请先填写会话名称或目标，再保存修改。');
        }
    } else if (target.matches('.summarize-btn')) {
        const sessionId = target.dataset.sessionId;
        postMessage('summarize-session', { sessionId });
    } else if (target.matches('.export-session-btn')) {
        const sessionId = target.dataset.sessionId;
        postMessage('export-session', { sessionId });
    } else if (target.matches('.retry-all-btn')) {
        const sessionId = target.dataset.sessionId;
        postMessage('retry-all-failed', { sessionId });
    } else if (target.matches('.cancel-all-btn')) {
        const sessionId = target.dataset.sessionId;
        if (!confirm('确认取消该会话中的所有活动任务吗？')) return;
        postMessage('cancel-all-tasks', { sessionId });
    } else if (target.matches('.clone-task-btn')) {
        const taskId = target.dataset.taskId;
        postMessage('clone-task', { taskId });
    } else if (target.matches('.delete-session-btn')) {
        const sessionId = target.dataset.sessionId;
        if (!confirm('确认删除该会话及其全部任务吗？')) return;
        postMessage('delete-session', { sessionId });
    } else if (target.matches('.cancel-task-btn')) {
        const taskId = target.dataset.taskId;
        postMessage('cancel-task', { taskId });
    } else if (target.matches('.retry-task-btn')) {
        const taskId = target.dataset.taskId;
        postMessage('retry-task', { taskId });
    } else if (target.matches('.delete-task-btn')) {
        const taskId = target.dataset.taskId;
        if (!confirm('确认删除这个任务吗？')) return;
        postMessage('delete-task', { taskId });
    } else if (target.matches('.edit-prompt-btn')) {
        const taskId = target.dataset.taskId;
        const promptEl = document.querySelector(`.editable-prompt[data-task-id="${taskId}"]`);
        if (!promptEl) return;
        const currentText = promptEl.textContent || '';
        const promptWrap = promptEl.closest('.task-title-row') || promptEl.parentElement;
        promptWrap.innerHTML = `
            <input type="text" class="edit-prompt-input" data-task-id="${taskId}" value="${escapeHtml(currentText)}" />
            <button class="save-prompt-btn" data-task-id="${taskId}">保存</button>
        `;
        const input = promptWrap.querySelector('.edit-prompt-input');
        input.focus();
        input.select();
    } else if (target.matches('.save-prompt-btn')) {
        const taskId = target.dataset.taskId;
        const input = document.querySelector(`.edit-prompt-input[data-task-id="${taskId}"]`);
        if (input && input.value.trim()) {
            postMessage('edit-task-prompt', { taskId, prompt: input.value.trim() });
        } else if (input) {
            flashInvalidInput(input);
            showClientFeedback('任务提示词不能为空。');
        }
    } else if (target.matches('.auto-dispatch-btn')) {
        const taskId = target.dataset.taskId;
        postMessage('auto-dispatch-task', { taskId });
    } else if (target.matches('.connect-worker-btn')) {
        const workerId = target.dataset.workerId;
        postMessage('connect-worker', { workerId });
    } else if (target.matches('.disconnect-worker-btn')) {
        const workerId = target.dataset.workerId;
        postMessage('disconnect-worker', { workerId });
    } else if (target.matches('.quick-setup-custom-api-btn')) {
        postMessage('quick-setup-custom-api', {});
    } else if (target.matches('.test-custom-api-btn')) {
        postMessage('test-custom-api', {});
    } else if (target.matches('.create-self-check-btn')) {
        postMessage('create-self-check-task', {});
    } else if (target.matches('.open-settings-btn')) {
        postMessage('open-settings', {});
    } else if (target.matches('.set-custom-api-key-btn')) {
        postMessage('set-custom-api-key', {});
    } else if (target.matches('.modified-file-btn')) {
        const path = target.dataset.path || '';
        postMessage('open-workspace-file', { path });
    } else if (target.matches('.artifact-copy-btn')) {
        const artifact = target.closest('.artifact');
        if (!artifact) return;
        const payload = artifact.dataset.artifactContent || '';
        let text;
        try {
            text = decodeURIComponent(payload);
        } catch (_) {
            text = payload;
        }
        const done = () => {
            const original = target.textContent;
            target.textContent = '已复制';
            setTimeout(() => { target.textContent = original; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done);
        } else {
            // Legacy fallback for environments without Clipboard API
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) { /* noop */ }
            document.body.removeChild(ta);
            done();
        }
    } else if (rawTarget.closest?.('.session') && !rawTarget.closest?.('button, input, textarea, select, a')) {
        const sessionElement = rawTarget.closest('.session');
        const sessionId = sessionElement.dataset.sessionId;
        if (sessionId !== activeSessionId) {
            activeSessionId = sessionId;
            postMessage('set-active-session', { sessionId });
        }
    } else if (target.matches('.dispatch-btn')) {
        const taskId = target.dataset.taskId;
        const taskElement = target.closest('.task');
        const workerSelector = taskElement.querySelector('.worker-selector:checked');
        if (workerSelector) {
            const workerId = workerSelector.value;
            postMessage('dispatch-task', { taskId, workerId });
        } else {
            showClientFeedback('请先选择执行器，再派发任务。');
        }
    } else if (target.matches('.mode-btn')) {
        const mode = target.dataset.mode;
        const promptInput = document.getElementById('task-prompt-input');
        const prompt = promptInput.value.trim();
        if (!prompt) {
            flashInvalidInput(promptInput);
            showClientFeedback('请先输入任务提示词，再创建任务。');
        } else {
            postMessage('create-task', { prompt, mode, autoCreateSession: true, autoDispatch: true });
        }
    } else if (target.matches('.preset-btn')) {
        const prompt = target.dataset.prompt;
        const mode = target.dataset.mode;
        const promptInput = document.getElementById('task-prompt-input');
        promptInput.value = prompt;
        clearInvalidInput(promptInput);
        clearClientFeedback();
        promptInput.focus();
        // Highlight the matching mode button
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
    }
});

// Keyboard support: Enter saves, Esc cancels, Ctrl+Enter creates task
document.addEventListener('keydown', event => {
    const target = event.target;

    // Ctrl+Enter in prompt input → create task in Execute mode
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && target.matches('#task-prompt-input')) {
        event.preventDefault();
        const prompt = target.value.trim();
        if (!prompt) {
            flashInvalidInput(target);
            showClientFeedback('请先输入任务提示词，再创建任务。');
        } else {
            postMessage('create-task', { prompt, mode: 'Execute', autoCreateSession: true, autoDispatch: true });
        }
        return;
    }

    // Esc cancels inline edits by re-rendering
    if (event.key === 'Escape') {
        if (target.matches('.edit-prompt-input') || target.matches('.edit-session-name') || target.matches('.edit-session-goal')) {
            if (target.matches('.edit-prompt-input')) {
                renderTasks(lastTasks);
            } else {
                revertInlineSessionEdit(target);
            }
            target.blur();
            return;
        }
    }

    if (event.key !== 'Enter') return;
    if (target.matches('.edit-prompt-input')) {
        const taskId = target.dataset.taskId;
        if (target.value.trim()) {
            postMessage('edit-task-prompt', { taskId, prompt: target.value.trim() });
        } else {
            flashInvalidInput(target);
            showClientFeedback('任务提示词不能为空。');
        }
    } else if (target.matches('.edit-session-name') || target.matches('.edit-session-goal')) {
        const sessionId = target.dataset.sessionId;
        const sessionEl = target.closest('.session');
        const nameInput = sessionEl?.querySelector('.edit-session-name');
        const goalInput = sessionEl?.querySelector('.edit-session-goal');
        const name = nameInput ? nameInput.value.trim() : '';
        const goal = goalInput ? goalInput.value.trim() : '';
        if (name || goal) {
            postMessage('edit-session', { sessionId, name: name || undefined, goal: goal || undefined });
        } else {
            if (nameInput) flashInvalidInput(nameInput);
            if (goalInput) flashInvalidInput(goalInput);
            showClientFeedback('请先填写会话名称或目标，再保存修改。');
        }
    }
});

function renderWorkers(workers) {
    // 1. Render top-level worker status panel
    const panel = document.getElementById('workers-panel');
    if (panel) {
        const connectedCount = workers.filter(worker => worker.status !== 'disconnected').length;
        let html = `
            <div class="section-heading">
                <div>
                    <h2>执行器</h2>
                    <p>${workers.length ? `已注册 ${workers.length} 个执行器，当前连接 ${connectedCount} 个。` : '还没有已注册的执行器。'}</p>
                </div>
                <span class="section-count">${workers.length}</span>
            </div>
        `;
        if (!workers.length) {
            panel.innerHTML = `${html}${renderWorkerSetupEmpty('当前还没有已注册的执行器。')}`;
            return;
        }
        html += '<div class="worker-grid">';
        workers.forEach(worker => {
            const statusClass = worker.status === 'available' ? 'status-available' : worker.status === 'busy' ? 'status-busy' : 'status-disconnected';
            const connectPending = isActionPending(workerActionKey(worker.id, 'connect'));
            const disconnectPending = isActionPending(workerActionKey(worker.id, 'disconnect'));
            let actionBtn = '';
            if (connectPending) {
                actionBtn = `<button class="connect-worker-btn is-pending" data-worker-id="${worker.id}" disabled>连接中...</button>`;
            } else if (disconnectPending) {
                actionBtn = `<button class="disconnect-worker-btn is-pending" data-worker-id="${worker.id}" disabled>断开中...</button>`;
            } else if (worker.status === 'disconnected') {
                actionBtn = `<button class="connect-worker-btn" data-worker-id="${worker.id}">连接</button>`;
            } else if (worker.status === 'available') {
                actionBtn = `<button class="disconnect-worker-btn" data-worker-id="${worker.id}">断开</button>`;
            } else {
                actionBtn = '<span class="worker-busy-text">忙碌中</span>';
            }
            const testApiBtn = worker.id === 'custom-api-worker'
                ? '<button class="test-custom-api-btn" type="button"><i class="codicon codicon-debug-alt"></i><span>测试固定 API</span></button>'
                : '';
            html += `
                <article class="worker-card">
                    <div class="worker-card-top">
                        <div>
                            <div class="worker-name">${escapeHtml(worker.name)}</div>
                            <div class="worker-id">${escapeHtml(worker.id)}</div>
                        </div>
                        <span class="worker-status-pill ${statusClass}">${workerStatusLabel(worker.status)}</span>
                    </div>
                    <div class="worker-card-meta">
                        ${renderWorkerCapabilities(worker)}
                    </div>
                    <div class="worker-card-actions">${testApiBtn}${actionBtn}</div>
                </article>
            `;
        });
        html += '</div>';
        panel.innerHTML = html;
    }

    // 2. Render per-task worker selectors
    const workerContainers = document.querySelectorAll('.worker-selection-container');
    workerContainers.forEach(container => {
        let html = '';
        const taskId = container.dataset.taskId;
        const taskPending = isActionPending(taskActionKey(taskId, 'dispatch'))
            || isActionPending(taskActionKey(taskId, 'auto-dispatch'))
            || isActionPending(taskActionKey(taskId, 'cancel'))
            || isActionPending(taskActionKey(taskId, 'retry'))
            || isActionPending(taskActionKey(taskId, 'edit-prompt'))
            || isActionPending(taskActionKey(taskId, 'delete'));
        const connectedWorkers = workers.filter(worker => worker.status !== 'disconnected');
        const firstAvailableIdx = workers.findIndex(w => w.status === 'available');
        if (workers.length === 0) {
            container.innerHTML = renderWorkerSetupEmpty('当前还没有已注册的执行器。', true);
            return;
        }
        if (firstAvailableIdx === -1) {
            container.innerHTML = connectedWorkers.length > 0
                ? '<div class="empty-state compact-empty"><i class="codicon codicon-clock"></i><span>当前没有空闲执行器可手动派发，可使用自动派发将任务加入忙碌执行器的队列。</span></div>'
                : renderWorkerSetupEmpty('当前没有已连接的执行器。', true);
            return;
        }
        html += '<div class="worker-selector-list">';
        workers.forEach((worker, index) => {
            const isAvailable = worker.status === 'available';
            const disabled = isAvailable && !taskPending ? '' : 'disabled';
            const checked = index === firstAvailableIdx ? 'checked' : '';
	            html += `
	                <label class="worker-selector-card ${isAvailable ? 'is-available' : 'is-unavailable'}">
	                    <input type="radio" name="worker-for-${container.dataset.taskId}" class="worker-selector" value="${worker.id}" ${checked} ${disabled}>
	                    <span class="worker-selector-content">
	                        <span class="worker-selector-name">${escapeHtml(worker.name)}</span>
	                        <span class="worker-selector-state">${workerStatusLabel(worker.status)}</span>
	                        ${renderWorkerSelectorCapabilities(worker)}
	                    </span>
	                </label>
	            `;
        });
        html += '</div>';
        container.innerHTML = html;
    });
}

function renderWorkerSetupEmpty(text, compact = false) {
    return `
        <div class="empty-state worker-setup-empty ${compact ? 'compact-empty' : ''}">
            <div class="worker-setup-icon" aria-hidden="true"><i class="codicon codicon-plug"></i></div>
            <div class="worker-setup-copy">
                <strong>${escapeHtml(text)}</strong>
                <span>执行、派发和自动派发都需要先接入真实执行器。推荐先启用打包时固定的 OpenAI 兼容 API，或者在设置里启用 Codex、Claude Code、Gemini、Aider、MCP 客户端。</span>
            </div>
            <div class="empty-actions">
                <button class="quick-setup-custom-api-btn" type="button"><i class="codicon codicon-wand"></i><span>启用固定 API</span></button>
                <button class="create-self-check-btn" type="button"><i class="codicon codicon-beaker"></i><span>安全自检</span></button>
                <button class="open-settings-btn" type="button"><i class="codicon codicon-settings-gear"></i><span>高级设置</span></button>
                <button class="set-custom-api-key-btn" type="button"><i class="codicon codicon-key"></i><span>设置固定 API 密钥</span></button>
                <button class="test-custom-api-btn" type="button"><i class="codicon codicon-debug-alt"></i><span>测试固定 API</span></button>
            </div>
        </div>
    `;
}

function postMessage(command, data) {
    clearClientFeedback();
    vscode.postMessage({
        command: command,
        data: data
    });
}
