import { Task } from '../../types';
import { BaseCliWorkerAdapter } from './BaseCliWorkerAdapter';
import { buildRelayEnv } from './relayEnv';

export interface OpenCodeWorkerOptions {
    cliPath?: string;   // Path to opencode binary, default 'opencode'
    model?: string;     // Provider/model, e.g. 'anthropic/claude-sonnet-4'
    cwd?: string;       // Working directory for the task
    /**
     * User-supplied auth token for the baked-in relay. Mapped to both
     * OPENAI_API_KEY and ANTHROPIC_API_KEY because opencode picks the
     * provider at runtime based on `model`.
     */
    authToken?: string;
}

export class OpenCodeWorkerAdapter extends BaseCliWorkerAdapter {
    private readonly _options: OpenCodeWorkerOptions;

    constructor(id: string, name: string, options: OpenCodeWorkerOptions = {}) {
        super(id, name, 'cli');
        this._options = options;
    }

    protected getCliPath(): string {
        return this._options.cliPath || 'opencode';
    }

    protected buildArgs(task: Task): string[] {
        const args: string[] = ['run', '-q'];
        if (this._options.model) {
            args.push('-m', this._options.model);
        }
        args.push(task.prompt);
        return args;
    }

    protected getSpawnCwd(): string | undefined {
        return this._options.cwd;
    }

    protected getSpawnEnv(): NodeJS.ProcessEnv | undefined {
        return buildRelayEnv(['openai', 'anthropic'], this._options.authToken);
    }

    protected logLabel(): string {
        return 'OpenCode';
    }
}
