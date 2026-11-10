import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { posix } from 'node:path'
import type { EpubMetadata, ParsedChapter, ParsedEpub, TocItem } from '@shared/types'

/**
 * EPUB 解析器（唯一的「文件格式适配层」）。
 *
 * 职责：container.xml -> OPF(metadata/manifest/spine) -> NAV/NCX 目录
 *      -> 按 spine 顺序抽取每章纯文本 + 封面二进制。
 * 不负责阅读渲染：渲染由渲染进程的 epub.js 完成，两边通过统一 href 对齐。
 *
 * 兼容性要点：
 * - 命名空间前缀可能是 dc:/opf:，也可能完全没有（默认命名空间）；
 * - zip 内文件名大小写、URL 编码、Windows 反斜杠都可能不规范；
 * - XHTML 未必是合法 XML，所以正文抽取用文本级处理而不是 XML 解析。
 */

export interface IEpubParser {
  parse(input: Uint8Array | ArrayBuffer | Buffer): Promise<ParsedEpub>
}

type AnyRecord = Record<string, unknown>
/** 只约束本解析器实际用到的两个方法，避免被 jszip 的重载签名绑死 */
type ZipEntry = {
  async(type: 'string'): Promise<string>
  async(type: 'uint8array'): Promise<Uint8Array>
}

const ARRAY_TAGS = new Set([
  'item', 'itemref', 'meta', 'rootfile', 'reference',
  'dc:title', 'title', 'dc:creator', 'creator', 'dc:subject', 'subject',
  'dc:identifier', 'identifier', 'dc:language', 'language', 'dc:date', 'date',
  'navPoint', 'a', 'li', 'p'
])

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
  isArray: (name: string) => ARRAY_TAGS.has(name)
})

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return toText(value[0])
  if (typeof value === 'object') return toText((value as AnyRecord)['#text'])
  return ''
}

function toList(value: unknown): string[] {
  return asArray(value)
    .map(toText)
    .map((s) => stripTags(decodeEntities(s)))
    .filter(Boolean)
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ' '
  }
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length
}

/** zip 内路径规范化（不含 #fragment） */
function zipPath(baseDir: string, href: string): string {
  const raw = String(href || '').split('#')[0].replace(/\\/g, '/')
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    /* 保留原样 */
  }
  if (!decoded) return ''
  return posix.normalize(posix.join(baseDir, decoded)).replace(/^\/+/, '')
}

function tocHref(baseDir: string, href: string): string {
  const [pathPart, hash] = String(href || '').split('#')
  const base = zipPath(baseDir, pathPart)
  return hash ? `${base}#${hash}` : base
}

function findEntry(zip: JSZip, name: string): ZipEntry | null {
  const get = (n: string): ZipEntry | null =>
    (zip.file(n) as unknown as ZipEntry | null) ?? null
  if (!name) return null
  const direct = get(name)
  if (direct) return direct
  const lower = name.toLowerCase()
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const exact = names.find((n) => n.toLowerCase() === lower)
  if (exact) return get(exact)
  const decoded = names.find((n) => {
    try {
      return decodeURIComponent(n).toLowerCase() === lower
    } catch {
      return false
    }
  })
  return decoded ? get(decoded) : null
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|td)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractDocTitle(html: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1) return stripTags(decodeEntities(h1[1])).slice(0, 120)
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  if (title) return stripTags(decodeEntities(title[1])).slice(0, 120)
  return ''
}

function findTocLabel(items: TocItem[], href: string): string {
  for (const item of items) {
    if (item.href.split('#')[0] === href) return item.label
    const child = findTocLabel(item.children, href)
    if (child) return child
  }
  return ''
}

function parseNav(html: string, baseDir: string): TocItem[] {
  const nav =
    html.match(/<nav\b[^>]*epub:type=["']?toc["']?[^>]*>([\s\S]*?)<\/nav>/i) ||
    html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)
  const body = nav ? nav[1] : html
  const anchors = Array.from(body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi))
  const roots: TocItem[] = []
  const stack: { item: TocItem; level: number }[] = []

  anchors.forEach((m, i) => {
    const hrefMatch = m[1].match(/href\s*=\s*["']([^"']+)["']/i)
    const label = stripTags(decodeEntities(m[2])).trim()
    if (!hrefMatch || !label) return
    const before = body.slice(0, m.index ?? 0)
    const level = Math.max(
      0,
      countMatches(before, /<ol\b/gi) - countMatches(before, /<\/ol>/gi) - 1
    )
    const item: TocItem = {
      id: `nav-${i}`,
      label,
      href: tocHref(baseDir, hrefMatch[1]),
      level,
      children: []
    }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length) stack[stack.length - 1].item.children.push(item)
    else roots.push(item)
    stack.push({ item, level })
  })
  return roots
}

function parseNcx(ncx: AnyRecord, baseDir: string): TocItem[] {
  const roots: TocItem[] = []
  let seq = 0
  const walk = (points: AnyRecord[], level: number, parent: TocItem[]): void => {
    for (const p of points) {
      const label = toText((p.navLabel as AnyRecord | undefined)?.text)
      const src = String(((p.content as AnyRecord | undefined)?.['@_src'] as string) || '')
      const item: TocItem = {
        id: `ncx-${seq++}`,
        label: label || '未命名章节',
        href: src ? tocHref(baseDir, src) : '',
        level,
        children: []
      }
      parent.push(item)
      const children = asArray(p.navPoint as AnyRecord | AnyRecord[] | undefined)
      if (children.length) walk(children, level + 1, item.children)
    }
  }
  // fast-xml-parser 返回的是 { ncx: {...} }，这里同时兼容已取过根节点的情况
  const root = ((ncx as AnyRecord).ncx || ncx) as AnyRecord
  const navMap = root.navMap as AnyRecord | undefined
  walk(asArray(navMap?.navPoint as AnyRecord | AnyRecord[] | undefined), 0, roots)
  return roots
}

function readMetadata(meta: AnyRecord): EpubMetadata {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) if (meta[key] !== undefined) return meta[key]
    return undefined
  }
  const identifiers = asArray(pick('dc:identifier', 'identifier'))
  let isbn: string | undefined
  for (const id of identifiers) {
    const raw = toText(id)
    const scheme = String(
      (id as AnyRecord)?.['@_opf:scheme'] ??
        (id as AnyRecord)?.['@_scheme'] ??
        ''
    )
    const cleaned = raw.replace(/[^0-9Xx]/g, '')
    if (/isbn/i.test(scheme) || /^(97[89]\d{10}|\d{9}[\dXx])$/.test(cleaned)) {
      isbn = cleaned
      break
    }
  }
  const description = toList(pick('dc:description', 'description'))[0]
  return {
    title: toList(pick('dc:title', 'title'))[0] || '未命名',
    authors: toList(pick('dc:creator', 'creator')),
    publisher: toList(pick('dc:publisher', 'publisher'))[0],
    published: toList(pick('dc:date', 'date'))[0]?.slice(0, 32),
    language: toList(pick('dc:language', 'language'))[0],
    isbn,
    description: description?.slice(0, 4000),
    subjects: toList(pick('dc:subject', 'subject')).slice(0, 20)
  }
}

export class ZipEpubParser implements IEpubParser {
  async parse(input: Uint8Array | ArrayBuffer | Buffer): Promise<ParsedEpub> {
    const zip = await JSZip.loadAsync(input)

    // 1. 定位 OPF
    let opfPath = ''
    const containerEntry = findEntry(zip, 'META-INF/container.xml')
    if (containerEntry) {
      const container = xmlParser.parse(await containerEntry.async('string')) as AnyRecord
      const rootfiles = (container.container as AnyRecord | undefined)?.rootfiles as AnyRecord | undefined
      opfPath = zipPath('', String(asArray(rootfiles?.rootfile as AnyRecord[])[0]?.['@_full-path'] || ''))
    }
    if (!findEntry(zip, opfPath)) {
      opfPath = Object.keys(zip.files).find((n) => /\.opf$/i.test(n) && !zip.files[n].dir) || ''
    }
    if (!opfPath || !findEntry(zip, opfPath)) {
      throw new Error('不是有效的 EPUB：找不到 OPF 内容清单')
    }
    const opfDir = posix.dirname(opfPath)
    const pkg = (xmlParser.parse(await findEntry(zip, opfPath)!.async('string')) as AnyRecord)
      .package as AnyRecord
    if (!pkg) throw new Error('OPF 缺少 package 节点')

    const metaRaw = (pkg.metadata as AnyRecord) || {}
    const meta = readMetadata(metaRaw)
    const items = asArray<AnyRecord>((pkg.manifest as AnyRecord | undefined)?.item as AnyRecord[])
    const refs = asArray<AnyRecord>((pkg.spine as AnyRecord | undefined)?.itemref as AnyRecord[])
    const byId = new Map<string, AnyRecord>()
    for (const item of items) byId.set(String(item['@_id'] ?? ''), item)

    // 2. 封面
    let coverHref = ''
    const coverItem = items.find((it) =>
      /\bcover-image\b/.test(String(it['@_properties'] ?? ''))
    )
    if (coverItem) {
      coverHref = zipPath(opfDir, String(coverItem['@_href'] ?? ''))
    } else {
      const coverMeta = asArray<AnyRecord>(metaRaw.meta as AnyRecord[]).find(
        (m) => String(m['@_name'] ?? '') === 'cover'
      )
      const coverId = String(coverMeta?.['@_content'] ?? '')
      const item = byId.get(coverId)
      if (item) coverHref = zipPath(opfDir, String(item['@_href'] ?? ''))
    }
    if (!coverHref) {
      const guess = items.find(
        (it) =>
          /^image\//.test(String(it['@_media-type'] ?? '')) &&
          /cover/i.test(String(it['@_href'] ?? ''))
      )
      if (guess) coverHref = zipPath(opfDir, String(guess['@_href'] ?? ''))
    }

    // 3. 目录：EPUB3 NAV 优先，回退 EPUB2 NCX
    let toc: TocItem[] = []
    const navItem = items.find((it) => /\bnav\b/.test(String(it['@_properties'] ?? '')))
    if (navItem) {
      const navPath = zipPath(opfDir, String(navItem['@_href'] ?? ''))
      const entry = findEntry(zip, navPath)
      if (entry) toc = parseNav(await entry.async('string'), posix.dirname(navPath))
    }
    if (toc.length === 0) {
      const tocId = String((pkg.spine as AnyRecord | undefined)?.['@_toc'] ?? '')
      const ncxItem = byId.get(tocId) || items.find((it) => /\.ncx$/i.test(String(it['@_href'] ?? '')))
      if (ncxItem) {
        const ncxPath = zipPath(opfDir, String(ncxItem['@_href'] ?? ''))
        const entry = findEntry(zip, ncxPath)
        if (entry) {
          toc = parseNcx(
            xmlParser.parse(await entry.async('string')) as AnyRecord,
            posix.dirname(ncxPath)
          )
        }
      }
    }

    // 4. 按 spine 抽取章节正文
    const chapters: ParsedChapter[] = []
    const spineHrefs: string[] = []
    for (const ref of refs) {
      const item = byId.get(String(ref['@_idref'] ?? ''))
      if (!item) continue
      const href = zipPath(opfDir, String(item['@_href'] ?? ''))
      if (!href || !/\.x?html?$/i.test(href)) continue
      spineHrefs.push(href)
      const entry = findEntry(zip, href)
      const html = entry ? await entry.async('string') : ''
      chapters.push({
        index: chapters.length,
        href,
        title:
          extractDocTitle(html) ||
          findTocLabel(toc, href) ||
          `第 ${chapters.length + 1} 节`,
        text: htmlToText(html)
      })
    }
    if (chapters.length === 0) throw new Error('EPUB 中未找到可阅读章节')

    // 5. 封面二进制
    let cover: ParsedEpub['cover']
    const coverEntry = findEntry(zip, coverHref)
    if (coverEntry) {
      const ext = (posix.extname(coverHref) || '.jpg').slice(0, 6)
      cover = { data: await coverEntry.async('uint8array'), ext }
    }

    return {
      meta: { ...meta, coverHref: coverHref || undefined },
      toc,
      chapters,
      spineHrefs,
      cover
    }
  }
}
