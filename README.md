# dsh-view-image

让 dsh 用**独立的 OpenAI 兼容视觉模型**读图，返回**纯文本描述**——主模型不需要支持视觉模态，纯文本模型也能粘贴图片、识别图片（图片字节不进主对话历史）。

## 功能特性

- **纯文本模型也能读图**：主对话历史只保留「工具调用 + 纯文本结果」，图片字节不进模型上下文；`read_image` 会被拒绝的纯文本路由（如 deepseek-v4-flash）也能正常识别图片。
- **Web 粘贴图片即用**：输入框直接 Ctrl+V 粘贴，纯文本路由下自动落库为持久附件并改写为文本标记，不再弹「当前模型不支持图片」。
- **聊天流内联缩略图**：用户消息内联显示粘贴图（右对齐、240px、object-fit cover），一次粘贴多张全部显示；点击放大、悬停「复制」按钮一键加入输入框（同时写剪贴板）、可拖拽回输入框。
- **终端 / headless 读图**：主模型传文件路径即可读图（尊重 session cwd），适合脚本化场景。
- **界面语言跟随 dsh**：按钮/反馈文案随 dsh 界面语言实时切换中英文。
- **识别行为可配置**：默认提示词（`defaultPrompt`）、intent 后缀（`intentSuffix`）、主模型 intent 软引导（`intentGuidance`）均可在 profile 配置层覆盖。
- **附件持久化**：内容寻址（sha256）、同图去重、完整性校验，会话可恢复/重放；聊天缩略图跨重启也能兑底显示。
- **视觉模型可插拔**：OpenAI 兼容端点（Ollama / vLLM / LiteLLM / OpenRouter / 阿里云百炼 / opencode.ai 等），配置在 `vision-model.json`。

## 安装

克隆仓库并安装到目标 profile（把 `web` 换成你的 profile 名）：

```bash
git clone https://github.com/johnoooooo/dsh-view-image.git
cd dsh-view-image
dsh plugin --profile web add file:$PWD
```

安装完成后重启 dsh 生效。

## 卸载

```bash
dsh plugin --profile web remove dsh-view-image
```

## 配置视觉模型

复制示例并编辑 `$DSH_HOME/vision-model.json`（默认 `~/.dsh/vision-model.json`）：

```bash
cp vision-model.example.opencode.json ~/.dsh/vision-model.json
```

**阿里云百炼（通义千问 VL）**：

```json
{
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  "apiKey": "sk-your-aliyun-api-key",
  "model": "qwen3.7-plus",
  "api": "openai-completions",
  "maxTokens": 2048
}
```

**opencode.ai（MiMo-V2.5）**：

```json
{
  "baseUrl": "https://opencode.ai/zen/go/v1/chat/completions",
  "apiKey": "sk-your-api-key",
  "model": "mimo-v2.5",
  "api": "openai-completions",
  "maxTokens": 8092
}
```

| 字段 | 说明 |
|------|------|
| `baseUrl` | OpenAI 兼容端点（Ollama `/v1` / vLLM / LiteLLM / OpenRouter / opencode.ai 等；省略 `/chat/completions` 后缀时插件自动补） |
| `apiKey` | 端点 API Key（占位 `sk-your-api-key` 换成自己的） |
| `model` | 视觉模型名（如 `mimo-v2.5`） |
| `api` | 协议：`openai-completions`（默认，@ai-sdk/openai-compatible 兼容） |
| `maxTokens` | 最大输出 token（默认 2048；密集 OCR 可提到 4096-8192） |

配置缺失时插件正常加载但不注册 `view_image`（只打一条日志），补齐后重启或 `/reload` 生效。

## 可选插件配置

插件 bundle 自带默认配置（见仓库 `cordis.patch.yml`），开箱即用，一般无需修改。

## 使用

### Web 界面（粘贴图片）

1. 输入框直接粘贴图片（Ctrl+V）。
2. 纯文本路由下（如 deepseek-v4-flash）：插件把图片落库为持久附件，替换成文本标记 `[Image Attachment: ...]` 发给模型——不再弹「当前模型不支持图片」。
3. 模型看到标记自动调用 `view_image`，返回纯文本描述；聊天流里用户消息内联显示缩略图（一次多张全部显示），支持点击放大、悬停「复制」按钮一键加入输入框（同时尽力复制到剪贴板）、拖拽回输入框。

原理：插件包装宿主 `apiProxy.sessions.prompt`，仅在纯文本路由时改写图片；模型支持图片的路由完全走原生流程。

### 终端 / headless（图片路径）

模型会自动调用 `view_image` 读取图片：

```bash
dsh --profile headless "用 view_image 工具查看 /path/to/img.png 并描述内容"
```

## 工作原理

- `view_image` 支持两种来源：`file_path`（fs 解析，尊重 session cwd）或 `attachment_id`（持久附件）。
- 图片以 base64 data URL 发给独立视觉模型，结果只写纯文本——**图片字节不进主对话历史**。
- 粘贴改写：图片落库为持久附件（内容寻址、同图去重、完整性校验），替换成文本标记；模型看到标记后调用 `view_image`。
- 附件引用有进程内 registry + 标记字段双保险，跨重启也能兑底读取。
- 预览路由 `/dsh-view-image/attachment/<sha256>` 供缩略图拉取字节（URL 带元数据参数兑底）。
- 客户端是纯展示层 DOM 增强：扫描标记渲染缩略图（对抗 React 重渲染），不改变模型上下文。

## 附件存储

图片存放在 `~/.dsh/attachments/v1/objects/<sha256前2位>/<sha256>`。**没有 GC**：删除会话不会删附件，想清空就 `rm -rf ~/.dsh/attachments`。

## 许可

MIT
