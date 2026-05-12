import { InterruptionType, TaskRecovery } from '../types';

export interface InterruptionHint {
    type: InterruptionType;
    title: string;
    message: string;
    action: string;
    retryable: boolean;
    autoRetry: boolean;
    defaultDelayMs?: number;
}

interface Rule extends InterruptionHint {
    patterns: RegExp[];
}

export interface RecoveryDelayOptions {
    baseDelayMs: number;
    maxDelayMs: number;
}

const RULES: Rule[] = [
    {
        type: 'quota-exhausted',
        title: '额度已用完',
        message: '当前模型或账号额度已经耗尽，继续重试通常不会立刻恢复。',
        action: '请切换账号、模型或 API Key，或等待额度重置后再重试。',
        retryable: false,
        autoRetry: false,
        patterns: [
            /daily usage quota has been exhausted/i,
            /included (daily )?usage quota is exhausted/i,
            /quota (has been )?exhausted/i,
            /insufficient[_ -]?quota/i,
            /billing.*quota/i,
        ],
    },
    {
        type: 'rate-limited',
        title: '请求过快',
        message: '服务端提示当前请求太频繁，稍等一会儿通常可以恢复。',
        action: '系统会延迟后自动重试；如果频繁出现，可降低并发或更换容量更高的接口。',
        retryable: true,
        autoRetry: true,
        defaultDelayMs: 10_000,
        patterns: [
            /resource[_ -]?exhausted/i,
            /rate[_ -]?limit/i,
            /too many requests/i,
            /\b429\b/,
            /please try again later/i,
        ],
    },
    {
        type: 'response-truncated',
        title: '回复被截断',
        message: '模型回复到达长度限制，已有内容可能不完整。',
        action: '请让执行器继续上一段回复，或把任务拆小后重新派发。',
        retryable: true,
        autoRetry: false,
        patterns: [
            /response was cut short/i,
            /cut short due to length limits/i,
            /continue response/i,
            /finish_reason["']?\s*:\s*["']?length/i,
            /maximum context length/i,
            /max(?:imum)? tokens/i,
        ],
    },
    {
        type: 'tool-limit',
        title: '工具调用达到上限',
        message: '执行器已经用完本轮工具调用次数，继续原任务可能会再次卡住。',
        action: '请拆分任务，或提高对应执行器的工具调用轮次配置后再重试。',
        retryable: true,
        autoRetry: false,
        patterns: [
            /tool calls?.*(exceeded|limit|too many)/i,
            /invocation limit/i,
            /too many tool/i,
            /工具调用轮次超过限制/i,
            /达到调用限制/i,
        ],
    },
    {
        type: 'terminal-stuck',
        title: '命令执行卡住',
        message: '终端命令或本地进程长时间没有完成，可能需要人工确认当前状态。',
        action: '请检查终端输出；确认无副作用后可以取消任务并重新派发。',
        retryable: true,
        autoRetry: false,
        patterns: [
            /terminal.*stuck/i,
            /command.*stuck/i,
            /command.*timed?\s*out/i,
            /process.*timed?\s*out/i,
            /命令.*超时/i,
            /终端.*卡住/i,
        ],
    },
    {
        type: 'authorization-required',
        title: '需要授权',
        message: '执行器或接口需要额外授权，自动重试无法解决。',
        action: '请检查 API Key、登录状态、权限弹窗或允许/拒绝列表。',
        retryable: false,
        autoRetry: false,
        patterns: [
            /\b401\b|\b403\b/,
            /unauthorized/i,
            /not authorized/i,
            /authentication/i,
            /invalid api key/i,
            /permission required/i,
            /requires approval/i,
            /allow.*deny/i,
        ],
    },
    {
        type: 'provider-overloaded',
        title: '模型服务过载',
        message: '模型提供方当前容量不足，这类问题一般是临时的。',
        action: '系统会延迟后自动重试；如果多次失败，可切换模型或接口。',
        retryable: true,
        autoRetry: true,
        defaultDelayMs: 20_000,
        patterns: [
            /over capacity/i,
            /providers? are over capacity/i,
            /provider overloaded/i,
            /retryable error from model provider/i,
            /temporarily unavailable/i,
            /\b503\b/,
            /\b529\b/,
        ],
    },
    {
        type: 'network',
        title: '网络连接异常',
        message: '请求没有稳定到达模型服务，可能是网络、代理或服务连接波动。',
        action: '系统会延迟后自动重试；如果持续失败，请检查网络、代理和接口地址。',
        retryable: true,
        autoRetry: true,
        defaultDelayMs: 10_000,
        patterns: [
            /model provider unreachable/i,
            /connection timeout/i,
            /network/i,
            /fetch failed/i,
            /econnreset/i,
            /econnrefused/i,
            /enotfound/i,
            /eai_again/i,
            /socket hang up/i,
            /aborted/i,
            /aborterror/i,
            /timed?\s*out/i,
            /连接超时/i,
        ],
    },
    {
        type: 'internal',
        title: '服务内部错误',
        message: '模型服务返回了内部错误，通常可以稍后重试。',
        action: '系统会延迟后自动重试；如果持续失败，请保存日志并切换模型或接口。',
        retryable: true,
        autoRetry: true,
        defaultDelayMs: 8_000,
        patterns: [
            /internal error/i,
            /invalid argument.*internal/i,
            /\b500\b/,
            /\b502\b/,
            /server error/i,
            /内部错误/i,
        ],
    },
    {
        type: 'version-outdated',
        title: '版本过旧',
        message: '当前客户端或执行器版本过旧，无法通过重试修复。',
        action: '请更新对应工具或扩展后再重新派发任务。',
        retryable: false,
        autoRetry: false,
        patterns: [
            /version is out of date/i,
            /version.*outdated/i,
            /out of date/i,
            /需要更新/i,
            /版本过旧/i,
        ],
    },
];

const UNKNOWN_HINT: InterruptionHint = {
    type: 'unknown',
    title: '未知错误',
    message: '当前错误不在已知恢复策略中，系统不会自动重试。',
    action: '请查看日志后手动重试，或调整任务和执行器配置。',
    retryable: true,
    autoRetry: false,
};

export function errorToText(error: unknown): string {
    if (error instanceof Error) {
        const parts = [error.message, error.name].filter(Boolean);
        return parts.join('\n');
    }
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export function classifyInterruption(error: unknown): InterruptionHint {
    const text = errorToText(error);
    for (const rule of RULES) {
        if (rule.patterns.some(pattern => pattern.test(text))) {
            return {
                type: rule.type,
                title: rule.title,
                message: rule.message,
                action: rule.action,
                retryable: rule.retryable,
                autoRetry: rule.autoRetry,
                defaultDelayMs: rule.defaultDelayMs,
            };
        }
    }
    return UNKNOWN_HINT;
}

export function calculateRecoveryDelayMs(
    hint: InterruptionHint,
    completedRetries: number,
    options: RecoveryDelayOptions,
): number {
    const base = Math.max(0, hint.defaultDelayMs ?? options.baseDelayMs);
    const floor = Math.max(0, options.baseDelayMs);
    const max = Math.max(floor, options.maxDelayMs);
    const exponential = base * Math.pow(2, Math.max(0, completedRetries));
    return Math.min(max, Math.max(floor, exponential));
}

export function createTaskRecovery(
    hint: InterruptionHint,
    options: {
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        nextRetryAt?: number;
        autoRetry?: boolean;
    } = {},
): TaskRecovery {
    return {
        type: hint.type,
        title: hint.title,
        message: hint.message,
        action: hint.action,
        retryable: hint.retryable,
        autoRetry: options.autoRetry ?? hint.autoRetry,
        attempt: options.attempt,
        maxAttempts: options.maxAttempts,
        delayMs: options.delayMs,
        nextRetryAt: options.nextRetryAt,
    };
}
