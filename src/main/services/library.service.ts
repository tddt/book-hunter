import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { shell } from 'electron'
import { PATHS } from '../env'
import type { IRepository } from '../infra/repository'
import type { ISearchIndex } from '../infra/search-index'
import type { IEventBus } from '../infra/event-bus'
import { EV } from '@shared/contract'
import { DEFAULT_TRANSLATION_SETTINGS } from '@shared/constants'
import type {
  AppSettings,
  Book,
  Category,
  LibrarySnapshot,
  Tag
} from '@shared/types'

/** 书库、分类、标签、设置的唯一写入口；任何写入后负责同步索引与广播变更 */
export class LibraryService {
  constructor(
    private readonly repo: IRepository,
    private readonly index: ISearchIndex,
    private readonly events: IEventBus
  ) {}

  snapshot(): Promise<LibrarySnapshot> {
    return this.repo.snapshot()
  }

  async get(id: string): Promise<Book | null> {
    return (await this.repo.snapshot()).books.find((b) => b.id === id) || null
  }

  private async reindex(): Promise<void> {
    const s = await this.repo.snapshot()
    await this.index.reconcile(s.books, s.categories, s.tags)
  }

  async update(id: string, patch: Partial<Book>): Promise<Book> {
    const { result } = await this.repo.mutate((s) => {
      const book = s.books.find((b) => b.id === id)
      if (!book) throw new Error('书籍不存在')
      // id / hash / filePath 属于不可变标识，禁止从 UI 覆盖
      const { id: _i, hash: _h, ...safe } = patch
      Object.assign(book, safe, { updatedAt: Date.now() })
      return structuredClone(book)
    })
    const s = await this.repo.snapshot()
    await this.index.upsert(result, s.categories, s.tags)
    this.events.emit(EV.libraryChanged, { reason: 'book-updated' })
    return result
  }

  async remove(ids: string[], deleteFile = false): Promise<{ removed: number }> {
    const idSet = new Set(ids)
    const before = await this.repo.snapshot()
    const targets = before.books.filter((b) => idSet.has(b.id))

    await this.repo.mutate((s) => {
      s.books = s.books.filter((b) => !idSet.has(b.id))
      s.bookmarks = s.bookmarks.filter((x) => !idSet.has(x.bookId))
      s.notes = s.notes.filter((x) => !idSet.has(x.bookId))
      for (const id of idSet) delete s.progresses[id]
    })

    // 文件清理与数据分离：单个文件删不掉不影响书库一致性
    for (const book of targets) {
      await this.index.remove(book.id)
      await this.repo.removeContent(book.id)
      if (book.cover) await unlink(PATHS.coverFile(book.cover)).catch(() => undefined)
      if (deleteFile) {
        await unlink(this.repo.resolveBookPath(book)).catch(() => undefined)
      }
    }
    this.events.emit(EV.libraryChanged, { reason: 'book-removed' })
    return { removed: targets.length }
  }

  async saveCategory(input: Category): Promise<Category> {
    const saved: Category = {
      ...input,
      id: input.id || randomUUID(),
      order: input.order ?? 0,
      createdAt: input.createdAt || Date.now()
    }
    await this.repo.mutate((s) => {
      const i = s.categories.findIndex((c) => c.id === saved.id)
      if (i >= 0) s.categories[i] = saved
      else s.categories.push({ ...saved, order: s.categories.length })
    })
    await this.reindex()
    this.events.emit(EV.libraryChanged, { reason: 'category-saved' })
    return saved
  }

  async removeCategory(id: string): Promise<void> {
    await this.repo.mutate((s) => {
      s.categories = s.categories.filter((c) => c.id !== id)
      for (const c of s.categories) if (c.parentId === id) c.parentId = undefined
      for (const b of s.books) if (b.categoryId === id) b.categoryId = undefined
    })
    await this.reindex()
    this.events.emit(EV.libraryChanged, { reason: 'category-removed' })
  }

  async saveTag(input: Tag): Promise<Tag> {
    const saved: Tag = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt || Date.now()
    }
    await this.repo.mutate((s) => {
      const i = s.tags.findIndex((t) => t.id === saved.id)
      if (i >= 0) s.tags[i] = saved
      else s.tags.push(saved)
    })
    await this.reindex()
    this.events.emit(EV.libraryChanged, { reason: 'tag-saved' })
    return saved
  }

  async removeTag(id: string): Promise<void> {
    await this.repo.mutate((s) => {
      s.tags = s.tags.filter((t) => t.id !== id)
      for (const b of s.books) b.tagIds = b.tagIds.filter((t) => t !== id)
    })
    await this.reindex()
    this.events.emit(EV.libraryChanged, { reason: 'tag-removed' })
  }

  async getSettings(): Promise<AppSettings> {
    return (await this.repo.snapshot()).settings
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const { result } = await this.repo.mutate((s) => {
      s.settings = {
        ...s.settings,
        ...patch,
        reader: { ...s.settings.reader, ...(patch.reader || {}) },
        translation: {
          ...DEFAULT_TRANSLATION_SETTINGS,
          ...(s.settings.translation || {}),
          ...(patch.translation || {})
        }
      }
      return structuredClone(s.settings)
    })
    if (patch.libraryDir !== undefined) this.repo.setLibraryRoot(patch.libraryDir)
    return result
  }

  async reveal(id: string): Promise<void> {
    const book = await this.get(id)
    if (book) shell.showItemInFolder(this.repo.resolveBookPath(book))
  }
}
