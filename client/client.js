/**
 * dsh-view-image 客户端模块：在聊天流里还原粘贴图片的显示与交互。
 *
 * 视觉路由下 dsh 把粘贴图存成附件，在用户消息里渲染 ImageGallery（右对齐、
 * 240px singleFit 缩略图、点击放大）；本插件走「改写为文本标记」的路由，
 * 日志里没有 image block，所以这里用 DOM 增强补齐展示层，尽量对齐原生行为：
 *   - 位置：下钻 display:contents 包装层，插入到 userRow 顶部（右对齐列）；
 *   - 尺寸：按标记里的宽高计算原生 singleFit 尺寸，object-fit cover；
 *   - 点击放大（轻量 lightbox）；悬停显示「复制」按钮；
 *   - 可拖拽到输入框（预取字节构造 File 放入 dataTransfer，走 composer 原生 drop 路径）。
 *
 * 「复制」不依赖剪贴板：直接合成 document 级 drop 事件交给 composer 的
 * 原生 drop 处理器（dsh-client-ui-conversation 在 document 上监听 drop →
 * intakeImages → addImages），点击后图片直接作为草稿图进入输入框。同时
 * 尽力写剪贴板（带超时 + execCommand 兜底），Ctrl+V 仍可用；按钮反馈会
 * 显示「已复制到剪贴板」（以及是否已加入输入框）。点击用 document 捕获
 * 阶段委托处理，React 重渲染清掉按钮节点也不会丢点击（见 BUGS.md）。
 * 预览 URL 会带上标记里的元数据查询参数，dsh 重启后（进程内 registry 丢失）
 * 服务端才能凭参数兑底从附件库读图，旧会话缩略图才不会 404。
 * 纯展示层——模型上下文内容不变。
 *
 * 注意：图片插入在 React 管辖的子树内，气泡重渲染会清掉它；MutationObserver
 * 每次 DOM 变化后重新扫描补齐（幂等，收敛快）。
 */
window.__ModuleLoader__.load({ id: "dsh-view-image", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const name = 'dsh-view-image/client'

/** 标记格式：由宿主 rewriteImageParts 生成（兼容旧格式 [图片附件: ...]）。一条消息里可能有多个。 */
const MARKER_RE = /\[(?:图片附件|Image Attachment):\s*(sha256:[0-9a-f]{64})\]/g
/** 元数据片段：（image/png, 640x360, 13377 bytes），兼容全角/半角括号。 */
const META_RE = /[（(](image\/[\w+-]+),\s*(\d+)x(\d+),\s*(\d+) bytes[）)]/

/** id → File（预取字节，供拖拽/复制使用；内容寻址，永不过期）。 */
const byteCache = new Map()
/** id → { mediaType, width, height, bytes }（从标记解析，供预览 URL 跨重启兑底）。 */
const metaCache = new Map()

/**
 * 预览 URL：带上标记里的元数据查询参数。服务端进程内 registry 只在本进程
 * 存活，重启后为空；此时服务端靠 URL 里的 mediaType/width/height/bytes
 * 重建附件 ref 再读附件库（缺一个就 404）。不带参数时重启后旧会话缩略图
 * 必然 404，所以这里必须拼上。
 */
function imageUrlFor(id) {
  let url = '/dsh-view-image/attachment/' + encodeURIComponent(id)
  const meta = metaCache.get(id)
  if (meta !== undefined) {
    const params = new URLSearchParams()
    if (typeof meta.mediaType === 'string' && meta.mediaType.length > 0) params.set('mediaType', meta.mediaType)
    if (Number.isFinite(meta.width)) params.set('width', String(meta.width))
    if (Number.isFinite(meta.height)) params.set('height', String(meta.height))
    if (Number.isFinite(meta.bytes)) params.set('bytes', String(meta.bytes))
    const query = params.toString()
    if (query.length > 0) url += '?' + query
  }
  return url
}

function bytesFor(id, mediaType) {
  let pending = byteCache.get(id)
  if (pending === undefined) {
    pending = fetch(imageUrlFor(id))
      .then((res) => { if (!res.ok) throw new Error('load failed: ' + res.status); return res.blob() })
      .then((blob) => new File([blob], 'pasted-image.' + (mediaType.split('/')[1] ?? 'png'), { type: mediaType }))
      .catch((error) => { byteCache.delete(id); throw error })
    byteCache.set(id, pending)
  }
  // 预取完成后 decorate 会把缓存里的 Promise 替换成解析好的 File（供拖拽同步读），
  // 所以这里统一兜底：调用方拿到的永远是 Promise。
  return pending instanceof File ? Promise.resolve(pending) : pending
}

/** 原生 MessageImage 的 singleFit：240px 基准，宽高比夹在 0.25–4。 */
function singleFit(width, height) {
  const ratio = Math.min(4, Math.max(0.25, width / height))
  return ratio >= 1
    ? { width: 240, height: Math.round(240 / ratio) }
    : { width: Math.round(240 * ratio), height: 240 }
}

// ─ 加入输入框 / 复制：绕开剪贴板的可靠路径 + 尽力剪贴板 ────────────

const COPY_LABEL = 'Copy'
const CLIPBOARD_TIMEOUT_MS = 3000

/**
 * 把 File 直接交给 composer 的输入框：合成 document 级 drop 事件，走
 * dsh-client-ui-conversation 的原生 document drop 监听（→ intakeImages →
 * addImages）。不需要剪贴板权限、不需要输入框焦点，也绕开 paste 端的
 * machineBusy/locked 守卫（drop 端另有自己的 canAcceptDrop 守卫）。
 * 返回 composer 是否接收了事件（其处理器收到含文件的 drop 会 preventDefault）。
 */
function injectFileIntoComposer(file) {
  if (typeof DataTransfer === 'undefined' || typeof DragEvent === 'undefined') {
    console.warn('[view-image] DataTransfer/DragEvent unsupported, skipping direct injection')
    return false
  }
  try {
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event.defaultPrevented
  } catch (error) {
    console.warn('[view-image] synthetic drop injection failed:', error)
    return false
  }
}

/** 老式兜底：选中临时 img 后 execCommand('copy')（仅 clipboard API 不可用时）。 */
function legacyImageCopy(file) {
  return new Promise((resolve) => {
    const img = document.createElement('img')
    const url = URL.createObjectURL(file)
    const cleanup = () => {
      try {
        const selection = window.getSelection()
        if (selection !== null) selection.removeAllRanges()
      } catch { /* ignore */ }
      img.remove()
      URL.revokeObjectURL(url)
    }
    img.onload = () => {
      let ok = false
      try {
        const range = document.createRange()
        range.selectNode(img)
        const selection = window.getSelection()
        if (selection !== null) {
          selection.removeAllRanges()
          selection.addRange(range)
        }
        ok = document.execCommand('copy')
      } catch (error) {
        console.warn('[view-image] execCommand copy fallback failed:', error)
      }
      cleanup()
      resolve(ok)
    }
    img.onerror = () => {
      cleanup()
      resolve(false)
    }
    img.style.cssText = 'position:fixed;left:-9999px;top:0;'
    document.body.appendChild(img)
    img.src = url
  })
}

/**
 * 尽力写剪贴板：现代 ClipboardItem API 优先，与超时赛跑（悬挂的 promise
 * 也能给出确定结果）；API 不可用时退回 execCommand 兜底。
 */
function writeImageToClipboard(file) {
  if (navigator.clipboard !== undefined && typeof ClipboardItem === 'function') {
    let writePromise
    try {
      // ClipboardItem 构造可能同步抛错（非法 mediaType 等），包一层让它也走失败分支。
      writePromise = navigator.clipboard.write([new ClipboardItem({ [file.type]: file })])
    } catch (error) {
      console.warn('[view-image] ClipboardItem construction failed:', error)
      return Promise.resolve({ ok: false, reason: error?.name ?? 'clipboard-item' })
    }
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, reason: 'timeout' }), CLIPBOARD_TIMEOUT_MS)
    })
    return Promise.race([
      writePromise.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, reason: error === null || error === undefined ? 'rejected' : (error.name ?? String(error)) })
      ),
      timeout
    ])
  }
  return legacyImageCopy(file).then((ok) => ({ ok, reason: ok ? undefined : 'legacy-failed' }))
}

/** 按钮反馈：改文字 2 秒后还原（React 重建按钮节点时旧定时器作用在游离节点上，无害）。 */
function flashButton(button, text) {
  button.textContent = text
  setTimeout(() => {
    if (button.isConnected) button.textContent = COPY_LABEL
  }, 2000)
}

function handleCopyClick(button, id, mediaType) {
  console.log('[view-image] copy button clicked:', id, mediaType)
  bytesFor(id, mediaType)
    .then(async (file) => {
      // 主路径：直接把图片加入输入框（合成 drop，走 composer 原生入口）。
      const injected = injectFileIntoComposer(file)
      // 副路径：尽力写剪贴板，Ctrl+V 仍可用。
      const clip = await writeImageToClipboard(file)
      console.log('[view-image] copy result:', { injected, clip })
      if (clip.ok && injected) flashButton(button, 'Copied & added to input')
      else if (clip.ok) flashButton(button, 'Copied to clipboard')
      else if (injected) flashButton(button, 'Added to input')
      else flashButton(button, 'Copy failed')
    })
    .catch((error) => {
      console.warn('[view-image] copy button handler failed:', error)
      flashButton(button, 'Copy failed')
    })
}

// ─ 轻量 lightbox（点击缩略图放大，再点关闭）────────────

function openLightbox(img) {
  closeLightbox()
  const overlay = document.createElement('div')
  overlay.dataset.viewImageLightbox = '1'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;cursor:zoom-out;'
  const full = document.createElement('img')
  full.src = img.src
  full.alt = img.alt
  full.style.cssText = 'max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5);'
  overlay.appendChild(full)
  overlay.addEventListener('click', closeLightbox)
  document.body.appendChild(overlay)
}

function closeLightbox() {
  const overlay = document.querySelector('[data-view-image-lightbox]')
  if (overlay !== null) overlay.remove()
}

// ─ 装饰一条用户消息 ─────────────────────────────────

function decorate(item) {
  const text = item.textContent ?? ''
  if (!text.includes('[Image Attachment:') && !text.includes('[图片附件:')) return

  // React 结构：flowItem > slot 包装(display:contents) > userRow(右对齐列) > userStack > [图片, 气泡]。
  // 下钻 contents 包装层，插到 userRow 顶部 = 原生图片位置（气泡上方、右对齐）。
  let row = item.firstElementChild
  while (row !== null && row.children.length === 1 && getComputedStyle(row).display === 'contents') {
    row = row.firstElementChild
  }
  if (row === null) return

  // 一次粘贴多张图时消息里会有多个标记：逐个处理，每个标记一个 holder，
  // 幂等按 id 判断（React 重渲染后重新扫描不会重复插入）。
  const holders = []
  for (const match of text.matchAll(MARKER_RE)) {
    const id = match[1]
    if (row.querySelector('[data-view-image-id="' + id + '"]') !== null) continue
    const meta = META_RE.exec(text.slice(match.index))
    const mediaType = meta?.[1] ?? 'image/png'
    const width = meta === null ? NaN : Number(meta[2])
    const height = meta === null ? NaN : Number(meta[3])
    const bytes = meta === null ? NaN : Number(meta[4])
    // 登记元数据：预览 URL 靠它拼查询参数，dsh 重启后（进程内 registry 丢失）
    // 服务端才能凭参数重建附件 ref 从附件库读图，否则缩略图 404。
    metaCache.set(id, { mediaType, width, height, bytes })

    const holder = document.createElement('div')
    holder.dataset.viewImage = '1'
    holder.dataset.viewImageId = id
    holder.style.cssText = 'position:relative;display:inline-block;max-width:100%;'
    const img = document.createElement('img')
    img.src = imageUrlFor(id)
    img.alt = 'pasted image'
    img.loading = 'lazy'
    img.decoding = 'async'
    img.draggable = true
    const fit = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? singleFit(width, height)
      : { width: 240, height: 160 }
    img.style.cssText = 'display:block;width:' + fit.width + 'px;height:' + fit.height + 'px;object-fit:cover;border-radius:10px;cursor:zoom-in;'
    img.addEventListener('click', (event) => {
      event.preventDefault()
      openLightbox(img)
    })
    // 拖拽：把预取的字节构造成 File 放进 dataTransfer，composer 的原生 drop 处理器会收下。
    img.addEventListener('dragstart', (event) => {
      if (event.dataTransfer === null) return
      const cached = byteCache.get(id)
      if (cached instanceof File) {
        event.dataTransfer.items.add(cached)
        event.dataTransfer.setData('text/plain', '[Image Attachment: ' + id + ']')
      } else {
        // 字节尚未预取完成：退而传 URL（composer 不收，但至少不是空拖拽）。
        event.dataTransfer.setData('text/uri-list', imageUrlFor(id))
      }
    })
    // 预取字节并把解析好的 File 写回缓存，供拖拽/复制同步使用。
    void bytesFor(id, mediaType).then((file) => byteCache.set(id, file)).catch(() => {})

  // 悬停可见的「复制」按钮。点击处理不在按钮节点上——React 重渲染会
  // 清掉并重建 holder，节点上的监听器随时可能随旧节点一起被丢弃；改为
  // document 捕获阶段的委托（见 apply），按 data-view-image-copy 定位按钮。
  // 这里只挂纯视觉反馈（mousedown 高亮），丢了也不影响功能。
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = COPY_LABEL
  copy.title = 'Copy to clipboard and add to input'
  copy.dataset.viewImageCopy = id
  copy.dataset.viewImageMediaType = mediaType
  copy.style.cssText = 'position:absolute;top:6px;right:6px;z-index:1;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:11px;line-height:18px;cursor:pointer;opacity:0;transition:opacity .12s;'
  holder.addEventListener('mouseenter', () => { copy.style.opacity = '1' })
  holder.addEventListener('mouseleave', () => { copy.style.opacity = '0' })
  copy.addEventListener('mousedown', () => { copy.style.background = 'rgba(0,0,0,.8)' })
  copy.addEventListener('mouseup', () => { copy.style.background = 'rgba(0,0,0,.55)' })
  copy.addEventListener('mouseleave', () => { copy.style.background = 'rgba(0,0,0,.55)' })

  holder.appendChild(img)
    holder.appendChild(copy)
    holders.push(holder)
  }
  // 按标记出现顺序一次性插入（prepend 保持数组顺序）。
  if (holders.length > 0) row.prepend(...holders)
}

// ─ 扫描（初始 + DOM 变化后补齐被 React 清掉的图片）────

let scheduled = false

function scan() {
  scheduled = false
  const items = document.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]')
  for (const item of items) decorate(item)
}

function scheduleScan() {
  if (scheduled) return
  scheduled = true
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan)
  else setTimeout(scan, 0)
}

function apply(ctx) {
  if (typeof document === 'undefined') return
  const root = document.body ?? document.documentElement
  const observer = new MutationObserver(scheduleScan)
  observer.observe(root, { childList: true, subtree: true })
  // 「复制」按钮点击：document 捕获阶段委托。按钮节点被 React 重渲染
  // 清掉重建也不影响点击处理；捕获阶段 stopPropagation 让这次点击不落到
  // React/dsh 的其他处理器上（按钮完全由本插件自理）。
  const onDocumentClick = (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('[data-view-image-copy]')
    if (button === null || button.dataset.viewImageCopy === undefined) return
    event.stopPropagation()
    handleCopyClick(button, button.dataset.viewImageCopy, button.dataset.viewImageMediaType ?? 'image/png')
  }
  document.addEventListener('click', onDocumentClick, true)
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLightbox()
  })
  scheduleScan()
  ctx.on('dispose', () => {
    observer.disconnect()
    document.removeEventListener('click', onDocumentClick, true)
  })
}

exports.name = name
exports.apply = apply

return module.exports; } });
