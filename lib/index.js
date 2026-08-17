/**
 * dsh-view-image: 让 dsh 用独立的 OpenAI 兼容视觉模型识别本地图片，返回纯文本描述。
 *
 * 与 pi 的 view-image 扩展同一思路：
 *   - 主对话历史里只留下「工具调用 + 纯文本结果」，不含任何 image content，
 *     所以主模型不支持视觉模态（内置 read_image 在 `assertImageCapableRoute`
 *     处被拒）时，也能通过本工具读图。
 *   - 视觉模型配置见 $DSH_HOME/vision-model.json（默认 ~/.dsh/vision-model.json）：
 *       { baseUrl, apiKey, model, api?: "openai-completions"|"anthropic-messages", maxTokens?: 2048 }
 *     示例文件在本包根目录 vision-model.example.json。
 *
 * 零运行时依赖：HTTP 用 Node 全局 fetch，包名解析走 profile 目录的
 * node_modules 链（dsh 启动时会把安装目录的依赖 symlink 到
 * $DSH_HOME/profiles/node_modules，profile 里安装的插件从这里拿到
 * @deepseek-ai/* 包）。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";

// ─ 元数据 ──────────────────────────────────────────────

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-view-image";

/** Services required by this plugin. */
const inject = ["tools", "fs", "systemPrompt"];

/** Plugin config: 都是可选覆盖项，核心配置在 vision-model.json。 */
const Config = z.object({
	/** 视觉模型配置文件路径，默认 $DSH_HOME/vision-model.json。 */
	configPath: z.string(),
	/** 请求超时（毫秒），默认 180000。 */
	requestTimeoutMs: z.number().default(180000),
	/** 单张图片最大字节数，默认 10MB；超过直接报错而不是截断。 */
	maxImageBytes: z.number().default(10 * 1024 * 1024),
	/** 无 intent 时的默认识别提示词。 */
	defaultPrompt: z.string(),
});

// ─ 常量 ──────────────────────────────────────────────

/** 默认视觉模型配置文件路径。 */
function defaultConfigPath() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "vision-model.json");
}

const DEFAULT_API = "openai-completions";
const DEFAULT_MAX_TOKENS = 2048;

const DEFAULT_PROMPT =
	"详细描述这张图片的内容，包括文字、图形、布局等关键信息。用中文回答。";

/** Extensions `view_image` accepts; magic-byte validation stays with the endpoint. */
const IMAGE_EXTENSIONS = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

/** 视觉模型返回文本的解析：兼容 string 与数组两种 content 形态。 */
function textFromContent(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** 把 baseUrl 规范成对应协议完整端点。 */
function endpointFor(baseUrl, api) {
	const url = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") return url;
	if (/\/chat\/completions$/.test(url)) return url;
	return `${url}/chat/completions`;
}

// ─ 配置加载 ──────────────────────────────────────────

function loadVisionConfig(configPath) {
	if (!existsSync(configPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8"));
		if (!raw?.baseUrl || !raw?.apiKey || !raw?.model) return null;
		return {
			baseUrl: String(raw.baseUrl),
			apiKey: String(raw.apiKey),
			model: String(raw.model),
			api: raw.api === "anthropic-messages" ? "anthropic-messages" : DEFAULT_API,
			maxTokens:
				Number.isInteger(raw.maxTokens) && raw.maxTokens > 0
					? raw.maxTokens
					: DEFAULT_MAX_TOKENS,
		};
	} catch {
		return null;
	}
}

// ─ 视觉模型调用 ──────────────────────────────────────

/**
 * 用配置的视觉模型识别图片，返回纯文本。
 * OpenAI 兼容端点走 /chat/completions；Anthropic 端点走 /messages。
 * 任何失败都以 Error 抛出（静默截断永远不会发生）。
 */
async function requestVisionModel(vision, prompt, dataUrl, mediaType, signal, timeoutMs) {
	const endpoint = endpointFor(vision.baseUrl, vision.api);
	const effectiveSignal = signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

	let init;
	if (vision.api === "anthropic-messages") {
		init = {
			method: "POST",
			signal: effectiveSignal,
			headers: {
				"content-type": "application/json",
				"x-api-key": vision.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: vision.model,
				max_tokens: vision.maxTokens,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: prompt },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: mediaType,
									data: dataUrl.split(",")[1],
								},
							},
						],
					},
				],
			}),
		};
	} else {
		init = {
			method: "POST",
			signal: effectiveSignal,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${vision.apiKey}`,
			},
			body: JSON.stringify({
				model: vision.model,
				max_tokens: vision.maxTokens,
				stream: false,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: prompt },
							{
								type: "image_url",
								image_url: { url: dataUrl },
							},
						],
					},
				],
			}),
		};
	}

	let resp;
	try {
		resp = await fetch(endpoint, init);
	} catch (error) {
		if (signal.aborted) throw new Error("view_image: 请求已被取消");
		if (error?.name === "TimeoutError" || error?.name === "AbortError")
			throw new Error(`view_image: 视觉模型请求超时（${timeoutMs}ms）`);
		throw new Error(`view_image: 请求视觉模型失败：${error instanceof Error ? error.message : String(error)}`);
	}

	if (!resp.ok) {
		let detail = "";
		try {
			detail = (await resp.text()).slice(0, 500);
		} catch { /* 忽略 body 读取失败 */ }
		throw new Error(`view_image: 视觉模型返回 HTTP ${resp.status}${detail ? `：${detail}` : ""}`);
	}

	const data = await resp.json().catch(() => null);
	if (!data) throw new Error("view_image: 视觉模型返回了无法解析的响应");

	let text;
	if (vision.api === "anthropic-messages") {
		text = textFromContent(data?.content);
	} else {
		text = textFromContent(data?.choices?.[0]?.message?.content);
	}
	if (!text) {
		const stop = data?.choices?.[0]?.finish_reason ?? data?.stop_reason ?? "unknown";
		throw new Error(`view_image: 视觉模型未返回有效文本（finish_reason=${stop}）`);
	}
	return text;
}

// ─ 扩展入口 ──────────────────────────────────────────

function apply(ctx, config) {
	// 手动应用默认值：loader 未实例化 Config 时 config 可能为 undefined。
	const cfg = {
		configPath: config?.configPath,
		requestTimeoutMs: config?.requestTimeoutMs ?? 180000,
		maxImageBytes: config?.maxImageBytes ?? 10 * 1024 * 1024,
		defaultPrompt: config?.defaultPrompt,
	};
	const visionPath = cfg.configPath ?? defaultConfigPath();
	const vision = loadVisionConfig(visionPath);
	const logger = ctx.logger("view-image");

	if (!vision) {
		// 配置缺失时插件静默加载：不注册工具，只打日志。用户补齐配置文件后
		// 重启（或 HMR）即可生效，和 view-image 的「配置缺失则不生效」一致。
		logger.warn(`view_image 未加载：缺少 ${visionPath}（需 baseUrl / apiKey / model 三个字段）。参考 vision-model.example.json 创建。`);
		return;
	}

	// 提示词引导：当前模型不支持图像输入时优先用 view_image，而不是 read_image。
	ctx.systemPrompt.section({
		name: "tool:view-image",
		order: 103,
		text: "view_image reads a local image file through a separately configured vision model and returns a plain-text description; image bytes never enter the conversation. Use view_image when the user mentions an image path (.png/.jpg/.jpeg/.webp/.gif/.bmp, e.g. a pasted clipboard image) and wants its content, especially when the current model does not accept image input — read_image requires an image-capable route and will fail on a text-only model.",
	});

	ctx.tools.register(
		defineTool({
			name: "view_image",
			description:
				"Read a local image file (PNG/JPEG/WebP/GIF/BMP) through a separately configured vision model and return a plain-text description of its content. Image bytes never enter the conversation, so this works even when the current model does not accept image input (unlike read_image which requires an image-capable model). Pass an optional intent (e.g. extract the text, describe the chart).",
			parameters: {
				file_path: {
					type: "string",
					required: true,
					description: "Path to the image file, resolved by the filesystem backend.",
				},
				intent: {
					type: "string",
					description: "What to focus on, e.g. \"提取图中文字\" or \"描述图表内容\". Defaults to a general Chinese description.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						mediaType: { type: "string", required: true, enum: Object.values(IMAGE_EXTENSIONS) },
						description: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.description }],
				presentationMeta: (_args, value) => ({
					path: value.path,
					mediaType: value.mediaType,
					provider: vision.model,
				}),
			},
			isConcurrencySafe: () => true,
			timeoutMs: cfg.requestTimeoutMs,
			async execute(args, exec) {
				// ── 参数校验 ──
				const filePath = String(args.file_path ?? "").trim();
				if (filePath.length === 0) throw new Error("view_image: file_path must be a non-empty string");

				const mediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
				if (mediaType === undefined)
					throw new Error(`view_image: cannot read "${filePath}": only PNG/JPEG/WebP/GIF/BMP paths are accepted`);

				// ── 路径解析（与 read 工具一致：按调用 session 的 cwd）──
				const cwd = exec.agent?.session?.header?.cwd;
				const target = await ctx.fs.resolve(filePath, {
					...(cwd !== undefined ? { cwd } : {}),
					signal: exec.signal,
				});

				const info = await ctx.fs.stat(target, exec.signal);
				if (info === undefined)
					throw new Error(`view_image: cannot read "${target.displayPath}": not found`);
				if (info.type !== "file")
					throw new Error(`view_image: cannot read "${target.displayPath}": not a regular file`);

				// ── 读取字节（readBytes 超限抛 FS_TOO_LARGE，不会截断）──
				const bytes = await ctx.fs.readBytes(target, exec.signal, cfg.maxImageBytes);
				if (bytes.byteLength === 0) throw new Error(`view_image: image file is empty: "${target.displayPath}"`);

				// ── 组装提示词与 base64 data URL ──
				const intent = String(args.intent ?? "").trim();
				const prompt = intent.length > 0
					? `${intent}\n\n请根据上面要求分析这张图片。用中文回答。`
					: (cfg.defaultPrompt ?? DEFAULT_PROMPT);
				const dataUrl = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

				// ── 调视觉模型（转发 exec.signal，保证可被取消）──
				const description = await requestVisionModel(vision, prompt, dataUrl, mediaType, exec.signal, cfg.requestTimeoutMs);

				return { path: target.displayPath, mediaType, description };
			},
			presentCall(args) {
				return {
					card: "generic",
					title: `Read image ${args.file_path}`,
					kind: "read",
					locations: [{ path: args.file_path }],
				};
			},
		}),
	);
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };