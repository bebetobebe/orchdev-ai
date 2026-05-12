import { Task, TaskResult } from '../../types';
import { BaseCliWorkerAdapter } from './BaseCliWorkerAdapter';

export class MCPWorkerAdapter extends BaseCliWorkerAdapter {
    constructor(id: string, name: string) {
        super(id, name, 'mcp');
    }

    protected getCliPath(): string {
        return 'mcp';
    }

    protected buildArgs(task: Task): string[] {
        return ['run', '--prompt', task.prompt];
    }

    /** MCP historically assumes availability without probing the binary. */
    protected shouldProbeVersion(): boolean {
        return false;
    }

    /** Preserve the legacy MCP summary shape while still extracting artifacts. */
    protected formatResult(stdout: string, _stderr: string): TaskResult {
        return {
            summary: `MCP 任务已完成。原始输出：${stdout.substring(0, 200)}...`,
            artifacts: this.parseArtifacts(stdout),
            logs: [stdout]
        };
    }

    protected logLabel(): string {
        return this.worker.name;
    }
}
