import JSZip from 'jszip'
import type { TocItem } from '@shared/types'

/**
 * 渲染层 EPUB 文档解析器。
 *
 * 与 epub.js 的区别：这里把整本书一次性解压成「干净的章节 HTML + blob 资源」，
 * 排版完全交给 native-engine，不加载原书 CSS（避免原书样式与阅读主题互相覆盖），
 * 也不执行任何脚本。所有资源 URL 在 destroy 时统一 revoke，避免内存泄漏。
 */
export interface ReaderChapter {
  index: number
  /** zip 内规范化路径，用于目录 href 匹配 */
  href: string
  title: string
  html: string
  text: string
  /** 按叶子块级元素抽出的段落，供对照翻译逐段对齐 */
  paragraphs: string[]
}

export interface ReaderDocument {
  title: string
  chapters: ReaderChapter[]
  toc: TocItem[]
  /** 释放所有 blob: URL */
  revoke(): void
}

const XLINK = 'http://www.w3.org/1999/xlink'
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', css: 'text/css'
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return MIME[ext] || 'application/octet-stream'
}

/** 规范化 zip 内路径：解码、去 ./、解析 ..、去前导斜杠 */
export function normalizePath(input: string): string {
  let path = input.trim().replace(/\\/g, '/')
  try {
    path = decodeURIComponent(path)
  } catch {
    /* 有些书本身就是未编码的中文路径，保持原样 */
  }
  path = path.split('#')[0].split('?')[0]
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** 以「章节文件所在目录」为基准解析相对路径，返回 [zipPath, anchor] */
function resolveRef(baseFile: string, ref: string): [string, string] {
  const raw = ref.trim()
  const hashAt = raw.indexOf('#')
  const anchor = hashAt >= 0 ? raw.slice(hashAt + 1) : ''
  const pathPart = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  if (/^(https?:|data:|mailto:|javascript:|blob:)/i.test(pathPart)) return ['', anchor]
  if (!pathPart) return [normalizePath(baseFile), anchor]
  const dir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : ''
  return [normalizePath(dir + pathPart), anchor]
}

function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  if (!path) return null
  const direct = zip.file(path)
  if (direct) return direct
  const want = path.toLowerCase()
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const exact = names.find((n) => n.toLowerCase() === want)
  if (exact) return zip.file(exact) ?? null
  const decoded = names.find((n) => {
    try {
      return decodeURIComponent(n).toLowerCase() === want
    } catch {
      return false
    }
  })
  return decoded ? zip.file(decoded) ?? null : null
}

function elements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName))
}

function first(root: Document | Element, localName: string): Element | null {
  return elements(root, localName)[0] || null
}

function parseXml(text: string): Document {
  const parser = new DOMParser()
  let doc = parser.parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) doc = parser.parseFromString(text, 'text/html')
  return doc
}

interface PackageInfo {
  baseDir: string
  spine: { id: string; href: string }[]
  navHref: string
  ncxHref: string
  title: string
}

function readPackage(opfText: string, opfPath: string): PackageInfo {
  const doc = parseXml(opfText)
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const items = new Map<string, { href: string; type: string; props: string }>()
  for (const item of elements(doc, 'item')) {
    const id = item.getAttribute('id') || ''
    const href = item.getAttribute('href') || ''
    if (!id || !href) continue
    items.set(id, {
      href: normalizePath(baseDir + href),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || ''
    })
  }
  const spine: { id: string; href: string }[] = []
  for (const ref of elements(doc, 'itemref')) {
    const id = itemId(ref)
    const item = items.get(id)
    if (item) spine.push({ id, href: item.href })
  }
  const nav = Array.from(items.values()).find((i) => /\bnav\b/.test(i.props))?.href || ''
  const ncxId = first(doc, 'spine')?.getAttribute('toc') || ''
  const ncx = items.get(ncxId)?.href || ''
  const title = first(doc, 'title')?.textContent?.trim() || ''
  return { baseDir, spine, navHref: nav, ncxHref: ncx, title }
}

function itemId(ref: Element): string {
  return ref.getAttribute('idref') || ref.getAttribute('id') || ''
}

async function readToc(
  zip: JSZip,
  pkg: PackageInfo,
  hrefOf: (path: string) => number
): Promise<TocItem[]> {
  const navPath = pkg.navHref || (findEntry(zip, normalizePath(pkg.baseDir + 'nav.xhtml')) ? normalizePath(pkg.baseDir + 'nav.xhtml') : '')
  const ncxPath = pkg.ncxHref || (findEntry(zip, normalizePath(pkg.baseDir + 'toc.ncx')) ? normalizePath(pkg.baseDir + 'toc.ncx') : '')

  if (navPath) {
    const entry = findEntry(zip, navPath)
    if (entry) {
      const doc = parseXml(await entry.async('string'))
      const navs = elements(doc, 'nav')
      const tocNav =
        navs.find((n) => /\btoc\b/i.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) ||
        navs.find((n) => n.querySelector('ol, ul')) ||
        navs[0]
      if (tocNav) {
        const out: TocItem[] = []
        let seq = 0
        const baseFile = navPath
        const walk = (list: Element, level: number, bucket: TocItem[]): void => {
          for (const li of Array.from(list.children).filter((c) => c.localName.toLowerCase() === 'li')) {
            const anchor = li.querySelector(':scope > a, :scope > span')
            const nested = Array.from(li.children).find((c) => ['ol', 'ul'].includes(c.localName.toLowerCase()))
            const label = (anchor?.textContent || '').trim().replace(/\s+/g, ' ') || '未命名章节'
            const rawHref = anchor?.getAttribute('href') || ''
            const [path, anchorId] = resolveRef(baseFile, rawHref)
            const chapterIndex = hrefOf(path)
            const item: TocItem = {
              id: `toc-${seq++}`,
              label,
              href: path ? `${path}${anchorId ? `#${anchorId}` : ''}` : '',
              level,
              children: []
            }
            // 目录项即使找不到对应 spine 也保留，点击时引擎会按 href 兜底查找
            void chapterIndex
            bucket.push(item)
            if (nested) walk(nested, level + 1, item.children)
          }
        }
        walk(tocNav.querySelector('ol, ul') || tocNav, 0, out)
        if (out.length) return out
      }
    }
  }

  if (ncxPath) {
    const entry = findEntry(zip, ncxPath)
    if (entry) {
      const doc = parseXml(await entry.async('string'))
      const navMap = first(doc, 'navMap')
      if (navMap) {
        let seq = 0
        const convert = (points: Element[], level: number): TocItem[] =>
          points
            .filter((p) => p.localName.toLowerCase() === 'navpoint')
            .map((p) => {
              const label = first(p, 'text')?.textContent?.trim() || '未命名章节'
              const content = elements(p, 'content')[0]
              const [path, anchorId] = resolveRef(ncxPath, content?.getAttribute('src') || '')
              return {
                id: `ncx-${seq++}`,
                label,
                href: path ? `${path}${anchorId ? `#${anchorId}` : ''}` : '',
                level,
                children: convert(Array.from(p.children), level + 1)
              }
            })
        const out = convert(Array.from(navMap.children), 0)
        if (out.length) return out
      }
    }
  }
  return []
}

/**
 * 原书内联样式白名单。
 * 尺寸 / 定位 / 字号 / 行距 / 缩进 / white-space 等一律剔除——它们会撑破列宽、
 * 覆盖阅读主题，是「内容宽度超出可视区」的另一大来源。只保留不影响几何的语义属性。
 */
const SAFE_INLINE_STYLES = new Set([
  'text-align', 'text-decoration', 'text-decoration-line', 'text-transform',
  'font-weight', 'font-style', 'font-variant', 'vertical-align',
  'border-collapse', 'list-style-type', 'caption-side'
])

function sanitizeInlineStyle(style: string): string {
  const kept: string[] = []
  for (const part of style.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const prop = part.slice(0, at).trim().toLowerCase()
    const value = part.slice(at + 1).trim()
    if (!prop || !value || /expression\s*\(|javascript:/i.test(value)) continue
    if (SAFE_INLINE_STYLES.has(prop)) kept.push(`${prop}:${value}`)
    else if ((prop === 'background' || prop === 'background-image') && /url\s*\(/i.test(value)) {
      kept.push(`${prop}:${value}`)
    }
  }
  return kept.join(';')
}

/** 清掉脚本/事件/外链样式，把 zip 内资源重写成 blob: URL，内部链接转成 data-chapter */
async function buildChapterHtml(
  zip: JSZip,
  path: string,
  blobCache: Map<string, string>,
  chapterIndexOf: (path: string) => number
): Promise<{ html: string; text: string; title: string; paragraphs: string[] }> {
  const entry = findEntry(zip, path)
  if (!entry) return { html: '<p class="nr-empty">本章内容缺失</p>', text: '', title: '', paragraphs: [] }
  const raw = await entry.async('string')
  const doc = new DOMParser().parseFromString(raw, 'text/html')

  doc.querySelectorAll(
    'script,iframe,object,embed,form,input,button,select,textarea,video,audio,meta,base,link,style,noscript,template'
  ).forEach((el) => el.remove())

  const all = Array.from(doc.body.querySelectorAll('*'))
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') el.removeAttribute(attr.name)
    }
  }

  const resource = async (ref: string): Promise<string> => {
    const [target] = resolveRef(path, ref)
    if (!target) return ''
    if (blobCache.has(target)) return blobCache.get(target) || ''
    const file = findEntry(zip, target)
    if (!file) return ''
    try {
      const data = await file.async('uint8array')
      const url = URL.createObjectURL(new Blob([new Uint8Array(data)] as BlobPart[], { type: mimeOf(target) }))
      blobCache.set(target, url)
      return url
    } catch {
      return ''
    }
  }

  type Task = { el: Element; attr: string; value: string; kind: 'asset' | 'style' | 'link' }
  const tasks: Task[] = []
  for (const el of all) {
    const tag = el.localName.toLowerCase()
    if (['img', 'source', 'image'].includes(tag)) {
      const attr = tag === 'image' ? 'xlink:href' : 'src'
      const value = el.getAttribute(attr) || el.getAttributeNS(XLINK, 'href') || ''
      if (value) tasks.push({ el, attr, value, kind: 'asset' })
    }
    if (tag === 'a') {
      const value = el.getAttribute('href') || ''
      if (value) tasks.push({ el, attr: 'href', value, kind: 'link' })
    }
    const style = el.getAttribute('style')
    if (style) {
      const cleaned = sanitizeInlineStyle(style)
      if (cleaned) {
        if (cleaned !== style) el.setAttribute('style', cleaned)
        if (/url\s*\(/i.test(cleaned)) tasks.push({ el, attr: 'style', value: cleaned, kind: 'style' })
      } else el.removeAttribute('style')
    }
  }

  for (const task of tasks) {
    if (task.kind === 'asset') {
      const url = await resource(task.value)
      if (url) {
        if (task.attr === 'xlink:href') task.el.setAttributeNS(XLINK, 'xlink:href', url)
        else task.el.setAttribute(task.attr, url)
      } else task.el.removeAttribute(task.attr)
    } else if (task.kind === 'link') {
      const href = task.value.trim()
      if (/^(https?:|mailto:)/i.test(href)) {
        task.el.setAttribute('target', '_blank')
        task.el.setAttribute('rel', 'noopener noreferrer')
        task.el.classList.add('nr-external')
      } else {
        const [target, anchor] = resolveRef(path, href)
        const index = chapterIndexOf(target)
        if (index >= 0) {
          task.el.removeAttribute('href')
          task.el.setAttribute('data-chapter', String(index))
          if (anchor) task.el.setAttribute('data-anchor', anchor)
          task.el.classList.add('nr-internal')
        } else task.el.removeAttribute('href')
      }
    } else {
      const replaced = await replaceCssUrls(task.value, resource)
      task.el.setAttribute('style', replaced)
    }
  }

  const body = doc.body
  const title =
    body.querySelector('h1, h2, .title, .chapter-title')?.textContent?.trim().replace(/\s+/g, ' ') || ''
  const text = (body.textContent || '').replace(/\s+/g, ' ').trim()
  return { html: body.innerHTML, text, title: title.slice(0, 80), paragraphs: extractParagraphs(body) }
}

/**
 * 只取「叶子块级元素」作为段落：外层 div 包 p 时只保留 p，避免同一句被翻译两次。
 * 若整章都是裸文本节点（无块级元素），返回空数组，由 paragraphs.ts 退化为按句切分。
 */
const BLOCK_SELECTOR = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,section,article,pre,td,figcaption'

function extractParagraphs(body: HTMLElement): string[] {
  const out: string[] = []
  for (const el of Array.from(body.querySelectorAll(BLOCK_SELECTOR))) {
    if (el.querySelector(BLOCK_SELECTOR)) continue
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text.length >= 2) out.push(text)
  }
  return out
}

async function replaceCssUrls(style: string, resource: (ref: string) => Promise<string>): Promise<string> {
  const matches = Array.from(style.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi))
  let out = style
  for (const match of matches) {
    const url = await resource(match[1])
    out = out.split(match[0]).join(url ? `url("${url}")` : 'none')
  }
  return out
}

/** 把 EPUB 二进制展开成可排版文档；失败时抛出带上下文的错误 */
export async function loadReaderDocument(buffer: ArrayBuffer): Promise<ReaderDocument> {
  const zip = await JSZip.loadAsync(buffer)
  const container = findEntry(zip, 'META-INF/container.xml')
  if (!container) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')
  const containerDoc = parseXml(await container.async('string'))
  const rootfile = elements(containerDoc, 'rootfile')[0]
  const opfPath = normalizePath(rootfile?.getAttribute('full-path') || 'OEBPS/content.opf')
  const opfEntry = findEntry(zip, opfPath)
  if (!opfEntry) throw new Error(`EPUB 清单文件不存在：${opfPath}`)
  const pkg = readPackage(await opfEntry.async('string'), opfPath)

  if (!pkg.spine.length) throw new Error('EPUB 没有可阅读的章节（spine 为空）')

  const blobCache = new Map<string, string>()
  const pathIndex = new Map(pkg.spine.map((s, i) => [s.href, i]))
  const chapterIndexOf = (path: string): number => pathIndex.get(path) ?? -1

  const chapters: ReaderChapter[] = []
  for (let i = 0; i < pkg.spine.length; i += 1) {
    const spine = pkg.spine[i]
    const built = await buildChapterHtml(zip, spine.href, blobCache, chapterIndexOf)
    chapters.push({
      index: i,
      href: spine.href,
      html: built.html,
      text: built.text,
      title: built.title,
      paragraphs: built.paragraphs
    })
  }

  const toc = await readToc(zip, pkg, chapterIndexOf)
  for (const chapter of chapters) {
    if (chapter.title) continue
    const hit = findTocLabel(toc, chapter.href)
    chapter.title = hit || `第 ${chapter.index + 1} 节`
  }

  return {
    title: pkg.title,
    chapters,
    toc,
    revoke(): void {
      for (const url of blobCache.values()) URL.revokeObjectURL(url)
      blobCache.clear()
    }
  }
}

function findTocLabel(items: TocItem[], href: string): string {
  for (const item of items) {
    if (item.href.split('#')[0] === href) return item.label
    const child = findTocLabel(item.children, href)
    if (child) return child
  }
  return ''
}
