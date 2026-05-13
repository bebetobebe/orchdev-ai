/**
 * 打包时固定的 OpenAI 兼容 API 配置。
 *
 * 适合开源自用和私有 VSIX：把地址、模型、能力开关固定在源码里，
 * 安装后的界面只需要保存密钥，不再让最终使用者手动填写 baseUrl、
 * model 或其它接入参数。
 *
 * 使用方式：
 * 1. 打包前先把 baseUrl 和 model 改成你自己的固定接口；
 * 2. 不要在这里硬编码 API 密钥；
 * 3. 安装后通过“设置固定 API 密钥”或“启用固定 API”命令保存密钥。
 */
export interface FixedApiConfig {
	/** 总开关。false 表示完全不注册固定 API 执行器。 */
	enabled: boolean;
	/** 面板中显示的执行器名称。 */
	name: string;
	/** OpenAI 兼容基础地址，通常以 /v1 结尾。 */
	baseUrl: string;
	/** 请求协议。MintAPI 的 gpt-5.5 建议使用 Responses API。 */
	wireApi: 'chat_completions' | 'responses';
	/** 固定使用的模型名。 */
	model: string;
	/** 可选推理强度，Responses API 模型会使用。 */
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
	/** 是否关闭服务端响应存储。Responses API 下会映射为 store: false。 */
	disableResponseStorage: boolean;
	/** 给打包者记录当前模型上下文窗口，不参与调度逻辑。 */
	modelContextWindow: number;
	/** 给打包者记录自动压缩阈值，不参与调度逻辑。 */
	modelAutoCompactTokenLimit: number;
	/** 可选系统提示词，会附加到每个请求上。 */
	systemPrompt: string;
	/** 单次请求超时（毫秒）。 */
	timeoutMs: number;
	/** 是否启用工作区读写工具。 */
	enableWorkspaceTools: boolean;
	/** 是否允许执行本地命令。 */
	allowCommandExecution: boolean;
	/** 单个任务最多允许的工具调用轮次。 */
	maxToolIterations: number;
	/** 某些本地服务可不需要密钥，例如本机 Ollama。 */
	apiKeyOptional: boolean;
}

export const FIXED_API_CONFIG: FixedApiConfig = {
	enabled: true,
	name: 'MintAPI',
	baseUrl: 'https://mintapi.cn/v1',
	wireApi: 'responses',
	model: 'gpt-5.5',
	reasoningEffort: 'high',
	disableResponseStorage: true,
	modelContextWindow: 400_000,
	modelAutoCompactTokenLimit: 350_000,
	systemPrompt: '',
	timeoutMs: 120_000,
	enableWorkspaceTools: true,
	allowCommandExecution: false,
	maxToolIterations: 20,
	apiKeyOptional: false,
};
