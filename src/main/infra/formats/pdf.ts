import type { NormalizedBook, NormalizedChapter, NormalizedTocItem } from './normalized'
import { emptyBook, flatToc, paragraphsToHtml, splitLongParagraph, titleFromFileName } from './normalized'

/**
 * PDF 适配器：pdfjs-dist@4 legacy 逐页抽取文本 -> 按大纲 / 固定页数分章 -> 标准 EPUB。
 *
 * 三个必须记住的环境约束（改这里前先读）：
 * 1. Electron 33 主进程是 **Node 20.18.3**，没有 Promise.withResolvers（Node 22 才有），
 *    pdfjs 4.x 会用到它 —— 加载前必须注入 polyfill。
 * 2. 主进程由 electron-vite 编成 **CJS**，而 pdfjs 是 ESM(.mjs)。TypeScript 会把
 *    `import()` 降级成 require()，因此必须用 `new Function` 保留原生动态 import。
 * 3. pdfjs 5/6 要求 Node >= 22.13，与 Electron 33 不兼容，锁在 4.10.38，不要随手升级。
 *
 * 只做文本层抽取：排版交给自研阅读引擎，因此版心 / 主题 / 翻页 / 进度 / 全文检索 /
 * 对照翻译与 EPUB 完全一致。扫描版（无文本层）无法凭空变出文字，会明确报错或给出警告。
 */
const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs'
/** 无 PDF 大纲时，每章合并的页数（避免上千页变成上千章导致切章过频繁） */
const PAGES_PER_CHAPTER = 10
/** 单本最多处理的页数，防止超大 PDF 长时间阻塞主进程 */
const MAX_PAGES = 3000

interface PdfTextItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}
interface PdfPage {
  getTextContent(options?: Record<string, unknown>): Promise<{ items: PdfTextItem[] }>
  getViewport(options: { scale: number }): { width: number; height: number }
  cleanup?(): void
}
interface PdfOutline {
  title?: string
  dest?: unknown
  items?: PdfOutline[]
  bold?: boolean
  italic?: boolean
  color?: unknown
}
interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<PdfPage>
  getOutline(): Promise<PdfOutline[] | null>
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: unknown): Promise<number>
  getMetadata(): Promise<{ info?: Record<string, unknown> }>
  destroy(): Promise<void>
}
interface PdfjsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> }
}

type WithResolvers = <T>() => {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

/** Node 20 的 Promise.withResolvers polyfill（幂等，不影响 Node 22） */
function ensurePromiseWithResolvers(): void {
  const ctor = Promise as unknown as { withResolvers?: WithResolvers }
  if (typeof ctor.withResolvers === 'function') return
  ctor.withResolvers = (<T>(): { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (r?: unknown) => void } => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }) as WithResolvers
}

let pdfjsPromise: Promise<PdfjsModule> | null = null
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    ensurePromiseWithResolvers()
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const nativeImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<PdfjsModule>
    pdfjsPromise = nativeImport(PDFJS_SPECIFIER).catch((error: unknown) => {
      pdfjsPromise = null
      throw new Error(`PDF 解析组件加载失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return pdfjsPromise
}

/** 按文本块的 y 坐标聚行、x 坐标拼接，处理双栏 / 上下标错位 */
function itemsToLines(items: PdfTextItem[]): string[] {
  const blocks = items
    .filter((item) => typeof item.str === 'string' && item.str.length)
    .map((item) => ({
      str: item.str as string,
      x: Array.isArray(item.transform) ? item.transform[4] || 0 : 0,
      y: Array.isArray(item.transform) ? item.transform[5] || 0 : 0,
      h: Math.abs(item.height || 10)
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)

  const rows: { y: number; h: number; parts: typeof blocks }[] = []
  for (const block of blocks) {
    const last = rows[rows.length - 1]
    const tolerance = Math.max(2, (last?.h || block.h) * 0.5)
    if (last && Math.abs(last.y - block.y) <= tolerance) last.parts.push(block)
    else rows.push({ y: block.y, h: block.h, parts: [block] })
  }
  return rows
    .map((row) =>
      row.parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
}

const SENTENCE_END = /[。！？!?；;：:”’"』】）)\]]$/
const NEW_PARA_START = /^[\u3000\u00a0 ]{2,}/

/** 把 PDF 的「排版换行」重组成自然段；段落过长再按句切开 */
function linesToParagraphs(lines: string[]): string[] {
  const out: string[] = []
  let buffer = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!buffer) {
      buffer = trimmed
      continue
    }
    const shouldBreak =
      (SENTENCE_END.test(buffer) && !/^[a-zA-Z0-9]/.test(trimmed)) ||
      NEW_PARA_START.test(line) ||
      buffer.length > 800
    if (shouldBreak) {
      out.push(buffer)
      buffer = trimmed.replace(/^[\u3000\u00a0 ]+/, '')
    } else {
      // 中英文之间不补空格，英文单词之间保留一个空格
      const glue = /[a-zA-Z0-9,]\s*$/.test(buffer) && /^[a-zA-Z0-9(]/.test(trimmed) ? ' ' : ''
      buffer += glue + trimmed
    }
  }
  if (buffer) out.push(buffer)
  return out.flatMap((p) => splitLongParagraph(p))
}

async function pageIndexOf(doc: PdfDocument, node: PdfOutline): Promise<number | null> {
  if (!node.dest) return null
  try {
    const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : (node.dest as unknown[] | null)
    const ref = Array.isArray(dest) ? dest[0] : null
    if (!ref) return null
    const index = await doc.getPageIndex(ref)
    return Number.isInteger(index) && index >= 0 ? index : null
  } catch {
    return null
  }
}

interface OutlineEntry {
  label: string
  page: number
  level: number
}

async function collectOutline(doc: PdfDocument): Promise<OutlineEntry[]> {
  let tree: PdfOutline[] | null = null
  try {
    tree = await doc.getOutline()
  } catch {
    return []
  }
  const out: OutlineEntry[] = []
  const walk = async (nodes: PdfOutline[], level: number): Promise<void> => {
    for (const node of nodes || []) {
      const page = await pageIndexOf(doc, node)
      if (page !== null) {
        out.push({ label: String(node.title || '未命名章节').trim(), page, level })
      }
      if (node.items?.length) await walk(node.items, level + 1)
    }
  }
  await walk(tree || [], 0)
  return out.sort((a, b) => a.page - b.page || a.level - b.level)
}

/** PDF 日期 D:YYYYMMDDHHmmSSZ -> YYYY-MM-DD */
function pdfDate(raw: unknown): string | undefined {
  const m = /D?:?\s*(\d{4})(\d{2})(\d{2})/.exec(String(raw ?? ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

export interface PdfParseOptions {
  fileName?: string
  title?: string
  author?: string
  /** 覆盖每章页数（无大纲时生效） */
  pagesPerChapter?: number
}

export async function parsePdf(bytes: Uint8Array, options: PdfParseOptions = {}): Promise<NormalizedBook> {
  const pdfjs = await loadPdfjs()
  let doc: PdfDocument
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      disableFontFace: true,
      verbosityLevel: 0,
      // 不渲染页面，避免 pdfjs 去 require canvas / DOMMatrix
      isEvalSupported: false
    }).promise
  } catch (error) {
    throw new Error(`PDF 打开失败（文件可能损坏或已加密）：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const total = Math.min(doc.numPages || 0, MAX_PAGES)
    if (!total) throw new Error('PDF 没有任何页面')
    const fromName = titleFromFileName(options.fileName || '未命名.pdf')

    let meta: Record<string, unknown> = {}
    try {
      meta = (await doc.getMetadata()).info || {}
    } catch {
      /* 元数据损坏不影响正文 */
    }

    const outline = await collectOutline(doc)
    const topLevels = outline.filter((o) => o.level === 0)
    const step = Math.max(1, options.pagesPerChapter || PAGES_PER_CHAPTER)

    // 章节边界：优先用一级大纲的起始页，否则按固定页数切
    const boundaries: { start: number; label: string; entries: OutlineEntry[] }[] = []
    if (topLevels.length >= 2) {
      const starts = [...new Set(topLevels.map((o) => Math.min(total - 1, o.page)))].sort((a, b) => a - b)
      if (starts[0] > 0) {
        boundaries.push({ start: 0, label: '前言', entries: [] })
      }
      starts.forEach((start, i) => {
        const label = topLevels.find((o) => Math.min(total - 1, o.page) === start)?.label || `第 ${i + 1} 节`
        boundaries.push({
          start,
          label,
          entries: outline.filter((o) => o.level > 0 && o.page >= start && (i + 1 >= starts.length || o.page < starts[i + 1]))
        })
      })
    } else {
      for (let start = 0; start < total; start += step) {
        const end = Math.min(total, start + step)
        boundaries.push({
          start,
          label: start + 1 === end ? `第 ${start + 1} 页` : `第 ${start + 1}–${end} 页`,
          entries: []
        })
      }
    }

    // 逐页抽文本，按边界聚合
    const pageParagraphs: string[][] = []
    let blankPages = 0
    for (let p = 1; p <= total; p += 1) {
      let lines: string[] = []
      try {
        const page = await doc.getPage(p)
        lines = itemsToLines((await page.getTextContent()).items || [])
        page.cleanup?.()
      } catch {
        /* 单页损坏跳过，不拖垮整本 */
      }
      const paragraphs = linesToParagraphs(lines)
      if (!paragraphs.length) blankPages += 1
      pageParagraphs.push(paragraphs)
    }
    if (blankPages === total) {
      throw new Error('该 PDF 没有可提取的文字层（扫描版 / 纯图片 PDF），当前版本暂不支持阅读')
    }

    const book = emptyBook(options.title || String(meta.Title || '').trim() || fromName.title)
    const author = options.author || String(meta.Author || '').trim() || fromName.author
    book.authors = author ? [author] : []
    book.language = String(meta.Language || '').trim() || 'zh-CN'
    book.publisher = String(meta.Producer || meta.Creator || '').trim() || undefined
    book.published = pdfDate(meta.CreationDate)
    book.description = String(meta.Subject || '').trim().slice(0, 4000) || undefined
    book.subjects = String(meta.Keywords || '')
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20)

    boundaries.forEach((boundary, i) => {
      const end = i + 1 < boundaries.length ? boundaries[i + 1].start : total
      const paragraphs: string[] = []
      for (let p = boundary.start; p < end; p += 1) paragraphs.push(...(pageParagraphs[p] || []))
      book.chapters.push({
        title: boundary.label,
        html: paragraphsToHtml(paragraphs.length ? paragraphs : ['（本章未提取到文字）'])
      } as NormalizedChapter)
    })

    if (topLevels.length >= 2) {
      book.toc = boundaries.map((boundary, index): NormalizedTocItem => ({
        label: boundary.label,
        chapterIndex: index,
        level: 0,
        children: boundary.entries.slice(0, 200).map((entry) => ({
          label: entry.label,
          chapterIndex: index,
          level: 1,
          children: []
        }))
      }))
    } else {
      book.toc = flatToc(book.chapters)
    }

    if (blankPages > 0) {
      book.warnings.push(`${blankPages} 页未提取到文字（可能是插图页或扫描页），已跳过`)
    }
    if ((doc.numPages || 0) > MAX_PAGES) {
      book.warnings.push(`PDF 共 ${doc.numPages} 页，为避免阻塞只转换了前 ${MAX_PAGES} 页`)
    }
    if (!outline.length) {
      book.warnings.push(`PDF 未包含书签大纲，已按每 ${step} 页生成目录`)
    }
    return book
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}
