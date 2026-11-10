/**
 * 格式适配层的统一中间表示（2.0）。
 *
 * 设计要点：阅读器只认「标准 EPUB 字节」（reader:load -> JSZip -> 章节 XHTML），
 * 因此所有非 EPUB 格式都先解析成 NormalizedBook，再由 epub-writer 写成合规 EPUB 入库。
 * 这样排版引擎、目录、进度、全文检索、对照翻译**一行都不用改**，阅读体验天然一致；
 * 已入库的 EPUB 与原有导入流程也完全不受影响。
 */

import { formatOf as detectFormat } from '@shared/formats'

// 扩展名清单与 formatOf 的唯一真相放在 shared/formats.ts（命令行 / 拖拽 / 对话框共用）。
// 这里原样转出，保持既有 `from '../infra/formats'` 的引用路径完全不变。
export {
  IMPORT_EXTENSIONS,
  CONVERTIBLE_FORMATS,
  formatOf,
  isBookPath,
  BOOK_DIALOG_EXTENSIONS,
  FORMAT_HINT
} from '@shared/formats'
export type { ImportFormat } from '@shared/formats'

export interface NormalizedTocItem {
  label: string
  /** 指向 NormalizedBook.chapters 的下标 */
  chapterIndex: number
  level: number
  children: NormalizedTocItem[]
}

export interface NormalizedChapter {
  title: string
  /** body 内的 HTML 片段（不含 html/head/body 标签），生成时会补 <h1> */
  html: string
}

export interface NormalizedBook {
  title: string
  authors: string[]
  publisher?: string
  published?: string
  language?: string
  description?: string
  subjects: string[]
  chapters: NormalizedChapter[]
  toc: NormalizedTocItem[]
  cover?: { data: Uint8Array; ext: string }
  /** EPUB 包内资源：相对 OEBPS/ 的路径 -> 二进制（图片 / 字体等） */
  resources?: Record<string, Uint8Array>
  /** 不影响导入成功、但需要让用户知道的降级信息（例如扫描版 PDF 无文字层） */
  warnings: string[]
}

/** 保留 1.0 的导出名；内部改用共享清单判断，行为一致 */
export function isSupportedBookPath(value: string): boolean {
  const path = String(value || '').trim()
  return !path.startsWith('-') && detectFormat(path) !== null
}

/** 目录展开成扁平列表，供 NAV / NCX 生成时统一遍历 */
export function flattenToc(items: NormalizedTocItem[]): NormalizedTocItem[] {
  const out: NormalizedTocItem[] = []
  const walk = (list: NormalizedTocItem[]): void => {
    for (const item of list) {
      out.push(item)
      walk(item.children)
    }
  }
  walk(items)
  return out
}

/** 章节列表 -> 一级扁平目录 */
export function flatToc(chapters: NormalizedChapter[]): NormalizedTocItem[] {
  return chapters.map((chapter, index) => ({
    label: chapter.title || `第 ${index + 1} 节`,
    chapterIndex: index,
    level: 0,
    children: []
  }))
}

/** 生成最简单的合规 NormalizedBook，供各适配器增量填充 */
export function emptyBook(title: string): NormalizedBook {
  return {
    title,
    authors: [],
    subjects: [],
    chapters: [],
    toc: [],
    warnings: []
  }
}

/** XML/XHTML 文本转义；顺带剔除 XML 1.0 不允许的控制字符 */
export function escapeXml(value: string): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 段落数组 -> <p> HTML（阅读引擎按叶子块级元素抽段落做对照翻译） */
export function paragraphsToHtml(paragraphs: string[]): string {
  return paragraphs
    .map((p) => String(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p)}</p>`)
    .join('\n')
}

/** 太长的段落按中文句号切开，避免一整章只有一个巨型 <p> 影响翻页与翻译切分 */
export function splitLongParagraph(text: string, maxChars = 600): string[] {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return [clean]
  const sentences = clean.match(/[^。！？!?；;]*[。！？!?；;]?/g) || [clean]
  const out: string[] = []
  let buf = ''
  for (const sentence of sentences) {
    if (!sentence) continue
    if (buf.length + sentence.length > maxChars && buf) {
      out.push(buf.trim())
      buf = ''
    }
    buf += sentence
    if (buf.length >= maxChars) {
      out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out.length ? out : [clean]
}

/** 从文件名猜书名 / 作者，覆盖《书名》作者、书名 - 作者 等常见命名 */
export function titleFromFileName(fileName: string): { title: string; author?: string } {
  const base = String(fileName).replace(/\.[a-z0-9]+$/i, '').trim()
  let title = base
  let author: string | undefined
  const bracket = base.match(/《([^》]+)》\s*(.*)$/)
  if (bracket) {
    title = bracket[1].trim()
    const rest = bracket[2].trim().replace(/^[(\[（]|[)\]）]$/g, '')
    if (rest) author = rest
  } else {
    const dash = base.match(/^(.+?)\s*[-—_]\s*(.+)$/)
    if (dash) {
      title = dash[1].trim()
      author = dash[2].trim()
    }
  }
  return { title: title || base || '未命名', author }
}

export function safeFileName(name: string): string {
  return (
    String(name || 'book')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  )
}
