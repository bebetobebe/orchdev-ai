/**
 * 打包内置的 API 中继配置。
 *
 * 开源自用版默认关闭内置中继，避免安装后指向示例地址或误以为
 * 有一个可用的托管服务。日常自用建议优先配置“固定 API 执行器”。
 *
 * 如果你确实有自己的中继服务，可以在打包前：
 *   - 把 enabled 改为 true；
 *   - 填入自己的 OpenAI / Anthropic / Gemini 兼容地址；
 *   - 在 VS Code 里通过“设置中继服务令牌”保存访问令牌。
 *
 * 安全提醒：
 *   - .vsix 本质上是 zip 包，写在这里的 URL 对安装者可见；
 *   - 不要在这里硬编码任何上游模型厂商的 API 密钥；
 *   - 鉴权、限流、计费和防滥用应放在你的中继服务端处理。
 */
export interface RelayConfig {
    /** 总开关。false 表示不注入中继环境变量，也不注册内置 HTTP 中继执行器。 */
    enabled: boolean;
    /**
     * OpenAI 兼容中继地址。
     * Codex 命令行执行器、内置 HTTP 中继执行器，以及任何 OpenAI REST 形态的执行器会使用它。
     */
    openaiBaseUrl: string;
    /** Anthropic 兼容中继地址，主要给 Claude Code 命令行执行器使用。 */
    anthropicBaseUrl: string;
    /** Google Generative AI 兼容中继地址，主要给 Gemini 命令行执行器使用。 */
    geminiBaseUrl: string;
    /** 内置 HTTP 中继执行器的默认模型。 */
    openaiDefaultModel: string;
    /** 执行器面板中显示的名称。 */
    brandName: string;
    /**
     * 可选健康检查地址。为空时不探测。
     *
     * 期望返回 HTTP 2xx 和 JSON。usage 字段可选：
     * {
     *   "ok": true,
     *   "message": "可选提示",
     *   "usage": {
     *     "used": 1234,
     *     "limit": 100000,
     *     "resetAt": "2026-05-01T00:00:00Z"
     *   }
     * }
     */
    healthUrl: string;
}

/**
 * 打包时的中继端点单一来源。
 * 默认全部留空并关闭，适合开源发布和本地 VSIX 自用。
 */
export const RELAY_CONFIG: RelayConfig = {
    enabled: false,
    openaiBaseUrl: '',
    anthropicBaseUrl: '',
    geminiBaseUrl: '',
    openaiDefaultModel: 'gpt-4o-mini',
    brandName: '内置中继',
    healthUrl: ''
};
