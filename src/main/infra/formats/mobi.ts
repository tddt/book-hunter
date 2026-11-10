import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { NormalizedBook, NormalizedTocItem } from './normalized'
import { emptyBook, flatToc, flattenToc, titleFromFileName } from './normalized'

/**
 * MOBI / AZW3(KF8) 适配器：纯 JS 解析库 -> 统一中间表示 -> 标准 EPUB。
 *
 * 库的 Node 构建会把内嵌图片 / 封面 / CSS 写到一个目录里，并把章节 HTML 中的资源引用
 * 替换成**绝对路径**。因此这里用一个临时目录承接，再把前缀改写成 EPUB 内的 images/，
 * 最后连资源带临时目录一起清理；绝不在项目目录里留下 images/ 垃圾。
 *
 * MOBI6 与 KF8 是两个入口（initMobiFile / initKf8File），按扩展名优先、失败自动换另一个，
 * 兼容「一个 .mobi 里同时带 MOBI6 与 KF8 两份内容」的混合文件。
 *
 * 【必须保留的加载方式】库的 Node 入口 dist/index.node.js 是 ESM（package.json type: module），
 * 而主进程被 electron-vite 编成 CJS。任何顶层 `import ... from '@lingo-reader/mobi-parser'`
 * 都会被打成 require()，启动瞬间抛 ERR_REQUIRE_ESM 让整个应用起不来。
 * 因此只在真正解析 MOBI 时，用 new Function 保留原生动态 import() 懒加载（与 pdf.ts 同理）。
 */
interface MobiTocLike {
  label?: string
  href?: string
  children?: MobiTocLike[]
}
interface MobiLike {
  getSpine(): { id: string }[]
  loadChapter(id: string): { html?: string } | undefined
  getToc(): MobiTocLike[]
  getMetadata(): Record<string, unknown>
  getCoverImage(): string
  resolveHref(href: string): { id?: string } | undefined
  destroy(): void
}

type InitFn = (file: Uint8Array, resourceSaveDir?: string) => Promise<unknown>

interface MobiParserModule {
  initMobiFile: InitFn
  initKf8File: InitFn
}

let parserPromise: Promise<MobiParserModule> | null = null

/** 懒加载 ESM-only 的解析库；失败后可重试（不缓存 rejected promise） */
function loadMobiParser(): Promise<MobiParserModule> {
  if (!parserPromise) {
    const nativeImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<MobiParserModule>
    parserPromise = nativeImport('@lingo-reader/mobi-parser').catch((error) => {
      parserPromise = null
      throw error
    })
  }
  return parserPromise
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean)
  const single = asText(value)
  return single ? [single] : []
}

/** 把库写出的绝对路径前缀改成 EPUB 包内相对路径 images/<name> */
function rewriteResourcePaths(html: string, tempDir: string): string {
  const variants = [tempDir.replace(/\//g, '\\'), tempDir.replace(/\\/g, '/')]
  let out = html
  for (const base of variants) {
    for (const sep of ['\\', '/']) out = out.split(base + sep).join('images/')
  }
  // 库在部分路径里会保留反斜杠；渲染层 normalizePath 会转正，这里顺手统一
  return out.replace(/images\\/g, 'images/')
}

function buildToc(items: MobiTocLike[], chapterOf: (href: string) => number): NormalizedTocItem[] {
  return (items || []).map((item) => ({
    label: asText(item.label) || '未命名章节',
    chapterIndex: chapterOf(asText(item.href)),
    level: 0,
    children: buildToc(item.children || [], chapterOf)
  }))
}

export interface MobiParseOptions {
  fileName?: string
  format?: 'mobi' | 'azw3'
  title?: string
  author?: string
}

export async function parseMobi(bytes: Uint8Array, options: MobiParseOptions = {}): Promise<NormalizedBook> {
  const tempDir = await mkdtemp(join(tmpdir(), 'shulie-mobi-'))
  let instance: MobiLike | null = null
  try {
    const { initMobiFile, initKf8File } = await loadMobiParser()
    const preferKf8 = options.format === 'azw3'
    const attempts: InitFn[] = preferKf8
      ? [initKf8File, initMobiFile]
      : [initMobiFile, initKf8File]
    let lastError: unknown = null
    for (const init of attempts) {
      try {
        const candidate = (await init(new Uint8Array(bytes), tempDir)) as unknown as MobiLike
        const spine = candidate.getSpine?.() || []
        if (spine.length) {
          instance = candidate
          break
        }
        candidate.destroy?.()
      } catch (error) {
        lastError = error
      }
    }
    if (!instance) {
      throw new Error(
        `MOBI/AZW3 解析失败（文件可能损坏、加密或为不支持的 KFX 格式）：${lastError instanceof Error ? lastError.message : String(lastError || '未找到章节')}`
      )
    }

    const spine = instance.getSpine()
    const meta = (instance.getMetadata?.() || {}) as Record<string, unknown>
    const fromName = titleFromFileName(options.fileName || '未命名.mobi')

    // 收集库写出的所有资源（图片 / 封面 / CSS），准备塞进 EPUB
    const resources: Record<string, Uint8Array> = {}
    const files = await readdir(tempDir, { withFileTypes: true }).catch(() => [])
    for (const entry of files) {
      if (!entry.isFile()) continue
      try {
        resources[`images/${entry.name}`] = new Uint8Array(await readFile(join(tempDir, entry.name)))
      } catch {
        /* 单个资源读不出来不影响正文 */
      }
    }

    const spineIndex = new Map(spine.map((item, index) => [String(item.id), index]))
    const chapterOf = (href: string): number => {
      if (!href) return 0
      try {
        const resolved = instance?.resolveHref(href)
        const index = spineIndex.get(String(resolved?.id ?? ''))
        if (index !== undefined) return index
      } catch {
        /* 内部链接解析失败就落到首页 */
      }
      return 0
    }

    const rawToc = buildToc(instance.getToc?.() || [], chapterOf)
    const toc = rawToc.length ? rawToc : []
    const labelByChapter = new Map<number, string>()
    for (const item of flattenToc(toc)) {
      if (!labelByChapter.has(item.chapterIndex)) labelByChapter.set(item.chapterIndex, item.label)
    }

    const book = emptyBook(options.title || asText(meta.title) || fromName.title)
    book.authors = options.author ? [options.author] : asList(meta.author).length ? asList(meta.author) : fromName.author ? [fromName.author] : []
    book.language = asText(meta.language) || 'zh-CN'
    book.publisher = asText(meta.publisher) || undefined
    book.published = asText(meta.published).slice(0, 32) || undefined
    book.description = asText(meta.description).slice(0, 4000) || undefined
    book.subjects = asList(meta.subject).slice(0, 20)
    book.resources = resources

    for (let i = 0; i < spine.length; i += 1) {
      let html = ''
      try {
        html = instance.loadChapter(String(spine[i].id))?.html || ''
      } catch {
        html = ''
      }
      // writer 会统一生成 <h1> 章节标题，先去掉原书里的第一个 h1 避免重复
      const cleaned = rewriteResourcePaths(html, tempDir).replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, '')
      book.chapters.push({
        title: labelByChapter.get(i) || `第 ${i + 1} 节`,
        html: cleaned || '<p>本章内容缺失</p>'
      })
    }
    if (!book.chapters.length) throw new Error('MOBI/AZW3 中未找到可阅读章节')
    book.toc = toc.length ? toc : flatToc(book.chapters)

    // 封面：库的 getCoverImage() 在 Node 下返回写出的绝对路径
    try {
      const coverPath = instance.getCoverImage?.() || ''
      if (coverPath && Object.keys(resources).length) {
        const name = basename(coverPath)
        const data = resources[`images/${name}`] || new Uint8Array(await readFile(coverPath))
        const ext = (extname(name) || '.jpg').slice(0, 6)
        book.cover = { data, ext }
      }
    } catch {
      /* 没有封面不影响导入 */
    }
    book.warnings.push('已由 MOBI/AZW3 转换为 EPUB 阅读，原书样式与 DRM 不受支持')
    return book
  } finally {
    try {
      instance?.destroy?.()
    } catch {
      /* ignore */
    }
    // destroy() 内部是异步 unlink，稍等由 rm 兜底；失败也不影响主流程
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }).catch(() => undefined)
  }
}
