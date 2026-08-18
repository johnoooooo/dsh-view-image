# dsh-view-image

让 dsh 用**独立的 OpenAI 兼容视觉模型**读图，返回**纯文本描述**——主模型不需要支持视觉模态，纯文本模型也能粘贴图片、识别图片（图片字节不进主对话历史）。

## 安装

```bash
dsh plugin --profile web add file:/path/to/dsh-view-image
```

> `file:` 安装是**拷贝**而非软链：改完插件代码后需先移除再重装（已存在的依赖 `add` 不会刷新拷贝），然后重启 dsh：
>
> ```bash
> dsh plugin --profile web remove dsh-view-image
> dsh plugin --profile web add file:/path/to/dsh-view-image
> ```

也可以不装 bundle，把 `cordis.patch.yml` 里的 insert 行复制进 profile 的 `cordis.patch.yml`（包需先安装）。

## 配置视觉模型

复制示例并编辑 `$DSH_HOME/vision-model.json`（默认 `~/.dsh/vision-model.json`）：

```bash
cp vision-model.example.json ~/.dsh/vision-model.json
```

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
| `api` | 协议：`openai-completions`（默认，@ai-sdk/openai-compatible 兼容）或 `anthropic-messages` |
| `maxTokens` | 最大输出 token（默认 2048；密集 OCR 可提到 4096-8192） |

配置缺失时插件正常加载但不注册 `view_image`（只打一条日志），补齐后重启或 `/reload` 生效。

## 可选插件配置

插件 bundle 自带默认配置（见仓库 `cordis.patch.yml`），开箱即用，一般无需修改。

## 使用

### Web 界面（粘贴图片）

1. 输入框直接粘贴图片（Ctrl+V）。
2. 纯文本路由下（如 deepseek-v4-flash）：插件把图片落库为持久附件，替换成文本标记 `[图片附件: ...]` 发给模型——不再弹「当前模型不支持图片」。
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
