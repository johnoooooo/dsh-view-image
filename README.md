# dsh-view-image

让 dsh 用**独立的 OpenAI 兼容视觉模型**读图，返回**纯文本描述**。

主对话历史里只留下「工具调用 + 纯文本结果」，不含任何 image content。因此主模型**
不需要**支持视觉模态——内置 `read_image` 在模型未声明 image 输入时会直接拒绝（
`assertImageCapableRoute` 抛错），而本插件的 `view_image` 不受此限制。

> 完整的设计思路（架构、数据流、关键机制）见 [DESIGN.md](./DESIGN.md)。

## 安装

把本包安装进目标 profile（与 `dsh1024` 相同的方式）：

```bash
# 一步完成：安装包，并把 "dsh-view-image" 自动追加到
# dsh.profile.bundles（与 dependencies 一起写进 profile 的 package.json）
dsh plugin --profile web add file:/mnt/d/codes/dsh-view-image
```

> 注意：`file:` 安装是**拷贝**进 profile 的 node_modules，不是软链。
> 改完本插件代码后，pnpm 在依赖已存在时不会刷新拷贝（`add` 会报
> "Already up to date"），需要先移除再重装：
>
> ```bash
> dsh plugin --profile web remove dsh-view-image
> dsh plugin --profile web add file:/mnt/d/codes/dsh-view-image
> ```
>
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

### 可选插件配置（cordis.patch.yml）

插件 bundle 自带默认配置（项目根目录 `cordis.patch.yml`，开箱即用）：

```yaml
- insert:
    - id: view-image
      name: 'dsh-view-image'
      config:
        defaultPrompt: '完整描述图片中所有内容，包括所有文字、图形和布局结构。用中文回答。'
```

> `intentGuidance` **默认跟随 `defaultPrompt`**（同一默认偏好的两个作用点：
> 一个引导主模型生成 intent，一个兑底视觉模型的完整提示词）——改 `defaultPrompt`
> 即可同步生效，两处不会漂移。需要单独调引导时再显式配置（空字符串禁用）。

要覆盖默认配置时，在 profile 的 `cordis.patch.yml` 里用**同 id 覆盖条目**
（不是 insert，避免与 bundle 重复报 `duplicate loader entry id`；
config 会被**整体替换**，覆盖时把要保留的字段都写上）：

```yaml
- id: view-image
  name: 'dsh-view-image'
  config:
    configPath: ~/.dsh/vision-model.json
    requestTimeoutMs: 180000
    maxImageBytes: 10485760
    defaultPrompt: '完整描述图片中所有内容，包括所有文字、图形和布局结构。用中文回答。'
    intentGuidance: ''   # 可选；默认跟随 defaultPrompt，空字符串禁用引导
    rewritePastedImages: true
    inlineImagePreview: true
```

全部可配置字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `configPath` | `~/.dsh/vision-model.json` | 视觉模型配置文件路径 |
| `requestTimeoutMs` | `180000` | 单次视觉请求超时（毫秒） |
| `maxImageBytes` | `10485760` | 单张图片字节上限（`file_path` 路径），超限报错不截断 |
| `defaultPrompt` | `完整描述图片中所有内容，包括所有文字、图形和布局结构。用中文回答。` | 主模型不传 intent 时，视觉模型收到的完整提示词 |
| `intentGuidance` | 跟随 `defaultPrompt`（未显式配置时） | 软引导：主模型生成 intent 时参考的默认偏好（用户明确给出关注点时仍以用户为准）；空字符串禁用 |
| `rewritePastedImages` | `true` | 是否接管 Web 粘贴图片（纯文本路由下把贴图转成附件标记） |
| `inlineImagePreview` | `true` | 是否挂附件预览路由 + 聊天里内联显示粘贴图 |

## 使用

### Web 界面（粘贴图片）

1. 在输入框**直接粘贴图片**（Ctrl+V）。
2. 纯文本路由下（比如 deepseek-v4-flash）：本插件在宿主 API 层把粘贴的图片
   落库为持久附件，并替换成文本标记 `[图片附件: ...]` 发给模型——所以不会再弹
   「当前模型不支持图片」的拒绝提示。
3. 模型看到标记后自动调用 `view_image`（传 `attachment_id` 等字段），用你配的
   视觉模型识别，返回纯文本描述；**聊天流里用户消息会内联显示粘贴图**
   （与视觉路由下 ImageGallery 同位置：气泡上方、右对齐、240px 缩略图；
   一次粘贴多张图会全部显示；点击放大、悬停「复制」按钮一键把图片作为
   草稿图插回输入框（不依赖剪贴板，同时尽力复制到剪贴板，按钮反馈
   「已复制到剪贴板，已加入输入框」）、可拖拽到输入框重新发送），
   工具行保持 dsh 原生卡片样式。

   > 曾有一个已修复的 bug：旧版「复制」按钮只写剪贴板，部分环境里点击后
   > 无法粘贴到输入框；根因与修复见 [BUGS.md](./BUGS.md)。

> 原理：dsh 内置的 admission 会拒绝「当前模型不支持 image 输入」的粘贴。本插件
> 包装了宿主 `apiProxy.sessions.prompt`：仅当路由是纯文本模型时，把图片 part 通过
> attachments 服务保存为持久附件，再替换成文本标记（图片字节不进对话历史，也
> 到不了文本模型的请求里）。模型支持图片时完全不动，走原生流程。

### 终端 / headless（提到图片路径）

主模型会自动调用 `view_image`（传 `file_path`），工具读取图片并返回文本描述。
想指定关注点就带上 intent，例如 `"提取图中文字"`、`"描述图表内容"`。

headless 验证：

```bash
dsh --profile headless "用 view_image 工具查看 /path/to/img.png 并描述内容"
```

## 工作原理

- 工具 `execute` 支持两种源：`file_path`（`ctx.fs` 解析，尊重 session cwd）或
  `attachment_id`（持久附件，从 `[图片附件: ...]` 标记读取）。
- `readBytes`/`attachments.readImage` 都遵守各自的完整性校验，**永远不会截断图片**。
- 图片以 base64 data URL 发给独立视觉模型，`output.render` 只把纯文本写进
  content，工具结果里**没有 image block**。
- `output.presentationMeta` 携带 `path`/`mediaType`/`provider`，只用于 UI，
  不占模型上下文。
- `systemPrompt.section` 给出一段引导，让模型在文本路由上用 `view_image`
  代替会失败的 `read_image`。
- 请求转发 `exec.signal`（`AbortSignal.any` 叠加超时），可随任务取消；超时与
  用户取消分开报错（宿主 deadline 的 `TimeoutReason` 也按超时上报）。
- Web 粘贴改写用 `ctx.inject(["apiProxy"], ...)` 等服务就绪后包装
  `apiProxy.sessions.prompt`，仅在纯文本路由时把 image parts 改写为文本标记；
  任何异常都回退到原生流程，不会阻塞正常对话。纯文本判定优先取该 session 已
  路由的模型（与宿主 admission 一致），新会话回退默认模型选择；插件卸载/HMR
  重建时会恢复原实现并清标志。
- 粘贴改写时把落库的完整附件 ref 登记到进程内 registry，`view_image` 读取时
  优先用登记 ref，模型不必精确转抄标记中的每个字段（跨重启 replay 由标记字段兑底）。
- `view_image` 的 intent 参数描述会拼接 `intentGuidance` 软引导文案（默认引导模型
  完整描述；用户明确给出关注点时仍以用户为准）；主模型不传 intent 时用
  `defaultPrompt` 作为视觉模型的完整提示词。
- 附件预览路由 `/dsh-view-image/attachment/<sha256>`（`webServer` 前缀路由）：
  按内容寻址 id 提供附件字节（先查进程内 registry，再靠 URL 里的 ref 字段兑底，
  `attachments.readImage` 做完整性校验），供客户端内联图拉取。
- 客户端模块（`dsh.client`，web 平台）：纯展示层 DOM 增强——找到用户消息里的
  `[图片附件: sha256:...]` 标记（一条消息可含多个，一次粘贴多张图逐个渲染），
  把缩略图插到 `userRow`（下钻 `display:contents` 包装层），与视觉路由下
  ImageGallery 同位置：气泡上方、右对齐、240px singleFit、object-fit cover。
  交互：点击放大（lightbox）、悬停「复制」按钮（合成 document 级 drop 事件
  走 composer 原生 drop → addImages，直接把图片作为草稿图插回输入框；同时
  带超时/兜底地尽力写剪贴板，按钮反馈「已复制到剪贴板，已加入输入框」，
  Ctrl+V 仍可用；点击用 document 捕获阶段委托，React 重渲染不丢点击）、
  可拖拽到输入框（预取字节构造 File 走 composer 原生 drop 路径）。
  不接管任何工具行/卡片，模型上下文内容不变。

## 附件存储

粘贴改写会把图片字节落库为持久附件（`attachments.saveImage`，与 dsh 原生粘贴
同一套机制），内容寻址、同图去重、每次读取做 digest/尺寸完整性校验：

```
~/.dsh/attachments/v1/objects/<sha256前2位>/<sha256>   # 文件名 = 图片字节的 sha256
```

- **没有 GC**：删会话不会删附件，目录只增不减；想清空就 `rm -rf ~/.dsh/attachments`。
- 为什么落盘而不是内存：会话可恢复/重放（重启后靠标记字段重新读图）、复用宿主
  校验与限额。
- 改写流程的会话日志里只有文本标记、没有 image block 引用，所以宿主
  `session.attachment` RPC（要求会话日志引用）不适用，内联图改走插件自建的
  预览路由。

## 与 view-image（pi 扩展）的关系

本插件是 [@johnoooooo/view-image](https://github.com/johnoooooo/view-image)
在 dsh 插件体系下的移植：同样的「独立视觉模型 + 只回纯文本」思路，机制换成
cordis 插件（`ctx.tools.register(defineTool(...))`），配置从
`~/.pi/agent/vision-model.json` 换成 `~/.dsh/vision-model.json`。

## 许可

MIT