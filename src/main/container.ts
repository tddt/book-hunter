import { JsonRepository, type IRepository } from './infra/repository'
import { WindowEventBus, type IEventBus } from './infra/event-bus'
import { MiniSearchIndex, type ISearchIndex } from './infra/search-index'
import { TextCacheScanner, type IContentScanner } from './infra/content-scanner'
import { ZipEpubParser, type IEpubParser } from './infra/epub-parser'
import { MetadataClient } from './infra/http'
import { PATHS } from './env'
import { LibraryService } from './services/library.service'
import { MetadataService } from './services/metadata.service'
import { ImportService } from './services/import.service'
import { SearchService } from './services/search.service'
import { ReaderService } from './services/reader.service'
import { OnlineService } from './services/online.service'
import { TranslationService } from './services/translation.service'
import { ToolsService } from './services/tools.service'

/**
 * 组合根（Composition Root）：全应用唯一一处「把实现装配起来」的地方。
 * 所有服务只依赖接口，替换存储 / 索引 / 解析器 / 在线书源时只改这里。
 */
export interface Container {
  events: IEventBus
  repo: IRepository
  parser: IEpubParser
  index: ISearchIndex
  scanner: IContentScanner
  library: LibraryService
  metadata: MetadataService
  importer: ImportService
  search: SearchService
  reader: ReaderService
  online: OnlineService
  translation: TranslationService
  tools: ToolsService
}

/** 启动阶段回调：让启动屏显示真实进度，而不是一段假动画。不传时零开销。 */
export type BootstrapProgress = (label: string, percent: number) => void

export async function createContainer(onProgress: BootstrapProgress = () => undefined): Promise<Container> {
  onProgress('读取书库数据…', 10)
  const events: IEventBus = new WindowEventBus()
  const repo: IRepository = new JsonRepository()
  await repo.init()

  onProgress('装配领域服务…', 22)
  const index: ISearchIndex = new MiniSearchIndex(PATHS.index)
  const scanner: IContentScanner = new TextCacheScanner(repo)
  const parser: IEpubParser = new ZipEpubParser()
  const client = new MetadataClient()

  const library = new LibraryService(repo, index, events)
  const metadata = new MetadataService(repo, client, library, events)
  const importer = new ImportService(repo, parser, index, events, metadata)
  const search = new SearchService(repo, index, scanner, events, parser)
  const reader = new ReaderService(repo)

  onProgress('准备在线书源…', 34)
  const online = new OnlineService(library, importer, events)
  await online.initialize()

  onProgress('准备翻译缓存…', 46)
  const translation = new TranslationService(library, events, PATHS.translationCache)
  await translation.initialize()

  const tools = new ToolsService(parser)

  // 索引与书库对齐（首次启动会完整建索引）
  onProgress('建立全文索引…', 60)
  await search.initialize()
  onProgress('书库就绪', 76)

  return {
    events, repo, parser, index, scanner,
    library, metadata, importer, search, reader, online, translation, tools
  }
}
