import { RELAY_CONFIG } from '../../config/relayConfig';

/**
 * Which on-the-wire protocol an adapter speaks. Determines which env vars
 * we inject so the underlying CLI / SDK reroutes its outbound traffic
 * through the baked-in relay endpoint(s).
 */
export type RelayProtocol = 'openai' | 'anthropic' | 'gemini';

/**
 * Build the env-var overlay for spawning a CLI worker behind the relay.
 *
 * Returns `undefined` when relay is disabled or no protocols were requested
 * — the caller should then inherit `process.env` unchanged.
 *
 * Behaviour:
 *   - Base URL env vars are always set when relay is enabled. Both the modern
 *     (`*_BASE_URL`) and legacy (`*_API_BASE`) variants are set so we work
 *     with OpenAI/Anthropic SDKs *and* with Aider/litellm-style consumers.
 *   - API-key env vars are set only when `authToken` is non-empty. If the
 *     user has not configured an authToken, the relay receives a request
 *     without a key and may serve the public/free tier, return 401, etc.
 *   - For multi-provider CLIs (OpenCode, Aider) callers can request both
 *     'openai' and 'anthropic' so the CLI's runtime model selection lands
 *     on the right relay endpoint without further hints.
 */
export function buildRelayEnv(
    protocols: RelayProtocol[],
    authToken: string | undefined
): NodeJS.ProcessEnv | undefined {
    if (!RELAY_CONFIG.enabled) return undefined;
    if (!protocols || protocols.length === 0) return undefined;

    const env: NodeJS.ProcessEnv = {};
    const token = authToken && authToken.length > 0 ? authToken : undefined;

    for (const proto of protocols) {
        if (proto === 'openai') {
            env.OPENAI_BASE_URL = RELAY_CONFIG.openaiBaseUrl;
            env.OPENAI_API_BASE = RELAY_CONFIG.openaiBaseUrl;
            if (token) env.OPENAI_API_KEY = token;
        } else if (proto === 'anthropic') {
            env.ANTHROPIC_BASE_URL = RELAY_CONFIG.anthropicBaseUrl;
            env.ANTHROPIC_API_BASE = RELAY_CONFIG.anthropicBaseUrl;
            if (token) env.ANTHROPIC_API_KEY = token;
        } else if (proto === 'gemini') {
            env.GOOGLE_GEMINI_BASE_URL = RELAY_CONFIG.geminiBaseUrl;
            if (token) {
                env.GEMINI_API_KEY = token;
                env.GOOGLE_API_KEY = token;
            }
        }
    }

    return env;
}
