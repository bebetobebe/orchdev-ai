import { Task } from '../../types';
import { BaseCliWorkerAdapter } from './BaseCliWorkerAdapter';
import { buildRelayEnv } from './relayEnv';

export interface CodexWorkerOptions {
    cliPath?: string;   // Path to codex binary, default 'codex'
    model?: string;     // e.g. 'gpt-5.2-codex'
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    cwd?: string;       // Working directory for the task
    /**
     * User-supplied auth token for the baked-in relay. Mapped to OPENAI_API_KEY
     * when relay is enabled. Empty/undefined leaves the API key unset so the
     * relay can serve a free/anonymous tier if configured to.
     */
    authToken?: string;
}

export class CodexWorkerAdapter extends BaseCliWorkerAdapter {
    private readonly _options: CodexWorkerOptions;

    constructor(id: string, name: string, options: CodexWorkerOptions = {}) {
        // 'mcp' type reused; semantic here = external CLI agent
        super(id, name, 'mcp');
        this._options = options;
    }

    protected getCliPath(): string {
        return this._options.cliPath || 'codex';
    }

    protected buildArgs(task: Task): string[] {
        const args: string[] = ['exec'];
        if (this._options.model) {
            args.push('-m', this._options.model);
        }
        if (this._options.sandbox) {
            args.push('-s', this._options.sandbox);
        }
        if (this._options.cwd) {
            args.push('-C', this._options.cwd);
        }
        args.push(task.prompt);
        return args;
    }

    protected logLabel(): string {
        return 'Codex';
    }

    protected getSpawnEnv(): NodeJS.ProcessEnv | undefined {
        return buildRelayEnv(['openai'], this._options.authToken);
    }
}
