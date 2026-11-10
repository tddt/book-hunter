/**
 * 书源适配层。
 *
 * 每个适配器只负责三件事：健康探测、把关键词翻译成目录条目、把条目补全成下载直链。
 * 聚合、去重、下载、校验、导入由 OnlineService 统一编排，新增书源不需要碰业务层。
 *
 * 合规：内置源只收录公有领域 / 明确免费授权的目录；不接入盗版站、不绕过付费或 DRM。
 * 自定义 OPDS 与 URL 直链由用户自行接入，UI 会提示仅导入自己有权获取的内容。
 */
import { XMLParser } from 'fast-xml-parser'
import type { CustomOpdsSource, OnlineBook, OnlineSourceInfo } from '@shared/types'
import { absoluteUrl, getBuffer, getJson, getText, plainText } from './http'

export type SourceMeta = Pick<
  OnlineSourceInfo,
  'id' | 'name' | 'description' | 'license' | 'homepage' | 'language' | 'builtIn'
> & { endpoint?: string }

export interface BookSourceAdapter {
  readonly meta: SourceMeta
  /** 该源热门榜的名称；有值即代表支持「无需关键词」的目录浏览 */
  readonly featuredLabel?: string
  probe(signal?: AbortSignal): Promise<void>
  search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]>
  /** 热门 / 精选书单：不依赖关键词，直接列出该源的代表性书目 */
  featured?(limit: number, signal?: AbortSignal): Promise<OnlineBook[]>
  /** 下载前补全直链：目录里只有 identifier 的源（如 Internet Archive）需要二次请求 */
  resolve?(book: OnlineBook, signal?: AbortSignal): Promise<OnlineBook>
}

interface BookPatch extends Partial<OnlineBook> {
  title: string
}

function makeBook(sourceId: string, externalId: string, patch: BookPatch): OnlineBook {
  const formats = patch.formats || []
  return {
    ...patch,
    id: `${sourceId}:${externalId}`,
    sourceId,
    externalId,
    authors: patch.authors || [],
    subjects: patch.subjects || [],
    license: patch.license || '',
    formats,
    downloadable: patch.downloadable ?? formats.length > 0
  }
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

type AnyRecord = Record<string, unknown>

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') return textOf((value as AnyRecord)['#text'])
  return ''
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  isArray: (name: string) => ['entry', 'link', 'author', 'category'].includes(name)
})

export abstract class BaseSource implements BookSourceAdapter {
  abstract readonly meta: SourceMeta
  protected abstract readonly probeUrl: string
  protected readonly probeTimeoutMs: number = 7000

  async probe(signal?: AbortSignal): Promise<void> {
    const url = this.probeUrl
      .replace(/{searchTerms}/gi, 'test')
      .replace(/{query}/gi, 'test')
    await getBuffer(url, {
      timeoutMs: this.probeTimeoutMs,
      maxBytes: 128 * 1024,
      signal
    })
  }

  abstract search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]>
}

// ---------------------------------------------------------------- Project Gutenberg

/**
 * 古登堡计划：全球最大的公有领域电子书库，EPUB 直链稳定可用。
 * 官方建议批量抓取用 catalog.rdf.bz2；这里只在用户主动搜索时发一次低频请求，
 * 且 OnlineService 对查询结果做 5 分钟缓存，避免对搜索页造成压力。
 */
class GutenbergSource extends BaseSource {
  readonly meta: SourceMeta = {
    id: 'gutenberg',
    name: 'Project Gutenberg · 古登堡计划',
    description: '7 万余本公有领域电子书，EPUB 直链下载，无需账号。',
    license: '公有领域 Public Domain',
    homepage: 'https://www.gutenberg.org',
    language: '多语言（以英文为主）',
    builtIn: true
  }
  readonly featuredLabel = '下载量 Top 100（昨日 / 7 天 / 30 天）'
  protected readonly probeUrl = 'https://www.gutenberg.org/ebooks/search/?query=test&submit_search=Go%21'

  private book(
    id: string,
    title: string,
    author: string,
    cover?: string,
    extra: Partial<OnlineBook> = {}
  ): OnlineBook {
    return makeBook('gutenberg', id, {
      ...extra,
      title,
      authors: author ? [author] : [],
      coverUrl: cover ? absoluteUrl('https://www.gutenberg.org', cover) : undefined,
      landingUrl: `https://www.gutenberg.org/ebooks/${id}`,
      license: this.meta.license,
      // 静态缓存直链优先（实测更稳），服务端按 id 生成的 EPUB 作为备用通道
      formats: [
        { format: 'epub', url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub` },
        { format: 'epub', url: `https://www.gutenberg.org/ebooks/${id}.epub?noimages` }
      ],
      ...extra
    })
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const url = `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}&submit_search=Go%21`
    const html = await getText(url, { timeoutMs: 10000, signal })
    const blocks = html.match(/<li class="booklink">[\s\S]*?<\/li>/g) || []
    const books: OnlineBook[] = []
    for (const block of blocks) {
      const id = block.match(/href="\/ebooks\/(\d+)"/)?.[1]
      const title = plainText(block.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1] || '')
      if (!id || !title) continue
      const author = plainText(block.match(/<span class="subtitle">([\s\S]*?)<\/span>/)?.[1] || '')
      const cover = block.match(/src="([^"]*cover[^"]*)"/)?.[1]
      books.push(this.book(id, title, author, cover))
      if (books.length >= limit) break
    }
    return books
  }

  /**
   * 官方公开的 Top 100 榜单页（不是搜索页，避免高频抓搜索接口）。
   * 一页含昨日 / 7 天 / 30 天三个时间窗，按出现顺序去重：昨日榜优先。
   */
  async featured(limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const html = await getText('https://www.gutenberg.org/browse/scores/top', {
      timeoutMs: 10000,
      signal
    })
    const books: OnlineBook[] = []
    const seen = new Set<string>()
    const rows = html.matchAll(
      /<li[^>]*>\s*<a href="\/ebooks\/(\d+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g
    )
    for (const [, id, raw] of rows) {
      if (seen.has(id)) continue
      seen.add(id)
      const label = plainText(raw)
      // 形如 "Pride and Prejudice by Jane Austen (7815)"
      const parts = label.match(/^([\s\S]*?)\s+by\s+([\s\S]+?)\s+\((\d+)\)\s*$/i)
      const title = (parts?.[1] || label).trim()
      if (!title) continue
      const author = (parts?.[2] || '').trim()
      books.push(
        this.book(id, title, author, `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`, {
          popularity: parts ? Number(parts[3]) : undefined,
          badge: `热门 #${books.length + 1}`
        })
      )
      if (books.length >= limit) break
    }
    return books
  }
}

// ---------------------------------------------------------------- Gutendex

interface GutendexResult {
  id: number
  title?: string
  authors?: { name?: string }[]
  languages?: string[]
  subjects?: string[]
  summaries?: string[]
  formats?: Record<string, string>
  download_count?: number
}

/** Gutendex：Gutenberg 的结构化 JSON API，字段最全，但公共实例响应偏慢 */
class GutendexSource extends BaseSource {
  readonly meta: SourceMeta = {
    id: 'gutendex',
    name: 'Gutendex · 古登堡 JSON 目录',
    description: '古登堡计划的结构化检索接口，含作者、语种、简介与封面。',
    license: '公有领域 Public Domain',
    homepage: 'https://gutendex.com',
    language: '多语言',
    builtIn: true
  }
  readonly featuredLabel = '历史下载量热门'
  protected readonly probeUrl = 'https://gutendex.com/books/?search=test'
  protected readonly probeTimeoutMs: number = 20000

  private mapDocs(docs: GutendexResult[], limit: number, featured = false): OnlineBook[] {
    const books: OnlineBook[] = []
    for (const doc of docs) {
      const epub = doc.formats?.['application/epub+zip']
      if (!epub) continue
      const cover = doc.formats?.['image/jpeg']
      const rank = books.length + 1
      books.push(
        makeBook('gutendex', String(doc.id), {
          title: doc.title || `Gutenberg #${doc.id}`,
          authors: (doc.authors || []).map((a) => a.name || '').filter(Boolean),
          language: doc.languages?.join(', '),
          description: doc.summaries?.[0]?.slice(0, 600),
          subjects: (doc.subjects || []).slice(0, 8),
          coverUrl: cover,
          landingUrl: `https://www.gutenberg.org/ebooks/${doc.id}`,
          license: this.meta.license,
          formats: [
            { format: 'epub', url: epub },
            { format: 'epub', url: `https://www.gutenberg.org/ebooks/${doc.id}.epub?noimages` }
          ],
          ...(featured
            ? { popularity: doc.download_count, badge: `热门 #${rank}` }
            : {})
        })
      )
      if (books.length >= limit) break
    }
    return books
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`
    const data = await getJson<{ results?: GutendexResult[] }>(url, {
      timeoutMs: 20000,
      signal
    })
    return this.mapDocs(data.results || [], limit)
  }

  async featured(limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    // sort=popular 是 Gutendex 现成的按累计下载量排序通道，响应比关键词检索快得多
    const data = await getJson<{ results?: GutendexResult[] }>(
      'https://gutendex.com/books/?sort=popular',
      { timeoutMs: 20000, signal }
    )
    return this.mapDocs(data.results || [], limit, true)
  }
}

// ---------------------------------------------------------------- Standard Ebooks

/** Standard Ebooks：公版书精排 EPUB，排版质量高；下载需带 ?source=download */
class StandardEbooksSource extends BaseSource {
  readonly meta: SourceMeta = {
    id: 'standard-ebooks',
    name: 'Standard Ebooks · 精排公版书',
    description: '志愿者精校排版的公有领域经典，提供多种 EPUB 版本。',
    license: '公有领域（排版 CC0）',
    homepage: 'https://standardebooks.org',
    language: '英文',
    builtIn: true
  }
  readonly featuredLabel = '最新精排上架'
  protected readonly probeUrl = 'https://standardebooks.org/ebooks?query=test'
  protected readonly probeTimeoutMs: number = 12000

  async search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const url = `https://standardebooks.org/ebooks?query=${encodeURIComponent(query)}`
    const html = await getText(url, { timeoutMs: 12000, signal })
    const blocks = html.match(/<li typeof="schema:Book"[\s\S]*?<\/li>/g) || []
    const books: OnlineBook[] = []
    for (const block of blocks) {
      const path = block.match(/about="(\/ebooks\/[a-z0-9-]+\/[a-z0-9-]+)"/)?.[1]
      if (!path) continue
      const title = plainText(
        block.match(/<span property="schema:name">([\s\S]*?)<\/span>/)?.[1] || ''
      )
      if (!title) continue
      const author = plainText(
        block.match(/<p class="author"[\s\S]*?<span property="schema:name">([\s\S]*?)<\/span>/)?.[1] || ''
      )
      const cover = block.match(/<img src="([^"]+)"/)?.[1]
      // /ebooks/<author-slug>/<book-slug> -> <author-slug>_<book-slug>.epub
      const parts = path.split('/')
      const authorSlug = parts[2] || ''
      const bookSlug = parts[3] || ''
      const file = `${authorSlug}_${bookSlug}.epub`
      const direct = `https://standardebooks.org${path}/downloads/${file}`
      books.push(
        makeBook('standard-ebooks', path, {
          title,
          authors: author ? [author] : [],
          coverUrl: cover ? absoluteUrl('https://standardebooks.org', cover) : undefined,
          landingUrl: `https://standardebooks.org${path}`,
          license: this.meta.license,
          formats: [
            { format: 'epub', url: `${direct}?source=download` },
            { format: 'epub', url: direct }
          ]
        })
      )
      if (books.length >= limit) break
    }
    return books
  }

  /** 目录首页本身就是按上架时间排列的精选清单，空关键词即可列出 */
  async featured(limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const books = await this.search('', limit, signal)
    return books.map((book, i) => ({ ...book, badge: `新上架 #${i + 1}` }))
  }

  /** 若按规则拼出的文件名 404，回到详情页把真实 .epub 链接挖出来 */
  async resolve(book: OnlineBook, signal?: AbortSignal): Promise<OnlineBook> {
    if (!book.landingUrl || !book.formats.length) return book
    try {
      const html = await getText(book.landingUrl, { timeoutMs: 10000, signal })
      const links = [...html.matchAll(/href="([^"]+\.epub[^"]*)"/gi)]
        .map((m) => absoluteUrl('https://standardebooks.org', m[1]))
        .filter((u) => !/_advanced|\.kepub\./.test(u))
      const extra = links.map((url) => ({ format: 'epub' as const, url: `${url}?source=download` }))
      return { ...book, formats: [...book.formats, ...extra] }
    } catch {
      return book
    }
  }
}

// ---------------------------------------------------------------- Open Library

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
  ia?: string[]
  ebook_access?: string
}

/**
 * Open Library：只取标注为 public / preread 的可下载条目，
 * 借阅（borrowable）条目不提供下载，避免触碰受版权保护的借阅内容。
 */
class OpenLibrarySource extends BaseSource {
  readonly meta: SourceMeta = {
    id: 'open-library',
    name: 'Open Library · 开放图书馆',
    description: '互联网档案馆的图书目录，仅列出标记为可公开下载的公版书。',
    license: '公有领域 / 开放获取（以条目标注为准）',
    homepage: 'https://openlibrary.org',
    language: '多语言',
    builtIn: true
  }
  protected readonly probeUrl = 'https://openlibrary.org/search.json?q=test&limit=1&fields=key'

  readonly featuredLabel = '公开下载热门'
  private static readonly fields =
    'key,title,author_name,first_publish_year,publisher,isbn,cover_i,subject,language,ia,ebook_access'

  private mapDocs(docs: OpenLibraryDoc[], limit: number, featured = false): OnlineBook[] {
    const books: OnlineBook[] = []
    for (const doc of docs) {
      const access = (doc.ebook_access || '').toLowerCase()
      if (access !== 'public' && access !== 'preread') continue
      const ia = doc.ia?.[0]
      if (!ia) continue
      books.push(
        makeBook('open-library', doc.key || doc.title || ia, {
          title: doc.title || '未命名',
          authors: (doc.author_name || []).slice(0, 4),
          publisher: doc.publisher?.[0],
          published: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
          subjects: (doc.subject || []).slice(0, 8),
          language: doc.language?.join(', '),
          coverUrl: doc.cover_i
            ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg?default=false`
            : undefined,
          landingUrl: doc.key ? `https://openlibrary.org${doc.key}` : undefined,
          license: this.meta.license,
          formats: [{ format: 'epub', url: `https://archive.org/download/${ia}/${ia}.epub` }],
          downloadable: true,
          ...(featured ? { badge: `热门 #${books.length + 1}` } : {})
        })
      )
      if (books.length >= limit) break
    }
    return books
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const url =
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}` +
      `&limit=${Math.max(limit * 2, 20)}&fields=${OpenLibrarySource.fields}`
    const data = await getJson<{ docs?: OpenLibraryDoc[] }>(url, { timeoutMs: 12000, signal })
    return this.mapDocs(data.docs || [], limit)
  }

  async featured(limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const url =
      `https://openlibrary.org/search.json?q=ebook_access:public&sort=readinglog` +
      `&limit=${Math.max(limit * 2, 30)}&fields=${OpenLibrarySource.fields}`
    const data = await getJson<{ docs?: OpenLibraryDoc[] }>(url, { timeoutMs: 12000, signal })
    return this.mapDocs(data.docs || [], limit, true)
  }

  /** 用 Internet Archive metadata 找出该条目真实的 .epub 文件名 */
  async resolve(book: OnlineBook, signal?: AbortSignal): Promise<OnlineBook> {
    const match = book.formats[0]?.url.match(/archive\.org\/download\/([^/]+)\//)
    if (!match) return book
    const id = match[1]
    try {
      const data = await getJson<{ files?: { name?: string; size?: string }[] }>(
        `https://archive.org/metadata/${id}`,
        { timeoutMs: 12000, signal }
      )
      const files = (data.files || [])
        .filter((f) => /\.epub$/i.test(f.name || ''))
        .sort((a, b) => Number(a.size || 0) - Number(b.size || 0))
      const urls = files.map((f) => ({
        format: 'epub' as const,
        url: `https://archive.org/download/${id}/${encodeURIComponent(f.name || '')}`
      }))
      return { ...book, formats: [...urls, ...book.formats], downloadable: urls.length > 0 || book.downloadable }
    } catch {
      return book
    }
  }
}

// ---------------------------------------------------------------- Internet Archive

interface IaDoc {
  identifier?: string
  title?: string
  creator?: string | string[]
}

/** Internet Archive：海量公版扫描书，但只有部分条目提供 EPUB，需要二次查询 metadata */
class InternetArchiveSource extends BaseSource {
  readonly meta: SourceMeta = {
    id: 'internet-archive',
    name: 'Internet Archive · 互联网档案馆',
    description: '公共领域文本库，自动筛选含 EPUB 格式的条目。',
    license: '公有领域 / 开放获取（以条目标注为准）',
    homepage: 'https://archive.org',
    language: '多语言',
    builtIn: true
  }
  protected readonly probeUrl =
    'https://archive.org/advancedsearch.php?q=test%20AND%20mediatype%3Atexts&rows=1&output=json'

  readonly featuredLabel = '高下载量公版书'

  private mapDocs(docs: IaDoc[], limit: number, featured = false): OnlineBook[] {
    const books: OnlineBook[] = []
    for (const d of docs) {
      if (!d.identifier) continue
      books.push(
        makeBook('internet-archive', d.identifier, {
          title: d.title || d.identifier || '未命名',
          authors: asArray(d.creator).map(String).slice(0, 3),
          landingUrl: `https://archive.org/details/${d.identifier}`,
          license: this.meta.license,
          formats: [],
          downloadable: true,
          ...(featured ? { badge: `热门 #${books.length + 1}` } : {})
        })
      )
      if (books.length >= limit) break
    }
    return books
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const q = `${query} AND mediatype:texts`
    const url =
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator' +
      `&rows=${Math.max(limit, 10)}&page=1&output=json`
    const data = await getJson<{ response?: { docs?: IaDoc[] } }>(url, {
      timeoutMs: 12000,
      signal
    })
    return this.mapDocs(data.response?.docs || [], limit)
  }

  async featured(limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const q = 'mediatype:texts AND format:(EPUB)'
    const url =
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator' +
      '&sort%5B%5D=downloads+desc' +
      `&rows=${Math.max(limit, 10)}&page=1&output=json`
    const data = await getJson<{ response?: { docs?: IaDoc[] } }>(url, {
      timeoutMs: 12000,
      signal
    })
    return this.mapDocs(data.response?.docs || [], limit, true)
  }

  async resolve(book: OnlineBook, signal?: AbortSignal): Promise<OnlineBook> {
    try {
      const data = await getJson<{ files?: { name?: string; size?: string }[] }>(
        `https://archive.org/metadata/${book.externalId}`,
        { timeoutMs: 12000, signal }
      )
      const files = (data.files || [])
        .filter((f) => /\.epub$/i.test(f.name || ''))
        .sort((a, b) => Number(a.size || 0) - Number(b.size || 0))
      const formats = files.map((f) => ({
        format: 'epub' as const,
        url: `https://archive.org/download/${book.externalId}/${encodeURIComponent(f.name || '')}`
      }))
      return { ...book, formats, downloadable: formats.length > 0 }
    } catch {
      return book
    }
  }
}

// ---------------------------------------------------------------- 通用 OPDS

/**
 * 通用 OPDS 1.x 目录适配器。
 * 支持 OpenSearch 模板（{searchTerms} / {query}），没有模板时拉首页 feed 做本地筛选。
 * 用户可添加任意可达的 OPDS 目录，覆盖本项目未内置的公版书库。
 */
export class OpdsSource extends BaseSource {
  readonly meta: SourceMeta
  readonly featuredLabel = '目录首页精选'

  constructor(
    private readonly endpoint: string,
    meta?: Partial<SourceMeta>
  ) {
    super()
    this.meta = {
      id: meta?.id || 'opds-custom',
      name: meta?.name || '自定义 OPDS 目录',
      description: meta?.description || '用户自行添加的 OPDS 目录，内容授权由该目录负责。',
      license: meta?.license || '以该目录标注的授权为准',
      homepage: meta?.homepage || endpoint,
      language: meta?.language || '不限',
      builtIn: meta?.builtIn ?? false,
      endpoint
    }
  }

  protected get probeUrl(): string {
    return this.endpoint.replace(/{searchTerms}/gi, 'test').replace(/{query}/gi, 'test')
  }
  protected readonly probeTimeoutMs: number = 12000

  private get hasTemplate(): boolean {
    return /{searchTerms}|{query}/i.test(this.endpoint)
  }

  /** OPDS 首页就是一份现成书单；带搜索模板的源用空关键词取默认结果 */
  async featured(limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const books = await this.search('', limit, signal)
    return books.map((book, i) => ({ ...book, badge: `目录 #${i + 1}` }))
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<OnlineBook[]> {
    const url = this.endpoint
      .replace(/{searchTerms}/gi, encodeURIComponent(query))
      .replace(/{query}/gi, encodeURIComponent(query))
    const xml = await getText(url, { timeoutMs: 12000, signal })
    const parsed = xmlParser.parse(xml) as AnyRecord
    const feed = (parsed.feed || parsed) as AnyRecord
    const entries = asArray<AnyRecord>(feed.entry as AnyRecord | AnyRecord[] | undefined)
    const needle = query.trim().toLowerCase()
    const books: OnlineBook[] = []

    for (const entry of entries) {
      const title = textOf(entry.title)
      if (!title) continue
      const authors = asArray<AnyRecord>(entry.author as AnyRecord | AnyRecord[] | undefined)
        .map((a) => textOf(a.name))
        .filter(Boolean)
      if (needle && !this.hasTemplate && !`${title} ${authors.join(' ')}`.toLowerCase().includes(needle)) {
        continue
      }
      const links = asArray<AnyRecord>(entry.link as AnyRecord | AnyRecord[] | undefined)
      const attr = (link: AnyRecord, key: string): string => String(link[`@_${key}`] || '')
      const epub = links.filter(
        (l) => /epub/i.test(attr(l, 'type')) || /\.epub(\?|$)/i.test(attr(l, 'href'))
      )
      const cover = links.find(
        (l) => /image|thumbnail|cover/i.test(`${attr(l, 'rel')} ${attr(l, 'type')}`)
      )
      const alternate = links.find((l) => /alternate/i.test(attr(l, 'rel')))
      const externalId = textOf(entry.id) || title
      books.push(
        makeBook(this.meta.id, externalId, {
          title,
          authors,
          description: textOf(entry.summary || entry.content)?.slice(0, 600),
          subjects: asArray<AnyRecord>(entry.category as AnyRecord | AnyRecord[] | undefined)
            .map((c) => String(c['@_label'] || c['@_term'] || textOf(c)))
            .filter(Boolean)
            .slice(0, 8),
          coverUrl: cover ? absoluteUrl(url, attr(cover, 'href')) : undefined,
          landingUrl: alternate ? absoluteUrl(url, attr(alternate, 'href')) : undefined,
          license: this.meta.license,
          formats: epub.map((l) => ({ format: 'epub' as const, url: absoluteUrl(url, attr(l, 'href')) }))
        })
      )
      if (books.length >= limit) break
    }
    return books
  }
}

export function createOpdsSource(custom: CustomOpdsSource): BookSourceAdapter {
  return new OpdsSource(custom.endpoint, {
    id: `opds:${custom.id}`,
    name: custom.name,
    homepage: custom.endpoint,
    builtIn: false,
    endpoint: custom.endpoint,
    license: '以该目录标注的授权为准',
    description: '用户自行添加的 OPDS 目录'
  })
}

/** 内置书源。慢 / 常不可达的源默认关闭，用户可在界面里一键开启 */
export const BUILT_IN_SOURCES: BookSourceAdapter[] = [
  new GutenbergSource(),
  new GutendexSource(),
  new StandardEbooksSource(),
  new OpenLibrarySource(),
  new InternetArchiveSource()
]

/** 默认关闭：探测显示当前网络不可达时避免拖慢每次搜索 */
export const DEFAULT_DISABLED_SOURCES = ['open-library', 'internet-archive', 'gutendex']

/** 界面里可一键添加的公共 OPDS 预设（不默认启用，用户自行探测可用性） */
export const OPDS_PRESETS: { name: string; endpoint: string }[] = [
  { name: 'Standard Ebooks OPDS', endpoint: 'https://standardebooks.org/opds/all' },
  { name: 'Feedbooks 公版目录', endpoint: 'https://catalog.feedbooks.com/publicdomain/browse.en.atom' },
  { name: 'ManyBooks OPDS', endpoint: 'https://manybooks.net/opds' }
]
