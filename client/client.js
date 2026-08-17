/**
 * dsh-view-image 客户端模块：在聊天流里还原粘贴图片的显示与交互。
 *
 * 视觉路由下 dsh 把粘贴图存成附件，在用户消息里渲染 ImageGallery（右对齐、
 * 240px singleFit 缩略图、点击放大）；本插件走「改写为文本标记」的路由，
 * 日志里没有 image block，所以这里用 DOM 增强补齐展示层，尽量对齐原生行为：
 *   - 位置：下钻 display:contents 包装层，插入到 userRow 顶部（右对齐列）；
 *   - 尺寸：按标记里的宽高计算原生 singleFit 尺寸，object-fit cover；
 *   - 点击放大（轻量 lightbox）；悬停显示「复制」按钮（写剪贴板）；
 *   - 可拖拽到输入框（预取字节构造 File 放入 dataTransfer，走 composer 原生 drop 路径）。
 * 纯展示层——模型上下文内容不变。
 *
 * 注意：图片插入在 React 管辖的子树内，气泡重渲染会清掉它；MutationObserver
 * 每次 DOM 变化后重新扫描补齐（幂等，收敛快）。
 */
window.__ModuleLoader__.load({ id: "dsh-view-image", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const name = 'dsh-view-image/client'

/** 标记格式：由宿主 rewriteImageParts 生成。 */
const MARKER_RE = /\[图片附件:\s*(sha256:[0-9a-f]{64})\]/
/** 元数据片段：（image/png, 640x360, 13377 bytes） */
const META_RE = /（(image\/[\w+-]+),\s*(\d+)x(\d+),\s*(\d+) bytes）/

/** id → File（预取字节，供拖拽/复制使用；内容寻址，永不过期）。 */
const byteCache = new Map()

function imageUrlFor(id) {
  return '/dsh-view-image/attachment/' + encodeURIComponent(id)
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
  return pending
}

/** 原生 MessageImage 的 singleFit：240px 基准，宽高比夹在 0.25–4。 */
function singleFit(width, height) {
  const ratio = Math.min(4, Math.max(0.25, width / height))
  return ratio >= 1
    ? { width: 240, height: Math.round(240 / ratio) }
    : { width: Math.round(240 * ratio), height: 240 }
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
  const match = MARKER_RE.exec(text)
  if (match === null) return
  const id = match[1]
  const meta = META_RE.exec(text)
  const mediaType = meta?.[1] ?? 'image/png'
  const width = meta === null ? NaN : Number(meta[2])
  const height = meta === null ? NaN : Number(meta[3])

  // React 结构：flowItem > slot 包装(display:contents) > userRow(右对齐列) > userStack > [图片, 气泡]。
  // 下钻 contents 包装层，插到 userRow 顶部 = 原生图片位置（气泡上方、右对齐）。
  let row = item.firstElementChild
  while (row !== null && row.children.length === 1 && getComputedStyle(row).display === 'contents') {
    row = row.firstElementChild
  }
  if (row === null || row.querySelector('[data-view-image]') !== null) return

  const holder = document.createElement('div')
  holder.dataset.viewImage = '1'
  holder.style.cssText = 'position:relative;display:inline-block;max-width:100%;'
  const img = document.createElement('img')
  img.src = imageUrlFor(id)
  img.alt = '粘贴的图片'
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
      event.dataTransfer.setData('text/plain', '[图片附件: ' + id + ']')
    } else {
      // 字节尚未预取完成：退而传 URL（composer 不收，但至少不是空拖拽）。
      event.dataTransfer.setData('text/uri-list', imageUrlFor(id))
    }
  })
  // 预取字节并把解析好的 File 写回缓存，供拖拽/复制同步使用。
  void bytesFor(id, mediaType).then((file) => byteCache.set(id, file)).catch(() => {})

  // 悬停可见的复制按钮：确定性写剪贴板（复制后可直接 Ctrl+V 到输入框）。
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制'
  copy.style.cssText = 'position:absolute;top:6px;right:6px;z-index:1;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:6px;padding:2px 8px;font-size:11px;line-height:18px;cursor:pointer;opacity:0;transition:opacity .12s;'
  holder.addEventListener('mouseenter', () => { copy.style.opacity = '1' })
  holder.addEventListener('mouseleave', () => { copy.style.opacity = '0' })
  copy.addEventListener('click', (event) => {
    event.stopPropagation()
    void bytesFor(id, mediaType)
      .then((file) => navigator.clipboard.write([new ClipboardItem({ [mediaType]: file })]))
      .then(() => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制' }, 1200) })
      .catch(() => { copy.textContent = '复制失败'; setTimeout(() => { copy.textContent = '复制' }, 1200) })
  })

  holder.appendChild(img)
  holder.appendChild(copy)
  row.insertBefore(holder, row.firstChild)
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
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLightbox()
  })
  scheduleScan()
  ctx.on('dispose', () => observer.disconnect())
}

exports.name = name
exports.apply = apply

return module.exports; } });
