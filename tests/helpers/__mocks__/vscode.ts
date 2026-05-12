/**
 * Minimal vscode module mock for unit-testing tree providers and other
 * view-layer code that depends on the VS Code API.
 */

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export class TreeItem {
    label: string;
    collapsibleState: TreeItemCollapsibleState;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: { command: string; title: string; arguments?: unknown[] };

    constructor(label: string, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

export class ThemeIcon {
    constructor(public readonly id: string) {}
}

/**
 * Mimics vscode.EventEmitter<T> – just enough for tree providers to
 * instantiate one and call .fire().
 */
export class EventEmitter<T = void> {
    private _listeners: Array<(e: T) => void> = [];

    get event(): (listener: (e: T) => void) => { dispose: () => void } {
        return (listener) => {
            this._listeners.push(listener);
            return {
                dispose: () => {
                    this._listeners = this._listeners.filter(l => l !== listener);
                },
            };
        };
    }

    fire(data: T): void {
        for (const l of this._listeners) l(data);
    }

    dispose(): void {
        this._listeners = [];
    }
}
