import type { NormalizedBook, NormalizedChapter, NormalizedTocItem } from './normalized'
import {
  emptyBook,
  flatToc,
  paragraphsToHtml,
  splitLongParagraph,
  titleFromFileName
} from './normalized'

/**
 * TXT 适配器：编码识别 + 中文网络小说常见章节切分 + 段落化。
 * 纯 Node 实现，零第三方依赖；GBK / GB18030 用 Node 内置 TextDecoder（WHATWG 编码表），
 * 不需要 iconv-lite 之类的额外包，也不引入原生模块。
 */
export type TxtEncoding = 'auto' | 'utf8' | 'gb18030' | 'utf16le'

export interface TxtParseOptions {
  fileName?: string
  encoding?: TxtEncoding
  /** 关掉后按固定字数切节，适合没有「第X章」的散文 / 文档 */
  detectChapters?: boolean
  /** 无章节标题时每节的最大字符数 */
  maxCharsPerChapter?: number
  title?: string
  author?: string
}

export interface TxtChapter {
  title: string
  paragraphs: string[]
}

const DEFAULT_MAX_CHARS = 12000

/** BOM + UTF-8 严格探测 + GB18030 回退；返回文本与最终使用的编码 */
export function decodeTxt(bytes: Uint8Array, encoding: TxtEncoding = 'auto'): { text: string; encoding: string; fallback: boolean } {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const has = (a: number, b: number, c: number): boolean =>
    buf.length >= 3 && buf[0] === a && buf[1] === b && buf[2] === c

  if (encoding === 'utf8') return { text: new TextDecoder('utf-8').decode(has(0xef, 0xbb, 0xbf) ? buf.subarray(3) : buf), encoding: 'utf-8', fallback: false }
  if (encoding === 'gb18030') return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030', fallback: false }
  if (encoding === 'utf16le') {
    return { text: new TextDecoder('utf-16le').decode(buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2) : buf), encoding: 'utf-16le', fallback: false }
  }

  if (has(0xef, 0xbb, 0xbf)) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8 (BOM)', fallback: false }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le (BOM)', fallback: false }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // WHATWG 不保证 utf-16be 标签可用，手动交换字节后按 LE 解码
    const swapped = new Uint8Array(buf.length - 2)
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return { text: new TextDecoder('utf-16le').decode(swapped), encoding: 'utf-16be (BOM)', fallback: false }
  }
  // 大段 NUL 基本可判定为无 BOM 的 UTF-16LE
  if (buf.length > 8 && buf[1] === 0 && buf[3] === 0 && buf[5] === 0) {
    return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le', fallback: true }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', fallback: false }
  } catch {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030', fallback: true }
  }
}

const NUM = '[零〇一二三四五六七八九十百千万两0-9０-９]+'
const CHAPTER_PATTERNS: RegExp[] = [
  new RegExp(`^第\\s*${NUM}\\s*[章回节卷部篇集](?:\\s|[：:、.．\\-—_])?[^\\n]{0,60}$`),
  // 「卷二」本身或「卷二：风起」是标题；但不能把「卷二正文。」这类普通句子也吞掉，
  // 因此带后缀时强制要求先出现空白 / 分隔符。
  new RegExp(`^卷\\s*${NUM}\\s*(?:(?:[：:、.．\\-—_]|\\s)[^\\n]{0,40})?$`),
  /^Chapter\s+\d+(?:[\s:：.\-—_][^\n]{0,60})?$/i,
  /^(?:序章|楔子|引子|前言|序言|自序|后记|尾声|终章|番外|外传|附录)(?:[\s：:.\-—_][^\n]{0,50})?$/,
  new RegExp(`^第\\s*${NUM}\\s*[章回节].{0,2}$`)
]

function isChapterTitle(rawLine: string): boolean {
  const line = rawLine
    .trim()
    .replace(/^[【\[\(（《<*=＝~\s]+/u, '')
    .replace(/[】\]\)）》>*=＝~\s]+$/u, '')
    .trim()
  if (!line || line.length > 64) return false
  return CHAPTER_PATTERNS.some((re) => re.test(line))
}

function cleanLine(line: string): string {
  return line.replace(/^[\u3000\u00a0\t ]+/, '').replace(/\s+$/, '')
}

/** 把纯文本切成「章 -> 段落」；找不到章节标题时按字数均分，避免单章过大拖慢分页 */
export function splitTxtChapters(text: string, options: TxtParseOptions = {}): TxtChapter[] {
  const maxChars = Math.max(2000, options.maxCharsPerChapter || DEFAULT_MAX_CHARS)
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const chapters: TxtChapter[] = []
  let current: TxtChapter | null = null
  let pending: string[] = []

  const flushParagraph = (): void => {
    const joined = pending.join(' ').replace(/\s+/g, ' ').trim()
    pending = []
    if (!joined) return
    // 关键：无标题章节必须立刻入列。否则「整本没有『第X章』标题」的散文 / 笔记 / 英文书
    // 全部段落只挂在游离的 current 上，chapters 恒为空，parseTxt 会误报「内容为空」。
    if (!current) {
      current = { title: '', paragraphs: [] }
      chapters.push(current)
    }
    for (const part of splitLongParagraph(joined)) current.paragraphs.push(part)
  }
  const startChapter = (title: string): void => {
    flushParagraph()
    // 第一个章节标题之前的文字（书名 / 作者 / 简介 / 题记）已在 flushParagraph 里入列，
    // 这里只补一个名字，不能丢也不能重复 push。
    if (current && !current.title) current.title = '开篇'
    current = { title: title.trim(), paragraphs: [] }
    chapters.push(current)
  }

  for (const raw of lines) {
    const line = cleanLine(raw)
    if (!line) {
      flushParagraph()
      continue
    }
    if (options.detectChapters !== false && isChapterTitle(line)) {
      startChapter(line)
      continue
    }
    pending.push(line)
  }
  flushParagraph()

  const usable = chapters.filter((c) => c.paragraphs.length)
  // 极端情况：整篇都被判成标题（纯目录清单 / 正则误判），一个正文段落都没留下。
  // 不能让 parseTxt 抛「内容为空」把整本书丢掉，降级成单章「正文」原样保留这些行。
  if (chapters.length && !usable.length) {
    const paragraphs = chapters.flatMap((c) => splitLongParagraph(c.title)).filter(Boolean)
    return paragraphs.length ? [{ title: '正文', paragraphs }] : []
  }
  // 首个章节若为空且后面还有正文，丢掉这个空壳
  if (chapters.length && !chapters[0].paragraphs.length && usable.length) {
    chapters.shift()
  }

  const detected = options.detectChapters !== false && chapters.length >= 2
  if (detected) {
    return usable.map((c, i) => ({ title: c.title || `第 ${i + 1} 节`, paragraphs: c.paragraphs }))
  }

  // 未识别到章节：汇总全部段落按字数分节
  const all = chapters.flatMap((c) => c.paragraphs)
  if (!all.length) return []
  const grouped: TxtChapter[] = []
  let bucket: string[] = []
  let size = 0
  for (const paragraph of all) {
    if (bucket.length && size + paragraph.length > maxChars) {
      grouped.push({ title: `第 ${grouped.length + 1} 节`, paragraphs: bucket })
      bucket = []
      size = 0
    }
    bucket.push(paragraph)
    size += paragraph.length
  }
  if (bucket.length) grouped.push({ title: `第 ${grouped.length + 1} 节`, paragraphs: bucket })
  return grouped
}

/** 从前若干行抓「书名：/作者：」这类显式元数据，不改动正文 */
function readHeaderMeta(lines: string[]): { title?: string; author?: string } {
  let title: string | undefined
  let author: string | undefined
  for (const raw of lines.slice(0, 30)) {
    const line = cleanLine(raw)
    if (!line || line.length > 120) continue
    const t = line.match(/^(?:书名|标题|题名)\s*[:：]\s*(.+)$/)
    if (t && !title) title = t[1].trim()
    const a = line.match(/^(?:作者|著者|笔者)\s*[:：]\s*(.+)$/)
    if (a && !author) author = a[1].trim()
  }
  return { title, author }
}

export function parseTxt(bytes: Uint8Array, options: TxtParseOptions = {}): NormalizedBook {
  const decoded = decodeTxt(bytes, options.encoding || 'auto')
  const text = decoded.text.replace(/^\uFEFF/, '')
  const chapters = splitTxtChapters(text, options)
  if (!chapters.length) {
    throw new Error(
      bytes.length === 0
        ? '文件是空文件（0 字节）'
        : '文件里没有可读取的正文（可能是二进制文件，或编码不被支持；可在转换时手动指定 GB18030 / UTF-16 LE 再试）'
    )
  }
  const fromName = titleFromFileName(options.fileName || '未命名.txt')
  const header = readHeaderMeta(text.split('\n'))
  const book = emptyBook(options.title || header.title || fromName.title)
  book.authors = options.author ? [options.author] : header.author ? [header.author] : fromName.author ? [fromName.author] : []
  book.language = 'zh-CN'
  book.chapters = chapters.map((chapter): NormalizedChapter => ({
    title: chapter.title,
    html: paragraphsToHtml(chapter.paragraphs)
  }))
  book.toc = flatToc(book.chapters)
  if (decoded.fallback) {
    book.warnings.push(`编码按 ${decoded.encoding} 解析（未检测到 BOM，UTF-8 解码失败）；若出现乱码可在工具里手动指定编码`)
  }
  return book
}

/**
 * 把多个 TXT 合成一本：每个文件是一「卷」（一级目录），文件内的章节作为二级目录。
 * 供「多 TXT 转 EPUB」的合并模式复用，与单文件导入走同一套切分逻辑。
 */
export function mergeTxtBooks(
  parts: { fileName: string; book: NormalizedBook }[],
  title: string,
  author?: string
): NormalizedBook {
  const merged = emptyBook(title)
  merged.authors = author ? [author] : []
  merged.language = 'zh-CN'
  for (const part of parts) {
    const start = merged.chapters.length
    const volumeTitle = titleFromFileName(part.fileName).title
    const children: NormalizedTocItem[] = []
    part.book.chapters.forEach((chapter, i) => {
      merged.chapters.push(chapter)
      children.push({
        label: chapter.title || `第 ${i + 1} 节`,
        chapterIndex: start + i,
        level: 1,
        children: []
      })
    })
    merged.toc.push({
      label: volumeTitle,
      chapterIndex: Math.min(start, Math.max(0, merged.chapters.length - 1)),
      level: 0,
      children
    })
    merged.warnings.push(...part.book.warnings)
  }
  return merged
}
