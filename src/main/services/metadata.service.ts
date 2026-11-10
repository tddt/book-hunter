import { setTimeout as delay } from 'node:timers/promises'
import type { IRepository } from '../infra/repository'
import { MetadataClient } from '../infra/http'
import type { IEventBus } from '../infra/event-bus'
import type { LibraryService } from './library.service'
import type { IMetadataEnricher } from './import.service'
import { EV } from '@shared/contract'
import type { MetadataPatch } from '@shared/types'

/**
 * 在线元数据补全（Open Library）。
 * 合并策略：本地 OPF 数据优先，只补空字段；封面仅在本地缺失时下载。
 * 任何网络失败都静默降级为「仅本地元数据」，不影响导入与阅读。
 */
export class MetadataService implements IMetadataEnricher {
  constructor(
    private readonly repo: IRepository,
    private readonly client: MetadataClient,
    private readonly library: LibraryService,
    private readonly events: IEventBus
  ) {}

  async enrich(bookIds: string[]): Promise<void> {
    for (const id of bookIds) {
      try {
        await this.refresh(id)
      } catch {
        // 单本失败不影响后续
      }
      // 公共 API 限速，避免批量导入时打爆请求
      await delay(180)
    }
  }

  async refresh(bookId: string): Promise<MetadataPatch | null> {
    const snapshot = await this.repo.snapshot()
    const book = snapshot.books.find((b) => b.id === bookId)
    if (!book) return null

    const online = await this.client.lookup({
      title: book.title,
      authors: book.authors,
      isbn: book.isbn
    })
    if (!online) return null

    const patch: MetadataPatch = {}
    if (!book.authors.length && online.authors?.length) patch.authors = online.authors
    if (!book.publisher && online.publisher) patch.publisher = online.publisher
    if (!book.published && online.published) patch.published = online.published
    if (!book.isbn && online.isbn) patch.isbn = online.isbn
    if (!book.description && online.description) patch.description = online.description

    const subjects = [...new Set([...book.subjects, ...(online.subjects || [])])].slice(0, 20)
    if (subjects.length !== book.subjects.length) patch.subjects = subjects

    if (!book.cover && online.coverUrl) {
      const image = await this.client.downloadCover(online.coverUrl)
      if (image) patch.cover = await this.repo.writeCover(bookId, image.data, image.ext)
    }

    if (Object.keys(patch).length === 0) return null
    await this.library.update(bookId, { ...patch, metadataSource: 'merged' })
    this.events.emit(EV.metadataUpdated, { bookId, patch })
    return patch
  }
}
