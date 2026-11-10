import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  open,
  readFile,
  readdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { dialog } from 'electron'
import { PATHS } from '../env'
import type { IRepository } from '../infra/repository'
import type { IEpubParser } from '../infra/epub-parser'
import type { ISearchIndex } from '../infra/search-index'
import type { IEventBus } from '../infra/event-bus'
import { convertBytesToEpub, formatOf, BOOK_DIALOG_EXTENSIONS, FORMAT_HINT } from '../infra/formats'
import { EV } from '@shared/contract'
import type { AppSettings, Book, ImportOptions, ImportResult } from '@shared/types'

/** 导入完成后由谁负责在线补全，用接口解耦，避免服务之间互相 new */
export interface IMetadataEnricher {
  enrich(bookIds: string[]): Promise<void>
}

async function fingerprint(filePath: string): Promise<string> {
  const info = await stat(filePath)
  const size = Math.min(info.size, 1024 * 1024)
  const buf = Buffer.alloc(size)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(buf, 0, size, 0)
  } finally {
    await handle.close()
  }
  return createHash('sha1').update(buf).update(String(info.size)).digest('hex')
}

/** 展开传入路径：支持单文件、目录（递归收集 EPUB / MOBI / AZW3 / PDF / TXT） */
async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = async (target: string, depth: number): Promise<void> => {
    if (depth > 6) return
    const info = await stat(target).catch(() => null)
    if (!info) return
    if (info.isFile()) {
      if (formatOf(target) && !seen.has(target)) {
        seen.add(target)
        out.push(target)
      }
      return
    }
    if (!info.isDirectory()) return
    const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      await walk(join(target, entry.name), depth + 1)
    }
  }
  for (const p of paths) await walk(p, 0)
  return out
}

interface OneOptions {
  copy: boolean
  settings: AppSettings
  knownHashes: Set<string>
  categoryId?: string
  tagIds: string[]
}

export class ImportService {
  constructor(
    private readonly repo: IRepository,
    private readonly parser: IEpubParser,
    private readonly index: ISearchIndex,
    private readonly events: IEventBus,
    private readonly enricher: IMetadataEnricher
  ) {}

  async pickFiles(): Promise<string[]> {
    const result = await dialog.showOpenDialog({
      title: `选择电子书（${FORMAT_HINT}）`,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '电子书', extensions: BOOK_DIALOG_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  }

  async pickFolder(): Promise<string[]> {
    const result = await dialog.showOpenDialog({
      title: '选择要批量导入的文件夹',
      properties: ['openDirectory']
    })
    return result.canceled ? [] : result.filePaths
  }

  async import(options: ImportOptions): Promise<ImportResult> {
    const files = await expandPaths(options.paths)
    const snapshot = await this.repo.snapshot()
    const settings = snapshot.settings
    const copy = options.copy ?? settings.copyOnImport
    const knownHashes = new Set(snapshot.books.map((b) => b.hash))
    const result: ImportResult = { books: [], skipped: 0, failed: [], warnings: [] }

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]
      // 非 EPUB 会先转码，进度条要能反映这一步，避免大 PDF 看起来像卡死
      const needsConvert = formatOf(file) !== 'epub'
      this.events.emit(EV.importProgress, {
        current: i + 1,
        total: files.length,
        fileName: basename(file),
        phase: needsConvert ? 'convert' : 'parse'
      })
      try {
        const outcome = await this.importOne(file, {
          copy,
          settings,
          knownHashes,
          categoryId: options.categoryId,
          tagIds: options.tagIds || []
        })
        if (!outcome) {
          result.skipped += 1
          continue
        }
        result.books.push(outcome.book)
        for (const message of outcome.warnings) {
          result.warnings!.push({ path: file, message })
        }
      } catch (error) {
        result.failed.push({
          path: file,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (result.books.length) {
      await this.repo.mutate((s) => {
        s.books.push(...result.books)
      })
      this.events.emit(EV.importProgress, {
        current: files.length,
        total: files.length,
        fileName: '建立检索索引',
        phase: 'index'
      })
      const fresh = await this.repo.snapshot()
      await this.index.reconcile(fresh.books, fresh.categories, fresh.tags)
    }

    this.events.emit(EV.importDone, result)
    this.events.emit(EV.libraryChanged, { reason: 'imported' })

    // 在线补全完全异步：不阻塞导入返回，离线时应用照常可用
    if (settings.autoMetadata && result.books.length) {
      this.events.emit(EV.importProgress, {
        current: files.length,
        total: files.length,
        fileName: '联网补全元数据',
        phase: 'metadata'
      })
      void this.enricher.enrich(result.books.map((b) => b.id))
    }
    return result
  }

  private async importOne(
    filePath: string,
    options: OneOptions
  ): Promise<{ book: Book; warnings: string[] } | null> {
    const hash = await fingerprint(filePath)
    if (options.knownHashes.has(hash)) return null

    const format = formatOf(filePath)
    if (!format) throw new Error(`不支持的文件格式：${extname(filePath)}`)
    const info = await stat(filePath)
    const raw = await readFile(filePath)

    // 2.0 核心：非 EPUB 一律先转成标准 EPUB 再入库。
    // 阅读器只认 EPUB 字节（reader:load -> JSZip -> 章节 XHTML），转换后
    // 排版 / 目录 / 进度 / 全文检索 / 对照翻译全部零改动复用，体验与 EPUB 一致。
    // 转换结果立即交回既有解析器，等于做了一次真实的结构自校验。
    const converted = await convertBytesToEpub(raw, format, basename(filePath))
    const parsed = await this.parser.parse(converted.data)
    const warnings = [...converted.warnings]
    const id = randomUUID()

    let fileName: string
    let storedPath: string
    // 转码产物必须落到书库：原文件不是 EPUB，不能沿用「只记原路径」的旧逻辑。
    // 原生 EPUB 且 copyOnImport=false 时行为与 1.0 完全一致。
    const mustStoreEpub = options.copy || format !== 'epub'
    if (mustStoreEpub) {
      fileName = `${hash}.epub`
      const dest = PATHS.bookFile(fileName)
      const exists = await access(dest).then(() => true).catch(() => false)
      if (!exists) {
        if (format === 'epub') await copyFile(filePath, dest)
        else await writeFile(dest, converted.data)
      }
      storedPath = fileName
      if (format !== 'epub') warnings.push(`已由 .${format} 转换为 EPUB 存入书库，原文件保持不动`)
    } else {
      fileName = basename(filePath)
      storedPath = filePath
    }

    let cover: string | undefined
    if (parsed.cover) {
      cover = await this.repo.writeCover(id, parsed.cover.data, parsed.cover.ext)
    }

    if (options.settings.contentSearch) {
      await this.repo.writeContent({
        bookId: id,
        chapters: parsed.chapters,
        toc: parsed.toc
      })
    }

    const tocText = [
      ...parsed.chapters.map((c) => c.title),
      ...parsed.toc.map((t) => t.label)
    ]
      .join(' ')
      .slice(0, 4000)

    const now = Date.now()
    const book: Book = {
      id,
      title: parsed.meta.title || basename(filePath, extname(filePath)),
      authors: parsed.meta.authors,
      publisher: parsed.meta.publisher,
      published: parsed.meta.published,
      language: parsed.meta.language,
      isbn: parsed.meta.isbn,
      description: parsed.meta.description,
      subjects: parsed.meta.subjects,
      tocText,
      cover,
      fileName,
      filePath: storedPath,
      originalPath: filePath,
      fileSize: info.size,
      hash,
      addedAt: now,
      updatedAt: now,
      categoryId: options.categoryId,
      tagIds: options.tagIds,
      rating: 0,
      favorite: false,
      status: 'unread',
      chapterCount: parsed.chapters.length,
      metadataSource: 'opf',
      textCached: options.settings.contentSearch
    }
    options.knownHashes.add(hash)
    return { book, warnings }
  }
}
