import * as vscode from 'vscode';
import { Orchestrator } from '../orchestrator/Orchestrator';
import { Task } from '../types';

function modeLabel(mode: Task['mode']): string {
    switch (mode) {
        case 'Ask':
            return '提问';
        case 'Plan':
            return '规划';
        case 'Execute':
            return '执行';
        default:
            return mode;
    }
}

function statusLabel(status: Task['status']): string {
    switch (status) {
        case 'pending':
            return '待处理';
        case 'queued':
            return '排队中';
        case 'running':
            return '运行中';
        case 'completed':
            return '已完成';
        case 'failed':
            return '失败';
        case 'canceled':
            return '已取消';
        default:
            return status;
    }
}

export class TasksTreeProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TaskItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private _activeSessionId: string | null = null;

    constructor() {
        Orchestrator.getInstance().onStateChange.subscribe(() => {
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    setActiveSession(sessionId: string | null): void {
        this._activeSessionId = sessionId;
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TaskItem): TaskItem[] {
        if (element) {
            return [];
        }
        if (this._activeSessionId && !Orchestrator.getInstance().getSession(this._activeSessionId)) {
            this._activeSessionId = null;
        }
        if (!this._activeSessionId) {
            return [new TaskItem({ id: '', sessionId: '', prompt: '先选择或新建会话', mode: 'Ask', status: 'pending', createdAt: 0 }, 'new-session')];
        }
        const tasks = Orchestrator.getInstance().getTasksForSession(this._activeSessionId);
        if (tasks.length === 0) {
            return [new TaskItem({ id: '', sessionId: this._activeSessionId, prompt: '新建任务', mode: 'Ask', status: 'pending', createdAt: 0 }, 'new-task')];
        }
        return tasks.map(t => new TaskItem(t));
    }
}

type TaskPlaceholderAction = 'new-session' | 'new-task';

class TaskItem extends vscode.TreeItem {
    constructor(public readonly task: Task, placeholderAction?: TaskPlaceholderAction) {
        super(placeholderAction ? task.prompt : `[${modeLabel(task.mode)}] ${task.prompt}`, vscode.TreeItemCollapsibleState.None);
        if (placeholderAction === 'new-session') {
            this.description = '点击开始';
            this.iconPath = new vscode.ThemeIcon('add');
            this.command = {
                command: 'ai-dev-orchestrator.newSession',
                title: '新建会话',
            };
            return;
        }
        if (placeholderAction === 'new-task') {
            this.description = '添加到当前会话';
            this.iconPath = new vscode.ThemeIcon('add');
            this.command = {
                command: 'ai-dev-orchestrator.newTask',
                title: '新建任务',
            };
            return;
        }
        this.description = statusLabel(task.status);
        this.tooltip = `${task.prompt}\n模式：${modeLabel(task.mode)}\n状态：${statusLabel(task.status)}`;
        this.command = {
            command: 'ai-dev-orchestrator.openPanel',
            title: '打开编排面板',
            arguments: [task],
        };
        this.contextValue = task.status === 'pending' || task.status === 'queued' || task.status === 'running'
            ? 'cancelableTask'
            : 'task';
        switch (task.status) {
            case 'pending':
                this.iconPath = new vscode.ThemeIcon('clock');
                break;
            case 'queued':
                this.iconPath = new vscode.ThemeIcon('history');
                break;
            case 'running':
                this.iconPath = new vscode.ThemeIcon('loading~spin');
                break;
            case 'completed':
                this.iconPath = new vscode.ThemeIcon('check');
                break;
            case 'failed':
                this.iconPath = new vscode.ThemeIcon('error');
                break;
            case 'canceled':
                this.iconPath = new vscode.ThemeIcon('close');
                break;
        }
    }
}
