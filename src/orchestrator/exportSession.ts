import { Session, Task } from '../types';

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

function resultSummary(result: Task['result']): string {
    return typeof result?.summary === 'string' && result.summary.trim()
        ? result.summary
        : '执行器没有返回有效摘要。';
}

function resultModifiedFiles(result: Task['result']): string[] {
    return Array.isArray(result?.modifiedFiles)
        ? result.modifiedFiles.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        : [];
}

function resultArtifacts(result: Task['result']) {
    return Array.isArray(result?.artifacts)
        ? result.artifacts.filter(a => a && (a.type === 'file' || a.type === 'snippet') && typeof a.name === 'string')
        : [];
}

function resultLogs(result: Task['result']): string[] {
    return Array.isArray(result?.logs)
        ? result.logs.filter((log): log is string => typeof log === 'string')
        : [];
}

/**
 * Export a session and its tasks as a self-contained Markdown document.
 * This is a pure function — it takes data and returns a string.
 */
export function exportSessionMarkdown(session: Session, tasks: Task[]): string {
    const lines: string[] = [];

    // Header
    lines.push(`# ${session.name}`);
    lines.push('');
    lines.push(`**目标：** ${session.goal}`);
    lines.push(`**创建时间：** ${new Date(session.createdAt).toLocaleString()}`);
    if (session.summary) {
        lines.push('');
        lines.push('## 会话摘要');
        lines.push('');
        lines.push(session.summary);
    }

    // Tasks
    if (tasks.length > 0) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push('## 任务');

        for (const task of tasks) {
            lines.push('');
            lines.push(`### [${modeLabel(task.mode)}] ${task.prompt}`);
            lines.push('');
            lines.push(`- **状态：** ${statusLabel(task.status)}`);
            lines.push(`- **创建时间：** ${new Date(task.createdAt).toLocaleString()}`);
            if (task.completedAt) {
                lines.push(`- **完成时间：** ${new Date(task.completedAt).toLocaleString()}`);
            }
            if (task.workerId) {
                lines.push(`- **执行器：** ${task.workerId}`);
            }

            if (task.result) {
                const modifiedFiles = resultModifiedFiles(task.result);
                const artifacts = resultArtifacts(task.result);
                const logs = resultLogs(task.result);

                lines.push('');
                lines.push(`**结果：** ${resultSummary(task.result)}`);

                if (modifiedFiles.length > 0) {
                    lines.push('');
                    lines.push('**修改文件：**');
                    for (const path of modifiedFiles) {
                        lines.push(`- ${path}`);
                    }
                }

                if (artifacts.length > 0) {
                    lines.push('');
                    lines.push('#### 产物');
                    for (const a of artifacts) {
                        lines.push('');
                        const label = a.type === 'file' ? `文件：${a.name}` : `代码片段：${a.name}`;
                        lines.push(`**${label}**`);
                        lines.push('');
                        lines.push('```');
                        lines.push(typeof a.content === 'string' ? a.content : '');
                        lines.push('```');
                    }
                }

                if (logs.length > 0) {
                    lines.push('');
                    lines.push('<details><summary>日志</summary>');
                    lines.push('');
                    lines.push('```');
                    lines.push(logs.join('\n'));
                    lines.push('```');
                    lines.push('');
                    lines.push('</details>');
                }
            }
        }
    }

    lines.push('');
    return lines.join('\n');
}
