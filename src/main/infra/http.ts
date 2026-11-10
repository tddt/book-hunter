import type { MetadataPatch } from '@shared/types'

interface OpenLibraryDoc {
  key?: string
  title?: string
  author_name?: string[]
  first_publish_year?: number
  publisher?: string[]
  isbn?: string[]
  cover_i?: number
  subject?: string[]
  language?: string[]
  ratings_average?: number
}

interface OpenLibraryResponse {
  numFound?: number
  docs?: OpenLibraryDoc[]
}

export interface OnlineMetadata extends MetadataPatch {
  coverUrl?: string
}

/**
 * 在线元数据补全客户端（Open Library，无需 API Key）。
 * 设计原则：失败一律静默返回 null，绝不阻塞导入主流程；
 * 所有请求带超时，离线 / 被墙时应用完全可用（只是不补全）。
 */
export class MetadataClient {
  constructor(
    private readonly base = 'https://openlibrary.org',
    private readonly coverBase = 'https://covers.openlibrary.org',
    private readonly timeoutMs = 8000
  ) {}

  async lookup(params: { title: string; authors?: string[]; isbn?: string }): Promise<OnlineMetadata | null> {
    const url = new URL('/search.json', this.base)
    url.searchParams.set('limit', '1')
    url.searchParams.set(
      'fields',
      'key,title,author_name,first_publish_year,publisher,isbn,cover_i,subject'
    )
    if (params.isbn) url.searchParams.set('isbn', params.isbn)
    else {
      if (params.title) url.searchParams.set('title', params.title)
      if (params.authors?.length) url.searchParams.set('author', params.authors[0])
    }
    if (!params.isbn && !params.title) return null

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) return null
      const data = (await res.json()) as OpenLibraryResponse
      const doc = data.docs?.[0]
      if (!doc) return null
      return {
        title: doc.title || undefined,
        authors: doc.author_name?.length ? doc.author_name.slice(0, 5) : undefined,
        published: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
        publisher: doc.publisher?.[0] || undefined,
        isbn: doc.isbn?.[0] || undefined,
        subjects: (doc.subject || []).slice(0, 12),
        coverUrl: doc.cover_i
          ? `${this.coverBase}/b/id/${doc.cover_i}-M.jpg?default=false`
          : undefined
      }
    } catch {
      return null
    }
  }

  /** 返回封面字节，由 Repository 统一决定落盘位置 */
  async downloadCover(url: string): Promise<{ data: Uint8Array; ext: string } | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) return null
      const type = res.headers.get('content-type') || ''
      if (!type.startsWith('image/')) return null
      const data = new Uint8Array(await res.arrayBuffer())
      if (data.byteLength < 1024) return null // 过滤 1x1 占位图
      const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg'
      return { data, ext }
    } catch {
      return null
    }
  }
}
