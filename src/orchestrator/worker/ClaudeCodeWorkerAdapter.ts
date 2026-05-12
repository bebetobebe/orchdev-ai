import { Task } from '../../types';
import { BaseCliWorkerAdapter } from './BaseCliWorkerAdapter';
import { buildRelayEnv } from './relayEnv';

export interface ClaudeCodeWorkerOptions {
    /** Path to the claude binary (defaults to 'claude'). */
    cliPath?: string;
    /** Optional model identifier passed via --model (e.g. 'claude-sonnet-4-5'). */
    model?: string;
    /** Optional working directory for spawned children. */
    cwd?: string;
    /**
     * User-supplied auth token for the baked-in relay. Mapped to
     * ANTHROPIC_API_KEY when relay is enabled.
     */
    authToken?: string;
}

/**
 * Adapter for Anthropic's official Claude Code CLI (anthropics/claude-code).
 *
 * Dispatching a task runs:
 *   claude -p [--model MODEL] <prompt>
 *
 * `-p` (a.k.a. `--print`) makes Claude Code emit the final response to stdout
 * and exit, which is exactly the shape this orchestrator expects.
 */
export class ClaudeCodeWorkerAdapter extends BaseCliWorkerAdapter {
    private readonly _options: ClaudeCodeWorkerOptions;

    constructor(id: string, name: string, options: ClaudeCodeWorkerOptions = {}) {
        super(id, name, 'cli');
        this._options = options;
    }

    protected getCliPath(): string {
        return this._options.cliPath || 'claude';
    }

    protected buildArgs(task: Task): string[] {
        const args: string[] = ['-p'];
        if (this._options.model) {
            args.push('--model', this._options.model);
        }
        args.push(task.prompt);
        return args;
    }

    protected getSpawnCwd(): string | undefined {
        return this._options.cwd;
    }

    protected getSpawnEnv(): NodeJS.ProcessEnv | undefined {
        return buildRelayEnv(['anthropic'], this._options.authToken);
    }

    protected logLabel(): string {
        return 'Claude Code';
    }
}
