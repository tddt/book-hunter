import { readFile } from 'node:fs/promises'
import type { IRepository } from '../infra/repository'
import type { ISearchIndex } from '../infra/search-index'
import type { IContentScanner } from '../infra/content-scanner'
import type { IEpubParser } from '../infra/epub-parser'
import type { IEventBus } from '../infra/event-bus'
import { EV } from '@shared/contract'
import type {
  Book,
  ContentCacheResult,
  SearchHit,
  SearchQuery,
  SearchResult
} from '@shared/types'

function metaHit(book: Book, score: number, matched: string[]): SearchHit {
  return {
    bookId: book.id,
    title: book.title,
    authors: book.authors,
    cover: book.cover,
    score,
    source: 'metadata',
    matched
  }
}

/** 倒排索引损坏 / 反序列化失败时的兜底：书库规模下线性匹配仍然很快 */
function linearMetaSearch(books: Book[], text: string): SearchHit[] {
  const needle = text.toLowerCase()
  const terms = needle.split(/\s+/).filter(Boolean)
  const out: SearchHit[] = []
  for (const book of books) {
    const hay = [
      book.title,
      book.authors.join(' '),
      book.publisher || '',
      book.description || '',
      book.subjects.join(' '),
      book.tocText || ''
    ]
      .join(' ')
      .toLowerCase()
    const matched = terms.filter((t) => hay.includes(t))
    if (!matched.length && !hay.includes(needle)) continue
    out.push(metaHit(book, 1 + matched.length, matched.length ? matched : [text]))
  }
  return out
}

/**
 * 两阶段检索编排：
 * 阶段 1（毫秒级）：MiniSearch 元数据倒排，立即给结果；
 * 阶段 2（秒级、可中断）：正文缓存流式扫描，边扫边推进度。
 *
 * 健壮性约定：任一阶段异常都不能让整个搜索「无结果」——元数据索引失败时
 * 降级为线性匹配，正文扫描失败时至少保留已得到的元数据结果，并给出提示。
 */
export class SearchService {
  private abort?: AbortController

  constructor(
    private readonly repo: IRepository,
    private readonly index: ISearchIndex,
    private readonly scanner: IContentScanner,
    private readonly events: IEventBus,
    private readonly parser: IEpubParser
  ) {}

  async initialize(): Promise<void> {
    const s = await this.repo.snapshot()
    const restored = await this.index.restore(s.books)
    if (restored) await this.index.reconcile(s.books, s.categories, s.tags)
    else await this.index.build(s.books, s.categories, s.tags)
  }

  async rebuild(): Promise<void> {
    const s = await this.repo.snapshot()
    await this.index.build(s.books, s.categories, s.tags)
  }

  /**
   * 为历史书补建正文缓存。
   * 典型场景：导入时「正文全文检索」是关的，后来在设置里打开；
   * 或者旧版本写缓存失败。开启开关后必须能补齐，否则搜索永远没有正文结果。
   */
  async rebuildContent(): Promise<ContentCacheResult> {
    const snapshot = await this.repo.snapshot()
    const targets = snapshot.books.filter((b) => !b.textCached)
    const result: ContentCacheResult = {
      built: 0,
      skipped: snapshot.books.length - targets.length,
      failed: 0
    }
    for (let i = 0; i < targets.length; i += 1) {
      const book = targets[i]
      this.events.emit(EV.contentProgress, {
        done: i,
        total: targets.length,
        fileName: book.title
      })
      try {
        const bytes = await readFile(this.repo.resolveBookPath(book))
        const parsed = await this.parser.parse(bytes)
        await this.repo.writeContent({
          bookId: book.id,
          chapters: parsed.chapters,
          toc: parsed.toc
        })
        await this.repo.mutate((s) => {
          const target = s.books.find((b) => b.id === book.id)
          if (target) target.textCached = true
        })
        result.built += 1
      } catch (error) {
        result.failed += 1
        console.warn(`[content] 补建正文缓存失败：${book.title}`, error)
      }
    }
    this.events.emit(EV.contentProgress, {
      done: targets.length,
      total: targets.length,
      fileName: '完成'
    })
    this.events.emit(EV.libraryChanged, { reason: 'content-cache-rebuilt' })
    return result
  }

  async query(q: SearchQuery): Promise<SearchResult> {
    const started = Date.now()
    this.abort?.abort()
    const controller = new AbortController()
    this.abort = controller

    const text = q.text.trim()
    const snapshot = await this.repo.snapshot()
    const candidates = snapshot.books.filter((b) => {
      if (q.categoryId && b.categoryId !== q.categoryId) return false
      if (q.tagIds?.length && !q.tagIds.every((t) => b.tagIds.includes(t))) return false
      if (q.status && b.status !== q.status) return false
      if (q.favoriteOnly && !b.favorite) return false
      return true
    })
    const byId = new Map(candidates.map((b) => [b.id, b]))
    const scannable = candidates.filter((b) => b.textCached)

    let hint: string | undefined
    if (text && q.content !== false) {
      if (!snapshot.settings.contentSearch) {
        hint = '正文全文检索已关闭，可在「设置」中开启并重建正文缓存'
      } else if (!scannable.length && candidates.length) {
        hint = '还没有可用的正文缓存，可在「设置」中重建正文缓存'
      }
    }

    // 空查询 = 按当前筛选条件浏览书库
    if (!text) {
      const hits = candidates
        .slice()
        .sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
        .slice(0, q.limit || 200)
        .map((b) => metaHit(b, 0, []))
      this.events.emit(EV.searchProgress, { phase: 'done', done: 1, total: 1 })
      return {
        hits,
        took: Date.now() - started,
        contentTotal: 0,
        truncated: false,
        searchableBooks: scannable.length,
        hint
      }
    }

    let metadataHits: SearchHit[] = []
    try {
      for (const [bookId, match] of this.index.search(text)) {
        const book = byId.get(bookId)
        if (book) metadataHits.push(metaHit(book, match.score + 6, match.matched))
      }
    } catch (error) {
      console.warn('[search] 元数据索引异常，降级为线性匹配', error)
      metadataHits = linearMetaSearch(candidates, text)
    }
    this.events.emit(EV.searchProgress, { phase: 'index', done: 1, total: 1 })

    const contentHits: SearchHit[] = []
    let contentTotal = 0
    if (q.content !== false && snapshot.settings.contentSearch && scannable.length) {
      this.events.emit(EV.searchProgress, { phase: 'content', done: 0, total: scannable.length })
      try {
        const raw = await this.scanner.scan(
          text,
          scannable,
          (done, total) => this.events.emit(EV.searchProgress, { phase: 'content', done, total }),
          controller.signal
        )
        contentTotal = raw.total
        const perBook = new Map<string, number>()
        for (const hit of raw.hits) {
          const book = byId.get(hit.bookId)
          if (!book) continue
          const used = perBook.get(hit.bookId) || 0
          if (used >= 8) continue
          perBook.set(hit.bookId, used + 1)
          contentHits.push({
            bookId: book.id,
            title: book.title,
            authors: book.authors,
            cover: book.cover,
            score: hit.score,
            source: 'content',
            snippet: hit.snippet,
            chapterIndex: hit.chapterIndex,
            chapterTitle: hit.chapterTitle,
            offset: hit.offset,
            matched: hit.matched
          })
        }
      } catch (error) {
        console.warn('[search] 正文扫描失败，仅返回元数据结果', error)
        hint = '正文扫描出现异常，已仅显示书名 / 元数据结果'
      }
    }
    this.events.emit(EV.searchProgress, { phase: 'done', done: 1, total: 1 })

    const limit = q.limit || 180
    const topMeta = metadataHits.sort((a, b) => b.score - a.score).slice(0, Math.min(60, limit))
    const room = Math.max(0, limit - topMeta.length)
    const topContent = contentHits.sort((a, b) => b.score - a.score).slice(0, room)
    return {
      hits: [...topMeta, ...topContent],
      took: Date.now() - started,
      contentTotal,
      truncated: contentTotal > topContent.length,
      searchableBooks: scannable.length,
      hint
    }
  }
}
