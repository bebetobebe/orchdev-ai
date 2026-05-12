import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELAY_CONFIG } from '../src/config/relayConfig';
import { buildRelayEnv } from '../src/orchestrator/worker/relayEnv';

const ORIGINAL = { ...RELAY_CONFIG };

function resetRelayConfig() {
    RELAY_CONFIG.enabled = true;
    RELAY_CONFIG.openaiBaseUrl = 'https://relay.test/openai/v1';
    RELAY_CONFIG.anthropicBaseUrl = 'https://relay.test/anthropic';
    RELAY_CONFIG.geminiBaseUrl = 'https://relay.test/gemini/v1';
    RELAY_CONFIG.openaiDefaultModel = 'test-model';
    RELAY_CONFIG.brandName = 'Test Relay';
}

describe('buildRelayEnv', () => {
    beforeEach(() => resetRelayConfig());
    afterEach(() => Object.assign(RELAY_CONFIG, ORIGINAL));

    it('returns undefined when relay is disabled', () => {
        RELAY_CONFIG.enabled = false;
        expect(buildRelayEnv(['openai'], 'tok')).toBeUndefined();
        expect(buildRelayEnv(['anthropic', 'gemini'], 'tok')).toBeUndefined();
    });

    it('returns undefined when no protocols requested', () => {
        expect(buildRelayEnv([], 'tok')).toBeUndefined();
    });

    it('openai protocol sets both modern and legacy base URL vars', () => {
        const env = buildRelayEnv(['openai'], 'sk-relay-1');
        expect(env).toBeDefined();
        expect(env!.OPENAI_BASE_URL).toBe('https://relay.test/openai/v1');
        expect(env!.OPENAI_API_BASE).toBe('https://relay.test/openai/v1');
        expect(env!.OPENAI_API_KEY).toBe('sk-relay-1');
    });

    it('openai protocol omits the API key var when token is empty', () => {
        const env = buildRelayEnv(['openai'], '');
        expect(env).toBeDefined();
        expect(env!.OPENAI_BASE_URL).toBe('https://relay.test/openai/v1');
        expect('OPENAI_API_KEY' in env!).toBe(false);
    });

    it('openai protocol omits the API key var when token is undefined', () => {
        const env = buildRelayEnv(['openai'], undefined);
        expect(env).toBeDefined();
        expect('OPENAI_API_KEY' in env!).toBe(false);
    });

    it('anthropic protocol sets the right base URL + API key vars', () => {
        const env = buildRelayEnv(['anthropic'], 'sk-relay-2');
        expect(env!.ANTHROPIC_BASE_URL).toBe('https://relay.test/anthropic');
        expect(env!.ANTHROPIC_API_BASE).toBe('https://relay.test/anthropic');
        expect(env!.ANTHROPIC_API_KEY).toBe('sk-relay-2');
        expect('OPENAI_BASE_URL' in env!).toBe(false);
    });

    it('gemini protocol sets the Gemini base URL and both Google API key aliases', () => {
        const env = buildRelayEnv(['gemini'], 'sk-relay-3');
        expect(env!.GOOGLE_GEMINI_BASE_URL).toBe('https://relay.test/gemini/v1');
        expect(env!.GEMINI_API_KEY).toBe('sk-relay-3');
        expect(env!.GOOGLE_API_KEY).toBe('sk-relay-3');
    });

    it('gemini protocol omits the API key vars when no token is set', () => {
        const env = buildRelayEnv(['gemini'], undefined);
        expect(env!.GOOGLE_GEMINI_BASE_URL).toBe('https://relay.test/gemini/v1');
        expect('GEMINI_API_KEY' in env!).toBe(false);
        expect('GOOGLE_API_KEY' in env!).toBe(false);
    });

    it('multi-protocol fans out env vars for every requested protocol', () => {
        const env = buildRelayEnv(['openai', 'anthropic'], 'sk-relay-multi');
        expect(env!.OPENAI_BASE_URL).toBe('https://relay.test/openai/v1');
        expect(env!.ANTHROPIC_BASE_URL).toBe('https://relay.test/anthropic');
        expect(env!.OPENAI_API_KEY).toBe('sk-relay-multi');
        expect(env!.ANTHROPIC_API_KEY).toBe('sk-relay-multi');
    });

    it('uses whatever URLs are in RELAY_CONFIG at call time', () => {
        RELAY_CONFIG.openaiBaseUrl = 'https://other.example/v1';
        const env = buildRelayEnv(['openai'], 'tok');
        expect(env!.OPENAI_BASE_URL).toBe('https://other.example/v1');
    });
});
