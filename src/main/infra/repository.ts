import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { PATHS } from '../env'
import { AtomicJsonStore } from './json-store'
import {
  createEmptySnapshot,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  DEFAULT_TRANSLATION_SETTINGS,
  SNAPSHOT_VERSION
} from '@shared/constants'
import type { AppSettings, Book, BookContent, LibrarySnapshot } from '@shared/types'

/**
 * 仓储接口。当前实现为 JSON 原子仓储（千本以内零依赖、免编译）。
 * 换成 SQLite 时只需实现本接口并在 container.ts 中替换一行，
 * 上层所有 Service 与 IPC 无需改动。
 */
export interface IRepository {
  init(): Promise<void>
  snapshot(): Promise<LibrarySnapshot>
  mutate<R>(fn: (s: LibrarySnapshot) => R | Promise<R>): Promise<{ result: R; snapshot: LibrarySnapshot }>
  resolveBookPath(book: Book): string
  writeCover(bookId: string, data: Uint8Array, ext: string): Promise<string>
  writeContent(content: BookContent): Promise<void>
  readContent(bookId: string): Promise<BookContent | null>
  removeContent(bookId: string): Promise<void>
  setLibraryRoot(dir?: string): void
}

function mergeSettings(saved?: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(saved || {}),
    reader: { ...DEFAULT_SETTINGS.reader, ...(saved?.reader || {}) },
    // 老快照没有翻译偏好，逐字段补齐，避免新增设置项后出现 undefined
    translation: { ...DEFAULT_TRANSLATION_SETTINGS, ...(saved?.translation || {}) }
  }
}

export class JsonRepository implements IRepository {
  private readonly store: AtomicJsonStore<LibrarySnapshot>

  constructor() {
    this.store = new AtomicJsonStore<LibrarySnapshot>(PATHS.snapshot, createEmptySnapshot)
  }

  async init(): Promise<void> {
    PATHS.ensure()
    const { data } = await this.store.mutate((draft) => {
      draft.version = SNAPSHOT_VERSION
      draft.settings = mergeSettings(draft.settings)
      if (!Array.isArray(draft.books)) draft.books = []
      if (!Array.isArray(draft.categories)) draft.categories = []
      if (!Array.isArray(draft.tags)) draft.tags = []
      if (!Array.isArray(draft.bookmarks)) draft.bookmarks = []
      if (!Array.isArray(draft.notes)) draft.notes = []
      if (!draft.progresses || typeof draft.progresses !== 'object') draft.progresses = {}
      if (draft.categories.length === 0) {
        draft.categories = DEFAULT_CATEGORIES.map((c, i) => ({
          id: randomUUID(),
          name: c.name,
          color: c.color,
          order: i,
          createdAt: Date.now()
        }))
      }
    })
    PATHS.setLibraryRoot(data.settings.libraryDir)
  }

  async snapshot(): Promise<LibrarySnapshot> {
    const data = await this.store.read()
    return structuredClone(data)
  }

  async mutate<R>(
    fn: (s: LibrarySnapshot) => R | Promise<R>
  ): Promise<{ result: R; snapshot: LibrarySnapshot }> {
    const { result, data } = await this.store.mutate(fn)
    return { result, snapshot: structuredClone(data) }
  }

  resolveBookPath(book: Book): string {
    return isAbsolute(book.filePath) ? book.filePath : PATHS.bookFile(book.filePath)
  }

  async writeCover(bookId: string, data: Uint8Array, ext: string): Promise<string> {
    await mkdir(PATHS.covers, { recursive: true })
    const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : '.jpg'
    const fileName = `${bookId}${safeExt}`
    await writeFile(PATHS.coverFile(fileName), data)
    return fileName
  }

  async writeContent(content: BookContent): Promise<void> {
    await mkdir(PATHS.text, { recursive: true })
    await writeFile(PATHS.textFile(content.bookId), JSON.stringify(content), 'utf8')
  }

  async readContent(bookId: string): Promise<BookContent | null> {
    try {
      return JSON.parse(await readFile(PATHS.textFile(bookId), 'utf8')) as BookContent
    } catch {
      return null
    }
  }

  async removeContent(bookId: string): Promise<void> {
    await unlink(PATHS.textFile(bookId)).catch(() => undefined)
  }

  setLibraryRoot(dir?: string): void {
    PATHS.setLibraryRoot(dir)
  }

  /** 供调试使用：书库目录总大小等统计 */
  libraryJoin(...parts: string[]): string {
    return join(PATHS.library, ...parts)
  }
}
