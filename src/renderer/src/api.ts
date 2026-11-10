import { CH, EV, type Api, type IpcArgs, type IpcChannel, type IpcResult } from '@shared/contract'
import { toPlain } from './ipc-plain'

const bridgeInvoke = window.api.invoke

/** 全应用只通过这两个入口访问主进程，禁止在组件里直接碰 window.api */
export const invoke = (<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> =>
  bridgeInvoke(channel, ...(args.map((arg) => toPlain(arg)) as IpcArgs<C>))) as Api['invoke']
export const on = window.api.on
export const getFilePath = window.api.getFilePath
export { CH, EV }

export function coverUrl(cover?: string): string {
  return cover ? `book://local/covers/${encodeURIComponent(cover)}` : ''
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] || c
  )
}

/** 无封面时的渐变占位图，用书名首字做视觉锚点 */
export function placeholderCover(title: string): string {
  const ch = escapeXml((title || '书').trim().slice(0, 1) || '书')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280" viewBox="0 0 200 280">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#dfe6f2"/><stop offset="1" stop-color="#c9d4e8"/>` +
    `</linearGradient></defs>` +
    `<rect width="200" height="280" rx="6" fill="url(#g)"/>` +
    `<rect x="12" y="12" width="3" height="256" fill="#ffffff" opacity=".55"/>` +
    `<text x="106" y="158" font-size="72" font-family="serif" fill="#5b6b8c" text-anchor="middle">${ch}</text>` +
    `<text x="106" y="196" font-size="14" font-family="sans-serif" fill="#7d8aa6" text-anchor="middle">EPUB</text>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export function formatSize(bytes: number): string {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatDate(ts?: number): string {
  if (!ts) return '未读'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] || c
  )
}

/** 生成带 <mark> 的安全 HTML（先转义再插标记，避免 EPUB 文本里的 HTML 注入） */
export function highlightHtml(text: string, terms: string[]): string {
  let out = escapeHtml(text)
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  )
  for (const term of unique) {
    if (!term) continue
    const escaped = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'gi'), (m) => `<mark>${m}</mark>`)
  }
  return out
}
