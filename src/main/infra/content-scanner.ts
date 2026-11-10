import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { IRepository } from './repository'
import { SEARCH_SNIPPET_RADIUS } from '@shared/constants'
import type { Book } from '@shared/types'

export interface ContentHit {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  snippet: string
  /** 命中在章节纯文本中的字符偏移，供阅读器翻到命中所在页 */
  offset: number
  /** 命中次数换算的权重 */
  score: number
  matched: string[]
}

export interface ContentScanResult {
  hits: ContentHit[]
  /** 全书范围内命中的总处数（未被结果限量截断之前） */
  total: number
}

export interface IContentScanner {
  scan(
    query: string,
    books: Book[],
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<ContentScanResult>
}

function makeSnippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SEARCH_SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SEARCH_SNIPPET_RADIUS)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * 把查询拆成「整串优先 + 空格分词兜底」的候选词。
 * 例："英国 历史" 整串在正文里通常不连续，但两个词各自都能命中；
 * 整串仍是首选，保证精确短语排在结果前面。
 */
function queryTerms(query: string): string[] {
  const raw = query.trim().toLowerCase()
  if (!raw) return []
  const parts = raw.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean)
  return [...new Set([raw, ...parts])].sort((a, b) => b.length - a.length).slice(0, 6)
}

/**
 * 正文全文扫描器。
 *
 * 设计取舍：不做「全文倒排索引」。千本书的正文若全部入倒排索引，
 * 索引体积会达到原文的 1~3 倍（GB 级），启动加载与内存都不可接受。
 * 这里改为「导入时缓存纯文本 + 检索时流式扫描」：
 *  - 元数据结果由 MiniSearch 毫秒级返回，用户先看到结果；
 *  - 正文命中边扫边推进度，可中断，书库规模下通常是秒级；
 *  - 缓存是独立 JSON 文件，删书即删，不会产生索引漂移。
 */
export class TextCacheScanner implements IContentScanner {
  constructor(private readonly repo: IRepository) {}

  async scan(
    query: string,
    books: Book[],
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<ContentScanResult> {
    const terms = queryTerms(query)
    if (!terms.length) return { hits: [], total: 0 }
    const hits: ContentHit[] = []
    let total = 0
    const candidates = books.filter((b) => b.textCached)
    let done = 0

    for (const book of candidates) {
      if (signal?.aborted) break
      done += 1
      onProgress?.(done, candidates.length)
      if (done % 4 === 0) await yieldToEventLoop()

      const content = await this.repo.readContent(book.id)
      if (!content) continue
      for (const chapter of content.chapters) {
        if (signal?.aborted) break
        const text = chapter.text || ''
        const lower = text.toLowerCase()
        const positions: { at: number; term: string }[] = []
        for (const term of terms) {
          let pos = lower.indexOf(term)
          while (pos >= 0 && positions.length < 400) {
            positions.push({ at: pos, term })
            pos = lower.indexOf(term, pos + term.length)
          }
        }
        if (!positions.length) continue
        positions.sort((a, b) => a.at - b.at)
        total += positions.length
        // 每章最多产出 3 条片段，避免一本大书刷屏；总数仍按真实命中数统计
        for (const p of positions.slice(0, 3)) {
          hits.push({
            bookId: book.id,
            chapterIndex: chapter.index,
            chapterTitle: chapter.title,
            snippet: makeSnippet(text, p.at, p.term.length),
            offset: p.at,
            score:
              1 + Math.log2(1 + positions.length) * 2 + (chapter.index === 0 ? 0.5 : 0),
            matched: [p.term]
          })
        }
      }
    }
    return { hits, total }
  }
}
