import { Task } from '../../types';
import { BaseCliWorkerAdapter } from './BaseCliWorkerAdapter';
import { buildRelayEnv } from './relayEnv';

export interface AiderWorkerOptions {
    /** Path to the aider binary (defaults to 'aider'). */
    cliPath?: string;
    /** Optional model identifier passed via --model (e.g. 'gpt-5'). */
    model?: string;
    /** Working directory for the task; aider operates on the surrounding git repo. */
    cwd?: string;
    /**
     * When true, pass --yes-always so aider does not block waiting for
     * interactive confirmations. Defaults to true since this orchestrator
     * cannot answer prompts.
     */
    autoConfirm?: boolean;
    /**
     * User-supplied auth token for the baked-in relay. Mapped to both
     * OPENAI_API_KEY and ANTHROPIC_API_KEY because aider picks the
     * provider at runtime based on `--model`.
     */
    authToken?: string;
}

/**
 * Adapter for the Aider AI pair-programmer (Aider-AI/aider).
 *
 * Dispatching a task runs (in non-interactive mode):
 *   aider --message <prompt> --no-pretty --no-stream [--yes-always] [--model MODEL]
 *
 * `--message` runs aider once and exits, which lets the orchestrator capture
 * a single completed turn rather than entering aider's REPL.
 */
export class AiderWorkerAdapter extends BaseCliWorkerAdapter {
    private readonly _options: AiderWorkerOptions;

    constructor(id: string, name: string, options: AiderWorkerOptions = {}) {
        super(id, name, 'cli');
        this._options = options;
    }

    protected getCliPath(): string {
        return this._options.cliPath || 'aider';
    }

    protected buildArgs(task: Task): string[] {
        const args: string[] = ['--message', task.prompt, '--no-pretty', '--no-stream'];
        if (this._options.autoConfirm !== false) {
            args.push('--yes-always');
        }
        if (this._options.model) {
            args.push('--model', this._options.model);
        }
        return args;
    }

    protected getSpawnCwd(): string | undefined {
        return this._options.cwd;
    }

    protected getSpawnEnv(): NodeJS.ProcessEnv | undefined {
        return buildRelayEnv(['openai', 'anthropic'], this._options.authToken);
    }

    protected logLabel(): string {
        return 'Aider';
    }
}
