import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { IRepository } from '../infra/repository'
import type {
  BookContent,
  Bookmark,
  Note,
  ReadingProgress
} from '@shared/types'

/** 阅读相关数据的读写：EPUB 字节、正文缓存、进度、书签、笔记 */
export class ReaderService {
  constructor(private readonly repo: IRepository) {}

  async load(bookId: string): Promise<ArrayBuffer> {
    const snapshot = await this.repo.snapshot()
    const book = snapshot.books.find((b) => b.id === bookId)
    if (!book) throw new Error('书籍不存在')
    const buf = await readFile(this.repo.resolveBookPath(book))
    // 转成独立的 ArrayBuffer，避免把整个 Node Buffer 池一起结构化克隆出去
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  }

  content(bookId: string): Promise<BookContent | null> {
    return this.repo.readContent(bookId)
  }

  async progressGet(bookId: string): Promise<ReadingProgress | null> {
    return (await this.repo.snapshot()).progresses[bookId] || null
  }

  async progressSave(progress: ReadingProgress): Promise<void> {
    await this.repo.mutate((s) => {
      s.progresses[progress.bookId] = progress
      const book = s.books.find((b) => b.id === progress.bookId)
      if (book) {
        book.lastReadAt = progress.updatedAt
        if (book.status === 'unread') book.status = 'reading'
      }
    })
  }

  async bookmarkList(bookId: string): Promise<Bookmark[]> {
    return (await this.repo.snapshot()).bookmarks.filter((x) => x.bookId === bookId)
  }

  async bookmarkAdd(input: Bookmark): Promise<Bookmark> {
    const bookmark = { ...input, id: input.id || randomUUID(), createdAt: input.createdAt || Date.now() }
    await this.repo.mutate((s) => {
      const i = s.bookmarks.findIndex((x) => x.id === bookmark.id)
      if (i >= 0) s.bookmarks[i] = bookmark
      else s.bookmarks.push(bookmark)
    })
    return bookmark
  }

  async bookmarkRemove(id: string): Promise<void> {
    await this.repo.mutate((s) => {
      s.bookmarks = s.bookmarks.filter((x) => x.id !== id)
    })
  }

  async noteList(bookId: string): Promise<Note[]> {
    return (await this.repo.snapshot()).notes.filter((x) => x.bookId === bookId)
  }

  async noteAdd(input: Note): Promise<Note> {
    const note = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt || Date.now(),
      updatedAt: input.updatedAt || Date.now()
    }
    await this.repo.mutate((s) => {
      const i = s.notes.findIndex((x) => x.id === note.id)
      if (i >= 0) s.notes[i] = note
      else s.notes.push(note)
    })
    return note
  }

  async noteUpdate(id: string, patch: Partial<Note>): Promise<Note> {
    const { result } = await this.repo.mutate((s) => {
      const note = s.notes.find((x) => x.id === id)
      if (!note) throw new Error('笔记不存在')
      Object.assign(note, patch, { updatedAt: Date.now() })
      return structuredClone(note)
    })
    return result
  }

  async noteRemove(id: string): Promise<void> {
    await this.repo.mutate((s) => {
      s.notes = s.notes.filter((x) => x.id !== id)
    })
  }
}
