import * as vscode from 'vscode';
import { Orchestrator } from '../orchestrator/Orchestrator';
import { Session } from '../types';

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private _activeSessionId: string | null = null;

    constructor() {
        Orchestrator.getInstance().onStateChange.subscribe(() => {
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setActiveSession(sessionId: string | null): void {
        this._activeSessionId = sessionId;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SessionItem): SessionItem[] {
        if (element) {
            return [];
        }
        const sessions = Orchestrator.getInstance().getAllSessions();
        if (this._activeSessionId && !Orchestrator.getInstance().getSession(this._activeSessionId)) {
            this._activeSessionId = null;
        }
        if (sessions.length === 0) {
            return [new SessionItem({ id: '', name: '还没有会话', goal: '点这里新建一个会话', createdAt: 0, taskIds: [] }, true)];
        }
        return sessions.map(session => new SessionItem(session, false, session.id === this._activeSessionId));
    }
}

class SessionItem extends vscode.TreeItem {
    constructor(public readonly session: Session, placeholder = false, isActive = false) {
        super(session.name, vscode.TreeItemCollapsibleState.None);
        if (placeholder) {
            this.description = session.goal;
            this.iconPath = new vscode.ThemeIcon('add');
            this.command = {
                command: 'ai-dev-orchestrator.newSession',
                title: '新建会话',
            };
            return;
        }
        this.description = session.goal;
        this.tooltip = `${session.name}\n目标：${session.goal}\n任务数：${session.taskIds.length}${isActive ? '\n状态：当前会话' : ''}`;
        this.contextValue = 'session';
        this.iconPath = new vscode.ThemeIcon(isActive ? 'folder-opened' : 'folder');
        this.command = {
            command: 'ai-dev-orchestrator.selectSession',
            title: '选择会话',
            arguments: [session.id]
        };
    }
}
