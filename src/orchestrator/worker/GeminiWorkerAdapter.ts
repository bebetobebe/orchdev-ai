import { Task } from '../../types';
import { BaseCliWorkerAdapter } from './BaseCliWorkerAdapter';
import { buildRelayEnv } from './relayEnv';

export interface GeminiWorkerOptions {
    /** Path to the gemini binary (defaults to 'gemini'). */
    cliPath?: string;
    /** Optional model identifier passed via -m (e.g. 'gemini-2.5-pro'). */
    model?: string;
    /** Optional working directory for spawned children. */
    cwd?: string;
    /**
     * User-supplied auth token for the baked-in relay. Mapped to
     * GEMINI_API_KEY / GOOGLE_API_KEY when relay is enabled.
     */
    authToken?: string;
}

/**
 * Adapter for Google's official Gemini CLI (google-gemini/gemini-cli).
 *
 * Dispatching a task runs:
 *   gemini -p <prompt> [-m MODEL]
 *
 * `-p` is the non-interactive prompt flag. The CLI prints Gemini's final
 * response to stdout and exits, matching this orchestrator's contract.
 */
export class GeminiWorkerAdapter extends BaseCliWorkerAdapter {
    private readonly _options: GeminiWorkerOptions;

    constructor(id: string, name: string, options: GeminiWorkerOptions = {}) {
        super(id, name, 'cli');
        this._options = options;
    }

    protected getCliPath(): string {
        return this._options.cliPath || 'gemini';
    }

    protected buildArgs(task: Task): string[] {
        const args: string[] = ['-p', task.prompt];
        if (this._options.model) {
            args.push('-m', this._options.model);
        }
        return args;
    }

    protected getSpawnCwd(): string | undefined {
        return this._options.cwd;
    }

    protected getSpawnEnv(): NodeJS.ProcessEnv | undefined {
        return buildRelayEnv(['gemini'], this._options.authToken);
    }

    protected logLabel(): string {
        return 'Gemini';
    }
}
