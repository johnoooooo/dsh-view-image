/**
 * dsh-view-image: 让 dsh 用独立的 OpenAI 兼容视觉模型读图，返回纯文本描述。
 *
 * 与 pi 的 view-image 扩展同一思路：
 *   - 主对话历史里只留下「工具调用 + 纯文本结果」，不含任何 image content，
 *     所以主模型不支持视觉模态（内置 read_image 在 `assertImageCapableRoute`
 *     处被拒）时，也能通过本工具读图。
 *   - 视觉模型配置见 $DSH_HOME/vision-model.json（默认 ~/.dsh/vision-model.json）：
 *       { baseUrl, apiKey, model, api?: "openai-completions"|"anthropic-messages", maxTokens?: 2048 }
 *     示例文件在本包根目录 vision-model.example.json。
 *
 * 两种读图方式：
 *   1. file_path：模型传一个可被 `ctx.fs` 解析的文件路径（headless/终端里
 *      "提到某张图片路径" 的场景）。
 *   2. attachment_id：Web 界面粘贴图片时，本插件包装宿主 `apiProxy.sessions.prompt`，
 *      把图片 part 落库为持久附件（attachments 服务），再替换成文本标记
 *      `[图片附件: <attachmentId>]`，模型看到标记后调用 view_image 传
 *      attachment_id 读取——纯文本路由的图片粘贴不再被 admission 拒绝。
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

// ─ 常量 ──────────────────────────────────────────────

/** 默认视觉模型配置文件路径。 */
function defaultConfigPath() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "vision-model.json");
}

const DEFAULT_API = "openai-completions";
const DEFAULT_MAX_TOKENS = 2048;

const DEFAULT_PROMPT =
	"详细描述这张图片的内容，包括文字、图形、布局等关键信息。用中文回答。";

/**
 * 默认 intent 软引导文案：英文框架 + defaultPrompt 的内容（跟随配置，
 * 避免两处默认文案漂移——用户改 defaultPrompt 时引导自动同步）。
 */
function defaultIntentGuidance(prompt) {
	return `If the user gives no specific focus, describe the image in full by default: ${prompt}`;
}

/**
 * 进程内登记粘贴改写时落库的完整附件 ref（attachmentId → ImageAttachmentRef）。
 * execute 读取时优先用登记的原生 ref，模型不必精确转抄标记里的每个字段；
 * 跨进程 / 重启后的 replay 仍由标记字段兜底。
 */
const savedImageRefs = new Map();

// ─ 元数据（Config 依赖上面的常量，声明在常量之后）──────

/** Plugin config: 都是可选覆盖项，核心配置在 vision-model.json。 */
const Config = z.object({
	/** 视觉模型配置文件路径，默认 $DSH_HOME/vision-model.json。 */
	configPath: z.string().default(defaultConfigPath()),
	/** 请求超时（毫秒），默认 180000。 */
	requestTimeoutMs: z.number().default(180000),
	/** 单张图片最大字节数，默认 10MB；超过直接报错而不是截断。 */
	maxImageBytes: z.number().default(10 * 1024 * 1024),
	/** 无 intent 时的默认识别提示词。 */
	defaultPrompt: z.string().default(DEFAULT_PROMPT),
	/** 软引导：主模型生成 intent 时参考的默认偏好（默认跟随 defaultPrompt）；空字符串禁用引导。未配置（undefined）即可选。 */
	intentGuidance: z.string(),
	/** 是否接管 Web 端图片粘贴（默认开启；纯文本路由下把贴图转成附件标记）。 */
	rewritePastedImages: z.boolean().default(true),
	/** 是否挂附件预览路由 + 客户端工具行内联图（默认开启；关闭后聊天里不再内联显示图片）。 */
	inlineImagePreview: z.boolean().default(true),
});

/** Extensions `view_image` accepts; magic-byte validation stays with the endpoint. */
const IMAGE_EXTENSIONS = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

/** 粘贴图片替换成的文本标记格式：模型看到它就知道该调用 view_image，并把标记里的字段原样传给工具。 */
function imageMarkerText(ref) {
	const parts = [
		`attachment_id=${JSON.stringify(ref.attachmentId)}`,
		`media_type=${JSON.stringify(ref.mediaType)}`,
		`width=${ref.width}`,
		`height=${ref.height}`,
		`bytes=${ref.bytes}`,
	];
	return `[图片附件: ${ref.attachmentId}]（${ref.mediaType}, ${ref.width}x${ref.height}, ${ref.bytes} bytes）。请用 view_image 工具识别这张图片：${parts.join(", ")}。`;
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
		// 区分「超时」与「用户取消」：内部 AbortSignal.timeout 拒绝时 error.name 是
		// TimeoutError；宿主 tool-call-timeout-policy 的 deadline 先触发时，signal.reason
		// 是 TimeoutReason（code=TOOL_TIMEOUT）。两者都应报超时而不是「已取消」。
		const reason = signal.reason;
		const timedOut =
			error?.name === "TimeoutError" ||
			reason?.name === "TimeoutReason" ||
			reason?.code === "TOOL_TIMEOUT";
		if (timedOut)
			throw new Error(`view_image: 视觉模型请求超时（${timeoutMs}ms）`);
		if (signal.aborted) throw new Error("view_image: 请求已被取消");
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

// ─ 粘贴图片改写（Web 纯文本路由）──────────────────────

/**
 * 判断目标 session 的路由是否为纯文本（模型不支持 image 输入）。
 * 返回 true 表示「需要把图片改写成标记」；false 表示模型自己能看图，无需干预。
 * 优先取该 session 已路由的模型（与宿主 admission 的判断一致）；新 session 尚
 * 无请求头时回退到默认模型选择。
 */
async function routeNeedsImageRewrite(ctx, sessionId) {
	const llm = ctx.get("llm");
	if (!llm) return false;
	const routed = ctx.get("sessions")?.get(sessionId)?.requestHeader()?.config;
	let provider = routed?.provider;
	let model = routed?.model;
	if (provider === undefined || model === undefined) {
		const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
		provider = selection?.provider;
		model = selection?.model;
	}
	if (provider === undefined || model === undefined) return false;
	const info = await llm.resolveModelInfo(provider, model).catch(() => undefined);
	if (!info) return false;
	return info.inputModalities === undefined || !info.inputModalities.includes("image");
}

/**
 * 把 prompt content 里的 image parts 落库为附件，替换成文本标记。
 * 只有纯文本路由才会被调用；任何异常都向上抛给外层兜底。
 */
async function rewriteImageParts(ctx, content) {
	const attachments = ctx.get("attachments");
	if (!attachments) throw new Error("attachments service is unavailable");
	const blocks = [];
	for (const part of content) {
		if (part?.type !== "image") {
			blocks.push({ type: "text", text: part?.text ?? "" });
			continue;
		}
		const data = Buffer.from(String(part.data ?? ""), "base64");
		if (data.byteLength === 0) {
			blocks.push({ type: "text", text: "[图片附件: 空数据]" });
			continue;
		}
		const ref = await attachments.saveImage({
			data: new Uint8Array(data),
			mediaType: part.mediaType,
			...(part.name !== undefined ? { name: part.name } : {}),
		});
		// 登记完整 ref：view_image 读图时优先用它，免去模型转抄字段的环节。
		savedImageRefs.set(String(ref.attachmentId), ref);
		blocks.push({ type: "text", text: imageMarkerText(ref) });
	}
	return blocks;
}

/** 包装宿主 apiProxy.sessions.prompt：纯文本路由下拦截粘贴图片，避免 admission 拒绝。 */
function wrapPromptHandler(ctx, logger) {
	const api = ctx.get("apiProxy");
	if (!api?.sessions || typeof api.sessions.prompt !== "function") return;
	if (api.sessions.__viewImageWrapped) return;
	const original = api.sessions.prompt;
	api.sessions.__viewImageWrapped = true;
	const wrapped = async function (request, signal) {
		try {
			const payload = request?.payload;
			const content = payload?.content;
			if (Array.isArray(content) && content.some((p) => p?.type === "image")) {
				if (await routeNeedsImageRewrite(ctx, String(payload?.sessionId ?? ""))) {
					const rewritten = await rewriteImageParts(ctx, content);
					const copy = {
						...request,
						payload: { ...payload, content: rewritten },
					};
					logger.info(`纯文本路由检测到粘贴图片，已改写为附件标记（${rewritten.filter((b) => b.type === "text" && b.text.includes("[图片附件")).length} 张）`);
					return original(copy, signal);
				}
			}
		} catch (error) {
			logger.warn(`图片改写失败，回退原生流程：${error instanceof Error ? error.message : String(error)}`);
		}
		return original(request, signal);
	};
	api.sessions.prompt = wrapped;
	ctx.on("dispose", () => {
		// 恢复原实现并清掉标志：否则 HMR 重建后新实例看到残留标志会跳过包装，
		// 粘贴改写会静默失效直到重启。
		if (api.sessions.prompt === wrapped) api.sessions.prompt = original;
		delete api.sessions.__viewImageWrapped;
	});
}

// ─ 附件预览路由（聊天里内联显示粘贴图）──────────────────

/** AttachmentId 形状：sha256:<64位小写十六进制>。服务前先校验，杜绝路径注入。 */
const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * 按 id 提供附件字节，供聊天界面 markdown 渲染的 <img> 拉取。
 * ref 优先取进程内 registry（改写时登记的完整 ref）；跨重启用 URL 里的查询参数兑底，
 * attachments.readImage 会对 sha/尺寸/mediaType 做完整性校验，查不到或损坏时 404。
 */
async function servePastedImage(ctx, req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { "content-type": "text/plain; charset=utf-8" }).end("method not allowed");
		return;
	}
	const attachments = ctx.get("attachments");
	if (!attachments) {
		res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("attachments service is unavailable");
		return;
	}
	let id;
	try {
		const url = new URL(req.url ?? "", "http://localhost");
		id = decodeURIComponent(url.pathname.slice("/dsh-view-image/attachment/".length));
	} catch {
		id = "";
	}
	if (!ATTACHMENT_ID_RE.test(id)) {
		res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("invalid attachment id");
		return;
	}
	const known = savedImageRefs.get(id);
	const query = new URL(req.url ?? "", "http://localhost").searchParams;
	const mediaType = query.get("mediaType") ?? known?.mediaType;
	const width = Number(query.get("width") ?? known?.width);
	const height = Number(query.get("height") ?? known?.height);
	const bytes = Number(query.get("bytes") ?? known?.bytes);
	const ref =
		known ??
		(mediaType !== null && Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(bytes)
			? { attachmentId: id, mediaType, width, height, bytes }
			: undefined);
	if (ref === undefined) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("attachment reference unavailable");
		return;
	}
	let stored;
	try {
		stored = await attachments.readImage(ref);
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("attachment unavailable");
		return;
	}
	// 内容寻址：同一 id 的字节永远不变，可长期缓存。
	res.writeHead(200, {
		"content-type": stored.ref.mediaType,
		"cache-control": "public, max-age=31536000, immutable",
		"x-content-type-options": "nosniff",
	}).end(req.method === "HEAD" ? undefined : Buffer.from(stored.data));
}

// ─ 扩展入口 ──────────────────────────────────────────

function apply(ctx, config) {
	// 手动应用默认值：loader 未实例化 Config 时 config 可能为 undefined。
	const cfg = {
		configPath: config?.configPath,
		requestTimeoutMs: config?.requestTimeoutMs ?? 180000,
		maxImageBytes: config?.maxImageBytes ?? 10 * 1024 * 1024,
		defaultPrompt: config?.defaultPrompt,
		intentGuidance: config?.intentGuidance,
		rewritePastedImages: config?.rewritePastedImages ?? true,
		inlineImagePreview: config?.inlineImagePreview ?? true,
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
		text: [
			"view_image reads a local image through a separately configured vision model and returns a plain-text description; image bytes never enter the conversation.",
			"Use view_image when: (1) the user mentions an image file path (.png/.jpg/.jpeg/.webp/.gif/.bmp), or (2) a pasted image arrives as a text marker like [图片附件: <attachmentId>] — call view_image with attachment_id=\"<attachmentId>\".",
			"When the current model does not accept image input, read_image fails — prefer view_image for images regardless of the model.",
		].join(" "),
	});

	// Web：接管粘贴图片（不阻塞任何原生行为；不是 web 组合（无 apiProxy）时自动跳过）。
	// 用 ctx.inject 保证 apiProxy 服务已就绪才包装，避免激活顺序竞争。
	if (cfg.rewritePastedImages) {
		ctx.inject(["apiProxy"], (apiCtx) => {
			wrapPromptHandler(apiCtx, logger);
		});
	}

	// 附件预览路由：聊天界面通过 markdown 图片行拉取粘贴图字节（纯文本展示层，不进模型上下文）。
	if (cfg.inlineImagePreview) {
		ctx.inject(["webServer"], (wsCtx) => {
			const dispose = wsCtx.webServer.register({
				kind: "prefix",
				path: "/dsh-view-image/attachment",
				handler: (req, res) => {
					void servePastedImage(wsCtx, req, res);
				},
			});
			wsCtx.on("dispose", dispose);
		});
	}

	// intent 软引导：显式配置优先（空串禁用）；未配置时跟随 defaultPrompt，
	// 避免两处默认文案漂移。
	const intentGuidance = cfg.intentGuidance ?? defaultIntentGuidance(cfg.defaultPrompt ?? DEFAULT_PROMPT);

	ctx.tools.register(
		defineTool({
			name: "view_image",
			description:
				"Read an image through a separately configured vision model and return a plain-text description of its content. Image bytes never enter the conversation, so this works even when the current model does not accept image input (unlike read_image which requires an image-capable model). " +
				"Provide exactly one source: file_path (a path resolvable by the filesystem backend) OR attachment_id (a durable attachment id from a pasted image, e.g. sha256:...; pass media_type if known). " +
				"Optionally pass intent to focus extraction (e.g. \"提取图中文字\" or \"描述图表内容\").",
			parameters: {
				file_path: {
					type: "string",
					description: "Path to the image file, resolved by the filesystem backend.",
				},
				attachment_id: {
					type: "string",
					description: "Durable attachment id of a pasted image (the [图片附件: <id>] marker's id).",
				},
				media_type: {
					type: "string",
					description: "Media type of the attachment image (image/png, image/jpeg, ...), from the [图片附件] marker.",
				},
				attachment_width: {
					type: "number",
					description: "Image width px, from the [图片附件] marker. Pass when known; verified against stored metadata.",
				},
				attachment_height: {
					type: "number",
					description: "Image height px, from the [图片附件] marker. Pass when known; verified against stored metadata.",
				},
				attachment_bytes: {
					type: "number",
					description: "Encoded image byte count, from the [图片附件] marker. Pass when known; verified against stored metadata.",
				},
				intent: {
					type: "string",
					description: "What to focus on, e.g. \"提取图中文字\" or \"描述图表内容\". " + (intentGuidance ? intentGuidance : ""),
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						mediaType: { type: "string", required: true, enum: [...new Set(Object.values(IMAGE_EXTENSIONS))] },
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
				// ── 参数校验：file_path 与 attachment_id 至少给一个 ──
				const filePath = String(args.file_path ?? "").trim();
				const attachmentId = String(args.attachment_id ?? "").trim();

				let bytes;
				let mediaType;
				let displayPath = filePath || attachmentId || "(unknown)";

				if (attachmentId.length > 0) {
					// ── 按附件 id 读取持久化图片字节 ──
					const attachments = ctx.get("attachments");
					if (!attachments) throw new Error("view_image: attachments service is unavailable");
					const declaredMediaType = String(args.media_type ?? "").trim() || undefined;
					// 优先用改写时登记的完整 ref（无需模型转抄字段）；跨重启 replay 用标记字段兑底。
					const ref =
						savedImageRefs.get(attachmentId) ??
						{
							attachmentId,
							...(declaredMediaType !== undefined ? { mediaType: declaredMediaType } : {}),
							...(Number.isFinite(args.attachment_width) ? { width: args.attachment_width } : {}),
							...(Number.isFinite(args.attachment_height) ? { height: args.attachment_height } : {}),
							...(Number.isFinite(args.attachment_bytes) ? { bytes: args.attachment_bytes } : {}),
						};
					let stored;
					try {
						stored = await attachments.readImage(ref, exec.signal);
					} catch (error) {
						if (error?.code === "ATTACHMENT_NOT_FOUND" || error?.code === "ATTACHMENT_CORRUPT") {
							throw new Error(`view_image: 无法读取图片附件 ${attachmentId}（${error.code}）：附件不存在、已损坏，或标记字段与存储不一致。请重新粘贴图片，或原样传递 [图片附件] 标记中的 media_type / attachment_width / attachment_height / attachment_bytes。`);
						}
						throw error;
					}
					bytes = stored?.data;
					mediaType = stored?.ref?.mediaType ?? declaredMediaType;
					displayPath = `attachment:${attachmentId}`;
				} else if (filePath.length > 0) {
					// ── 按文件路径读取（fs 后端解析，尊重 session cwd）──
					mediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
					if (mediaType === undefined)
						throw new Error(`view_image: cannot read "${filePath}": only PNG/JPEG/WebP/GIF/BMP paths are accepted`);
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
					bytes = await ctx.fs.readBytes(target, exec.signal, cfg.maxImageBytes);
					displayPath = target.displayPath;
				} else {
					throw new Error("view_image: provide file_path or attachment_id");
				}

				if (!bytes || bytes.byteLength === 0)
					throw new Error(`view_image: image data is empty for "${displayPath}"`);

				// ── 组装提示词与 base64 data URL ──
				const intent = String(args.intent ?? "").trim();
				const prompt = intent.length > 0
					? `${intent}\n\n请根据上面要求分析这张图片。用中文回答。`
					: (cfg.defaultPrompt ?? DEFAULT_PROMPT);
				const dataUrl = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

				// ── 调视觉模型（转发 exec.signal，保证可被取消）──
				const description = await requestVisionModel(vision, prompt, dataUrl, mediaType, exec.signal, cfg.requestTimeoutMs);

				return { path: displayPath, mediaType, description };
			},
			presentCall(args) {
				const label = args.file_path ?? args.attachment_id ?? "(image)";
				return {
					card: "generic",
					title: `Read image ${label}`,
					kind: "read",
					locations: args.file_path ? [{ path: args.file_path }] : [],
				};
			},
		}),
	);
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };