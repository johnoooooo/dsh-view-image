# dsh-view-image

让 dsh 用**独立的 OpenAI 兼容视觉模型**读图，返回**纯文本描述**。

主对话历史里只留下「工具调用 + 纯文本结果」，不含任何 image content。因此主模型**
不需要**支持视觉模态——内置 `read_image` 在模型未声明 image 输入时会直接拒绝（
`assertImageCapableRoute` 抛错），而本插件的 `view_image` 不受此限制。

## 安装

把本包安装进目标 profile（与 `dsh1024` 相同的方式）：

```bash
# 一步完成：安装包，并把 "dsh-view-image" 自动追加到
# dsh.profile.bundles（与 dependencies 一起写进 profile 的 package.json）
dsh plugin --profile web add file:/mnt/d/codes/dsh-view-image
```

> 注意：`file:` 安装是**拷贝**进 profile 的 node_modules，不是软链。
> 改完本插件代码后需要重新执行上面的 add（pnpm 会更新拷贝），
> 再重启 dsh。

或者不碰 bundles，把 `cordis.patch.yml` 里的行复制进 profile 的
`cordis.patch.yml`（**但 packages 里必须先装好**，见上一步）。

重新启动 dsh 生效（改配置 `/reload` 时由 HMR 重建，见下）。

## ⚠️ 必须先配视觉模型，否则插件不生效

创建 `$DSH_HOME/vision-model.json`（默认 `~/.dsh/vision-model.json`）。复制示例文件开始：

```bash
cp vision-model.example.json ~/.dsh/vision-model.json
```

编辑填入你自己的视觉模型端点：

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "ollama",
  "model": "llama3.2-vision",
  "api": "openai-completions",
  "maxTokens": 2048
}
```

| 字段 | 说明 |
|------|------|
| `baseUrl` | OpenAI 兼容端点地址（Ollama `/v1` / vLLM / LiteLLM / OpenRouter 等） |
| `apiKey` | 对应端点的 API Key（Ollama 填 `ollama`） |
| `model` | 端点上的视觉模型名 |
| `api` | 协议，默认 `openai-completions`（自动追加 `/chat/completions`）；Anthropic 端点可选 `anthropic-messages` |
| `maxTokens` | 视觉模型最大输出 token 数，默认 2048。密集 OCR 可提到 4096-8192 |

> 配置缺失或不正确时：插件**仍然加载**（不报错），只打一条 `view-image` 日志，
> `view_image` 工具不会注册。补齐配置后重启，或改配置触发 HMR 重建即可。

### 可选插件配置（cordis.patch.yml 里给行加 config）

```yaml
- insert:
    - id: view-image
      name: 'dsh-view-image'
      config:
        configPath: ~/.dsh/vision-model.json   # 默认
        requestTimeoutMs: 180000               # 单次视觉请求超时（毫秒）
        maxImageBytes: 10485760                # 单张图片字节上限，超限报错不截断
        defaultPrompt: '详细描述这张图片的内容，包括文字、图形、布局等关键信息。用中文回答。'
```

## 使用

1. 在 dsh 里提到图片路径即可（粘贴的剪贴板图片、任意 `.png/.jpg/.jpeg/.webp/.gif/.bmp` 文件）。
2. 主模型会自动调用 `view_image`，工具内部用你配的视觉模型识别图片，返回纯文本描述。
3. 想指定关注点就带上 intent，例如 `"提取图中文字"`、`"描述图表内容"`。

headless 验证：

```bash
dsh --profile headless "用 view_image 工具查看 /path/to/img.png 并描述内容"
```

## 工作原理

- 工具 `execute` 用 `ctx.fs` 解析路径（按调用 session 的 cwd）并读取字节，
  `readBytes` 超限抛 `FS_TOO_LARGE`，**永远不会截断图片**。
- 图片以 base64 data URL 发给独立视觉模型，`output.render` 只把纯文本写进
  content，工具结果里**没有 image block**。
- `output.presentationMeta` 携带 `path`/`mediaType`/`provider`，只用于 UI，
  不占模型上下文。
- `systemPrompt.section` 给出一段引导，让模型在文本路由上用 `view_image`
  代替会失败的 `read_image`。
- 请求转发 `exec.signal`（`AbortSignal.any` 叠加超时），可随任务取消。

## 与 view-image（pi 扩展）的关系

本插件是 [@johnoooooo/view-image](https://github.com/johnoooooo/view-image)
在 dsh 插件体系下的移植：同样的「独立视觉模型 + 只回纯文本」思路，机制换成
cordis 插件（`ctx.tools.register(defineTool(...))`），配置从
`~/.pi/agent/vision-model.json` 换成 `~/.dsh/vision-model.json`。

## 许可

MIT