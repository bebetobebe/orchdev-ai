import { describe, expect, it } from 'vitest';
import { calculateRecoveryDelayMs, classifyInterruption } from '../src/orchestrator/interruptionRecovery';

describe('interruptionRecovery', () => {
    it('classifies common provider and execution interruptions', () => {
        const cases = [
            ['Failed precondition: Your daily usage quota has been exhausted', 'quota-exhausted'],
            ['resource_exhausted. Please try again later', 'rate-limited'],
            ["Cascade's response was cut short due to length limits. Continue response", 'response-truncated'],
            ['Cascade stopped at the invocation limit and asks you to continue', 'tool-limit'],
            ['terminal command timed out while the task was still running', 'terminal-stuck'],
            ['Allow / Deny popup requires approval before web request', 'authorization-required'],
            ['Model provider unreachable / connection timeout', 'network'],
            ['Cascade has encountered an internal error', 'internal'],
            ['all API providers are over capacity', 'provider-overloaded'],
            ['Failed precondition: Your Windsurf version is out of date', 'version-outdated'],
        ] as const;

        for (const [message, expected] of cases) {
            expect(classifyInterruption(new Error(message)).type).toBe(expected);
        }
    });

    it('marks transient categories as automatic retry candidates', () => {
        expect(classifyInterruption('rate limit hit').autoRetry).toBe(true);
        expect(classifyInterruption('fetch failed: ECONNRESET').autoRetry).toBe(true);
        expect(classifyInterruption('retryable error from model provider').autoRetry).toBe(true);
        expect(classifyInterruption('Invalid argument: an internal error occurred').autoRetry).toBe(true);
    });

    it('does not automatically retry manual-action categories', () => {
        expect(classifyInterruption('quota has been exhausted').autoRetry).toBe(false);
        expect(classifyInterruption('invalid api key').autoRetry).toBe(false);
        expect(classifyInterruption('version is out of date').autoRetry).toBe(false);
        expect(classifyInterruption('工具调用轮次超过限制').autoRetry).toBe(false);
    });

    it('caps exponential retry delays', () => {
        const hint = classifyInterruption('resource_exhausted. Please try again later');
        const opts = { baseDelayMs: 10_000, maxDelayMs: 30_000 };

        expect(calculateRecoveryDelayMs(hint, 0, opts)).toBe(10_000);
        expect(calculateRecoveryDelayMs(hint, 1, opts)).toBe(20_000);
        expect(calculateRecoveryDelayMs(hint, 2, opts)).toBe(30_000);
    });
});
