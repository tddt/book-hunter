import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { EV } from '@shared/contract'
import type {
  CustomOpdsSource,
  OnlineBook,
  OnlineDownloadProgress,
  OnlineDownloadRequest,
  OnlineFeaturedQuery,
  OnlineFeaturedGroup,
  OnlineFeaturedResult,
  OnlineSearchQuery,
  OnlineSearchResult,
  OnlineSourceInfo,
  OnlineSourceResult
} from '@shared/types'
import type { IEventBus } from '../infra/event-bus'
import {
  absoluteUrl,
  getBuffer,
  MAX_EPUB_BYTES,
  plainText
} from '../infra/online/http'
import {
  BUILT_IN_SOURCES,
  createOpdsSource,
  DEFAULT_DISABLED_SOURCES,
  type BookSourceAdapter
} from '../infra/online/sources'
import type { ImportService } from './import.service'
import type { LibraryService } from './library.service'

interface Health {
  healthy: boolean
  latencyMs: number
  lastError?: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const name = (error as { name?: string }).name
    if (name === 'AbortError') return '已取消'
    if (name === 'TimeoutError') return '连接超时'
    const code = (error as { cause?: { code?: string } }).cause?.code
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时（该站点在当前网络不可达）'
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败'
    return error.message
  }
  return String(error)
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 80)
}

/**
 * 跨源去重：同一本公版书常同时出现在 Gutenberg / Gutendex / Standard Ebooks。
 * 保留信息更全的一条，并把其它源的下载链接合并进来作为备用通道。
 */
function dedupe(books: OnlineBook[]): OnlineBook[] {
  const map = new Map<string, OnlineBook>()
  for (const book of books) {
    const key = `${norm(book.title)}|${norm(book.authors[0] || '')}`
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...book, formats: [...book.formats] })
      continue
    }
    const formats = [...prev.formats]
    for (const f of book.formats) if (!formats.some((x) => x.url === f.url)) formats.push(f)
    const richer =
      (book.description?.length || 0) > (prev.description?.length || 0) ||
      (book.subjects.length > prev.subjects.length && !prev.subjects.length) ||
      (Boolean(book.coverUrl) && !prev.coverUrl)
    map.set(key, {
      ...prev,
      ...(richer
        ? {
            description: book.description || prev.description,
            subjects: prev.subjects.length ? prev.subjects : book.subjects,
            coverUrl: prev.coverUrl || book.coverUrl
          }
        : {}),
      formats,
      downloadable: prev.downloadable || book.downloadable
    })
  }
  return [...map.values()]
}

/**
 * 「全部」视图：按名次轮流从每个源各取一本，避免单一源刷屏；
 * 同一本书出现在多个源时按书名只保留第一次（榜单里作者拼写常不一致）。
 */
function interleave(groups: OnlineFeaturedGroup[], cap: number): OnlineBook[] {
  const seen = new Set<string>()
  const books: OnlineBook[] = []
  const max = Math.max(0, ...groups.map((g) => g.books.length))
  for (let i = 0; i < max && books.length < cap; i += 1) {
    for (const group of groups) {
      const book = group.books[i]
      if (!book) continue
      const key = norm(book.title)
      if (seen.has(key)) continue
      seen.add(key)
      books.push(book)
      if (books.length >= cap) break
    }
  }
  return books
}

async function validateEpub(data: Uint8Array): Promise<void> {
  const zip = await JSZip.loadAsync(data)
  const container = zip.file('META-INF/container.xml')
  if (!container) throw new Error('下载内容不是有效的 EPUB（缺少 META-INF/container.xml）')
  const text = await container.async('string')
  if (!/rootfile/i.test(text)) throw new Error('EPUB container.xml 内容异常')
}

/**
 * 在线取书编排层。
 *
 * 职责边界：适配器只管「找书」，本服务负责聚合去重、健康探测、封面内联、
 * 多通道下载（含下载确认页 / meta refresh 跟随）、EPUB 校验、临时文件清理、
 * 复用 ImportService 落库（自动去重 / 解析 / 建索引 / 补全元数据）。
 */
export class OnlineService {
  private readonly builtIn = new Map<string, BookSourceAdapter>(
    BUILT_IN_SOURCES.map((s) => [s.meta.id, s])
  )
  private readonly custom = new Map<string, BookSourceAdapter>()
  private readonly health = new Map<string, Health>()
  private readonly bookCache = new Map<string, OnlineBook>()
  private readonly searchCache = new Map<string, { at: number; result: OnlineSearchResult }>()
  private readonly featuredCache = new Map<string, { at: number; result: OnlineFeaturedResult }>()
  private readonly jobs = new Map<string, AbortController>()

  constructor(
    private readonly library: LibraryService,
    private readonly importer: ImportService,
    private readonly events: IEventBus
  ) {}

  async initialize(): Promise<void> {
    await this.syncCustom()
  }

  private async syncCustom(): Promise<void> {
    const settings = await this.library.getSettings()
    this.custom.clear()
    for (const source of settings.customOpdsSources || []) {
      this.custom.set(`opds:${source.id}`, createOpdsSource(source))
    }
  }

  private allAdapters(): BookSourceAdapter[] {
    return [...this.builtIn.values(), ...this.custom.values()]
  }

  private getAdapter(id: string): BookSourceAdapter | undefined {
    return this.builtIn.get(id) || this.custom.get(id)
  }

  private async disabledSet(): Promise<Set<string>> {
    const settings = await this.library.getSettings()
    return new Set(settings.disabledOnlineSources ?? DEFAULT_DISABLED_SOURCES)
  }

  async listSources(): Promise<OnlineSourceInfo[]> {
    await this.syncCustom()
    const disabled = await this.disabledSet()
    return this.allAdapters().map((adapter) => {
      const h = this.health.get(adapter.meta.id)
      return {
        ...adapter.meta,
        enabled: !disabled.has(adapter.meta.id),
        healthy: h?.healthy,
        latencyMs: h?.latencyMs,
        lastError: h?.lastError
      }
    })
  }

  /** 并发探测每个书源是否可达；结果缓存进内存，供界面显示状态 */
  async probe(ids?: string[]): Promise<OnlineSourceInfo[]> {
    await this.syncCustom()
    const targets = this.allAdapters().filter(
      (a) => !ids?.length || ids.includes(a.meta.id)
    )
    await Promise.all(
      targets.map(async (adapter) => {
        const started = Date.now()
        try {
          await adapter.probe()
          this.health.set(adapter.meta.id, { healthy: true, latencyMs: Date.now() - started })
        } catch (error) {
          this.health.set(adapter.meta.id, {
            healthy: false,
            latencyMs: Date.now() - started,
            lastError: errorMessage(error)
          })
        }
      })
    )
    return this.listSources()
  }

  /**
   * 热门书单：无需关键词，按书源分别列出官方榜单 / 目录精选。
   * 默认只用已启用的源；界面点名某源时允许查看未启用源的书单。
   * 榜单缓存 30 分钟，避免频繁请求 Gutenberg 的公开排行榜。
   */
  async featured(query: OnlineFeaturedQuery = {}): Promise<OnlineFeaturedResult> {
    const limit = Math.min(Math.max(query.limit || 24, 1), 60)
    const disabled = await this.disabledSet()
    const explicit = query.sourceIds?.length ? new Set(query.sourceIds) : null
    const key =
      `featured|${[...(explicit || [])].sort().join(',')}|${limit}|` +
      `${[...disabled].sort().join(',')}|${this.custom.size}`
    const cached = this.featuredCache.get(key)
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.result

    await this.syncCustom()
    const targets = this.allAdapters().filter(
      (a) => Boolean(a.featured) && (explicit ? explicit.has(a.meta.id) : !disabled.has(a.meta.id))
    )
    const started = Date.now()
    const settled = await Promise.allSettled(
      targets.map(async (adapter): Promise<OnlineFeaturedGroup> => {
        const t0 = Date.now()
        const books = await adapter.featured!(limit)
        return {
          sourceId: adapter.meta.id,
          label: adapter.featuredLabel || '热门书单',
          books,
          took: Date.now() - t0
        }
      })
    )
    const groups: OnlineFeaturedGroup[] = settled.map((entry, i) => {
      const adapter = targets[i]
      const label = adapter.featuredLabel || '热门书单'
      if (entry.status === 'fulfilled') {
        this.health.set(adapter.meta.id, { healthy: true, latencyMs: entry.value.took })
        return entry.value
      }
      const error = errorMessage(entry.reason)
      this.health.set(adapter.meta.id, { healthy: false, latencyMs: 0, lastError: error })
      return { sourceId: adapter.meta.id, label, books: [], took: 0, error }
    })
    for (const group of groups) {
      for (const book of group.books) this.bookCache.set(book.id, book)
    }
    // 每组只内联前 4 张封面，且并发执行，失败静默降级为占位封面
    await Promise.all(groups.map((g) => this.inlineCovers(g.books.slice(0, 4), 6000)))
    const result: OnlineFeaturedResult = {
      books: interleave(groups, limit * 4),
      groups,
      took: Date.now() - started
    }
    this.featuredCache.set(key, { at: Date.now(), result })
    return result
  }

  async search(query: OnlineSearchQuery): Promise<OnlineSearchResult> {
    const text = query.text.trim()
    if (!text) return { books: [], sources: [], took: 0 }
    const limit = query.limit || 24
    const disabled = await this.disabledSet()
    // 缓存键要包含「具体哪些源被禁用」，只记数量的话切换书源会命中过期结果
    const key = `${text}|${(query.sourceIds || []).slice().sort().join(',')}|${limit}|${[...disabled].sort().join(',')}`
    const cached = this.searchCache.get(key)
    // Gutenberg 明确要求不要高频抓取搜索页，这里做 5 分钟查询缓存
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.result

    await this.syncCustom()
    const requested = query.sourceIds?.length ? new Set(query.sourceIds) : null
    const targets = this.allAdapters().filter(
      (a) => !disabled.has(a.meta.id) && (!requested || requested.has(a.meta.id))
    )
    const started = Date.now()
    const settled = await Promise.allSettled(
      targets.map(async (adapter): Promise<OnlineSourceResult> => {
        const t0 = Date.now()
        const books = await adapter.search(text, limit)
        return { sourceId: adapter.meta.id, books, took: Date.now() - t0 }
      })
    )
    const sources: OnlineSourceResult[] = settled.map((entry, i) => {
      const sourceId = targets[i].meta.id
      if (entry.status === 'fulfilled') {
        this.health.set(sourceId, { healthy: true, latencyMs: entry.value.took })
        return entry.value
      }
      const error = errorMessage(entry.reason)
      this.health.set(sourceId, { healthy: false, latencyMs: 0, lastError: error })
      return { sourceId, books: [], took: 0, error }
    })

    const merged = dedupe(sources.flatMap((s) => s.books))
    for (const book of merged) this.bookCache.set(book.id, book)
    // 渲染层 CSP 不放行外部图片，封面由主进程取回转 data URL（只处理前 6 条，失败静默）
    await this.inlineCovers(merged.slice(0, 6))

    const result: OnlineSearchResult = {
      books: merged.slice(0, limit * 3),
      sources,
      took: Date.now() - started
    }
    this.searchCache.set(key, { at: Date.now(), result })
    return result
  }

  private async inlineCovers(books: OnlineBook[], timeoutMs = 3500): Promise<void> {
    await Promise.all(
      books.map(async (book) => {
        if (!book.coverUrl || book.coverData) return
        try {
          const res = await getBuffer(book.coverUrl, {
            timeoutMs,
            maxBytes: 400 * 1024,
            retries: 1
          })
          const mime = res.contentType.split(';')[0] || 'image/jpeg'
          if (!mime.startsWith('image/')) return
          book.coverData = `data:${mime};base64,${Buffer.from(res.data).toString('base64')}`
        } catch {
          /* 封面失败不影响下载 */
        }
      })
    )
  }

  async download(req: OnlineDownloadRequest): Promise<OnlineDownloadProgress> {
    const jobId = randomUUID()
    const controller = new AbortController()
    this.jobs.set(jobId, controller)
    const title = req.title || this.bookCache.get(req.bookId)?.title || '电子书'
    let state: OnlineDownloadProgress = {
      jobId,
      bookId: req.bookId,
      title,
      phase: 'connecting',
      received: 0,
      total: 0
    }
    const emit = (patch: Partial<OnlineDownloadProgress>): void => {
      state = { ...state, ...patch }
      this.events.emit(EV.onlineProgress, state)
    }
    emit({ phase: 'connecting' })

    let tempFile = ''
    try {
      const urls = await this.collectUrls(req, controller.signal, emit)
      if (!urls.length) throw new Error('该书没有可用的 EPUB 下载链接')
      const data = await this.downloadFirst(urls, controller.signal, emit)
      emit({ phase: 'validating', received: data.byteLength, total: data.byteLength })
      await validateEpub(data)
      emit({ phase: 'importing' })

      tempFile = join(tmpdir(), `shulie-${jobId}.epub`)
      await writeFile(tempFile, data)
      const result = await this.importer.import({
        paths: [tempFile],
        copy: true,
        categoryId: req.categoryId,
        tagIds: req.tagIds
      })
      const imported = result.books[0]
      emit({
        phase: 'done',
        message: imported
          ? `《${imported.title}》已加入书库`
          : result.skipped
            ? '该书已在书库中（已自动去重）'
            : result.failed[0]?.reason || '导入未成功',
        importedBookId: imported?.id
      })
    } catch (error) {
      emit({ phase: 'error', error: errorMessage(error) })
    } finally {
      if (tempFile) await unlink(tempFile).catch(() => undefined)
      this.jobs.delete(jobId)
    }
    return state
  }

  private async collectUrls(
    req: OnlineDownloadRequest,
    signal: AbortSignal,
    emit: (patch: Partial<OnlineDownloadProgress>) => void
  ): Promise<string[]> {
    if (req.url) {
      const url = req.url.trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http(s) 开头的 EPUB 直链')
      return [url]
    }
    let book = this.bookCache.get(req.bookId)
    if (!book) throw new Error('找不到该书，请重新搜索后再下载')
    const adapter = this.getAdapter(book.sourceId)
    if (adapter?.resolve) {
      emit({ message: '正在解析下载直链…' })
      book = await adapter.resolve(book, signal)
      this.bookCache.set(book.id, book)
    }
    const urls = book.formats.filter((f) => f.format === 'epub').map((f) => f.url)
    // 没有直链时把详情页也作为候选：fetchEpub 会从页面里挖 .epub 链接
    if (!urls.length && book.landingUrl) urls.push(book.landingUrl)
    return [...new Set(urls)]
  }

  private async downloadFirst(
    urls: string[],
    signal: AbortSignal,
    emit: (patch: Partial<OnlineDownloadProgress>) => void
  ): Promise<Uint8Array> {
    let lastError = ''
    for (const url of urls) {
      if (signal.aborted) throw new Error('已取消')
      try {
        return await this.fetchEpub(url, signal, (received, total) =>
          emit({ phase: 'downloading', received, total })
        )
      } catch (error) {
        lastError = errorMessage(error)
      }
    }
    throw new Error(`所有下载通道均失败：${lastError}`)
  }

  /**
   * 取到一个真正的 EPUB 字节流。
   * 很多站点的「下载」链接先返回确认页（meta refresh / 页面内 .epub 链接），
   * 这里最多跟随 4 跳，把这类中间页也走通。
   */
  private async fetchEpub(
    url: string,
    signal: AbortSignal,
    onProgress: (received: number, total: number) => void
  ): Promise<Uint8Array> {
    let current = url
    for (let hop = 0; hop < 4; hop += 1) {
      const res = await getBuffer(current, {
        signal,
        timeoutMs: 90000,
        maxBytes: MAX_EPUB_BYTES,
        onProgress
      })
      if (res.data.length > 4 && res.data[0] === 0x50 && res.data[1] === 0x4b) {
        return res.data
      }
      const html = new TextDecoder('utf-8').decode(res.data.subarray(0, 200000))
      const refresh = html.match(
        /http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d*\s*;?\s*url=["']?([^"'>;\s]+)/i
      )?.[1]
      const link = [...html.matchAll(/(?:href|url)\s*=\s*["']([^"']+\.epub[^"']*)["']/gi)].map(
        (m) => m[1]
      )[0]
      const next = refresh || link
      if (!next) {
        throw new Error('返回的不是 EPUB（可能是下载确认页、反爬页面或需要登录）')
      }
      current = absoluteUrl(current, plainText(next))
    }
    throw new Error('下载重定向次数过多')
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.abort()
  }

  async toggleSource(sourceId: string, enabled: boolean): Promise<OnlineSourceInfo[]> {
    const settings = await this.library.getSettings()
    const disabled = new Set(settings.disabledOnlineSources ?? DEFAULT_DISABLED_SOURCES)
    if (enabled) disabled.delete(sourceId)
    else disabled.add(sourceId)
    await this.library.saveSettings({ disabledOnlineSources: [...disabled] })
    this.searchCache.clear()
    this.featuredCache.clear()
    return this.listSources()
  }

  async saveOpds(source: CustomOpdsSource): Promise<OnlineSourceInfo[]> {
    const settings = await this.library.getSettings()
    const list = [...(settings.customOpdsSources || [])]
    const saved: CustomOpdsSource = { ...source, id: source.id || randomUUID() }
    const index = list.findIndex((s) => s.id === saved.id)
    if (index >= 0) list[index] = saved
    else list.push(saved)
    await this.library.saveSettings({ customOpdsSources: list })
    await this.syncCustom()
    this.searchCache.clear()
    this.featuredCache.clear()
    return this.listSources()
  }

  async removeOpds(id: string): Promise<OnlineSourceInfo[]> {
    const settings = await this.library.getSettings()
    const list = (settings.customOpdsSources || []).filter((s) => s.id !== id)
    await this.library.saveSettings({ customOpdsSources: list })
    await this.syncCustom()
    this.searchCache.clear()
    this.featuredCache.clear()
    return this.listSources()
  }
}
