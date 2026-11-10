import MiniSearch, { type Options } from 'minisearch'
import { readFile, writeFile } from 'node:fs/promises'
import { chineseTokenize } from './tokenizer.ts'
import type { Book, Category, Tag } from '@shared/types'

export { chineseTokenize }

interface IndexDoc {
  id: string
  bookId: string
  title: string
  authors: string
  publisher: string
  description: string
  subjects: string
  tags: string
  category: string
  toc: string
}

const searchOptions: Options<IndexDoc> = {
  idField: 'id',
  fields: ['title', 'authors', 'publisher', 'description', 'subjects', 'tags', 'category', 'toc'],
  storeFields: ['bookId', 'title'],
  tokenize: chineseTokenize,
  searchOptions: {
    boost: { title: 5, authors: 3, tags: 2.5, subjects: 1.8, category: 1.8, toc: 1.4 },
    prefix: true,
    fuzzy: 0.15,
    combineWith: 'OR'
  }
}

export interface IndexMatch {
  score: number
  matched: string[]
}

/** 元数据倒排索引接口；正文全文走 ContentScanner，两者由 SearchService 编排 */
export interface ISearchIndex {
  restore(books: Book[]): Promise<boolean>
  build(books: Book[], categories: Category[], tags: Tag[]): Promise<void>
  reconcile(books: Book[], categories: Category[], tags: Tag[]): Promise<void>
  upsert(book: Book, categories: Category[], tags: Tag[]): Promise<void>
  remove(bookId: string): Promise<void>
  search(text: string): Map<string, IndexMatch>
}

export class MiniSearchIndex implements ISearchIndex {
  private mini: MiniSearch<IndexDoc> = new MiniSearch<IndexDoc>(searchOptions)
  private ids = new Set<string>()

  /** 索引文件路径由组合根注入，本模块不依赖 Electron 环境，可独立测试 */
  private readonly indexFile: string

  constructor(indexFile: string) {
    this.indexFile = indexFile
  }

  private get file(): string {
    return this.indexFile
  }

  private buildDoc(book: Book, categories: Category[], tags: Tag[]): IndexDoc {
    const category = categories.find((c) => c.id === book.categoryId)?.name || ''
    const tagNames = book.tagIds
      .map((id) => tags.find((t) => t.id === id)?.name)
      .filter(Boolean)
      .join(' ')
    return {
      id: book.id,
      bookId: book.id,
      title: book.title,
      authors: book.authors.join(' '),
      publisher: book.publisher || '',
      description: (book.description || '').slice(0, 2000),
      subjects: book.subjects.join(' '),
      tags: tagNames,
      category,
      toc: (book.tocText || '').slice(0, 4000)
    }
  }

  async restore(books: Book[]): Promise<boolean> {
    try {
      const json = await readFile(this.file, 'utf8')
      this.mini = MiniSearch.loadJSON<IndexDoc>(json, searchOptions)
      this.ids = new Set(books.map((b) => b.id))
      return true
    } catch {
      return false
    }
  }

  async build(books: Book[], categories: Category[], tags: Tag[]): Promise<void> {
    this.mini = new MiniSearch<IndexDoc>(searchOptions)
    this.ids.clear()
    for (const book of books) {
      this.mini.add(this.buildDoc(book, categories, tags))
      this.ids.add(book.id)
    }
    await this.persist()
  }

  async reconcile(books: Book[], categories: Category[], tags: Tag[]): Promise<void> {
    const expected = new Set(books.map((b) => b.id))
    for (const id of [...this.ids]) {
      if (!expected.has(id)) {
        try {
          this.mini.discard(id)
        } catch {
          /* 索引里可能本就没有 */
        }
        this.ids.delete(id)
      }
    }
    for (const book of books) {
      if (!this.ids.has(book.id)) {
        this.mini.add(this.buildDoc(book, categories, tags))
        this.ids.add(book.id)
      } else {
        this.mini.replace(this.buildDoc(book, categories, tags))
      }
    }
    await this.persist()
  }

  async upsert(book: Book, categories: Category[], tags: Tag[]): Promise<void> {
    const doc = this.buildDoc(book, categories, tags)
    if (this.ids.has(book.id)) this.mini.replace(doc)
    else {
      this.mini.add(doc)
      this.ids.add(book.id)
    }
    await this.persist()
  }

  async remove(bookId: string): Promise<void> {
    if (!this.ids.has(bookId)) return
    try {
      this.mini.discard(bookId)
    } catch {
      /* ignore */
    }
    this.ids.delete(bookId)
    await this.persist()
  }

  search(text: string): Map<string, IndexMatch> {
    const result = new Map<string, IndexMatch>()
    for (const hit of this.mini.search(text)) {
      const row = hit as unknown as Record<string, unknown>
      const bookId = String(row.bookId ?? hit.id)
      const terms = Object.keys(hit.match || {})
      const prev = result.get(bookId)
      if (!prev) result.set(bookId, { score: hit.score, matched: terms })
      else {
        prev.score = Math.max(prev.score, hit.score) + 0.5
        prev.matched = [...new Set([...prev.matched, ...terms])]
      }
    }
    return result
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.mini.toJSON()), 'utf8')
  }
}
