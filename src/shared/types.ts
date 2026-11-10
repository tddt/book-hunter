/**
 * 领域模型：主进程 / 预加载 / 渲染进程共享的唯一事实来源。
 * 这一层不依赖 Electron、不依赖任何运行时库，可被任意基础设施实现复用。
 */

export type ID = string
export type ReadingStatus = 'unread' | 'reading' | 'finished'
export type ReaderThemeId = 'paper' | 'sepia' | 'green' | 'ink' | 'night'

/** 全局外观（应用外壳）；阅读器正文章节用独立的 ReaderThemeId，两者可分别调整 */
export type ThemeMode = 'light' | 'dark' | 'system'

// ---------------------------------------------------------------- 书库

export interface Book {
  id: ID
  title: string
  authors: string[]
  publisher?: string
  published?: string
  language?: string
  isbn?: string
  description?: string
  /** 在线补全得到的学科词，仅用于展示与检索，不与用户自定义 Tag 混用 */
  subjects: string[]
  /** 章节标题拼接文本（截断），用于「目录名」也能被搜到 */
  tocText?: string
  /** 封面文件名，相对 covers 目录；通过 book://local/covers/<cover> 访问 */
  cover?: string
  /** 书库内文件名 / 绝对路径（copyOnImport=false 时指向原始路径） */
  fileName: string
  filePath: string
  originalPath: string
  fileSize: number
  /** 文件前 1MB + 尺寸计算的指纹，用于去重 */
  hash: string
  addedAt: number
  updatedAt: number
  categoryId?: ID
  tagIds: ID[]
  rating: number
  favorite: boolean
  status: ReadingStatus
  lastReadAt?: number
  chapterCount: number
  metadataSource: 'opf' | 'online' | 'merged'
  /** 正文文本缓存是否就绪（contentSearch 开启时生成） */
  textCached: boolean
}

export interface Category {
  id: ID
  name: string
  color: string
  parentId?: ID
  order: number
  createdAt: number
}

export interface Tag {
  id: ID
  name: string
  color: string
  createdAt: number
}

// ---------------------------------------------------------------- 阅读

/**
 * 自研阅读引擎的定位模型（替代 epub.js 的 CFI）。
 * 基于「章节序号 + 页序 / 章内字符偏移」，不依赖原书 DOM 结构，
 * 换字体、换窗口尺寸后依然能精确定位。
 */
export interface ReaderLocator {
  chapterIndex: number
  /** 分页模式下的页序号（0 基） */
  page: number
  /** 章内字符偏移（0~1 的插值位置由 percent 表示） */
  percent: number
  /** 选区在章节纯文本中的起止字符偏移，用于划线 / 笔记 */
  range?: { start: number; end: number }
}

/** 定位键：序列化后仍存进历史字段 cfi，保持旧数据结构不用迁移 */
export type LocatorKey = string

export interface ReadingProgress {
  bookId: ID
  cfi: string
  locator?: ReaderLocator
  percentage: number
  chapterIndex: number
  chapterTitle: string
  /** 页码信息，仅用于书架展示 */
  page?: number
  pages?: number
  updatedAt: number
}

export interface Bookmark {
  id: ID
  bookId: ID
  cfi: string
  locator?: ReaderLocator
  percentage: number
  excerpt: string
  createdAt: number
}

export interface Note {
  id: ID
  bookId: ID
  cfi: string
  locator?: ReaderLocator
  percentage: number
  excerpt: string
  text: string
  color: string
  createdAt: number
  updatedAt: number
}

export interface ReaderSettings {
  theme: ReaderThemeId
  fontSize: number
  lineHeight: number
  paragraphSpacing: number
  /** 版心（文字区）最大宽度，px；窗口更窄时自动收缩 */
  lineWidth: number
  /** 页边距：版心外的水平留白，px */
  pageMargin: number
  fontFamily: string
  /** 中文首行缩进 */
  textIndent: boolean
  /** 两端对齐 */
  justify: boolean
  pageMode: 'paginated' | 'scrolled'
  animation: 'slide' | 'fade' | 'none'
  /** 宽屏是否并排显示两页 */
  spread: 'none' | 'auto'
}

// ---------------------------------------------------------------- EPUB 解析

export interface TocItem {
  id: string
  label: string
  href: string
  level: number
  children: TocItem[]
}

export interface ParsedChapter {
  index: number
  href: string
  title: string
  text: string
}

export interface EpubMetadata {
  title: string
  authors: string[]
  publisher?: string
  published?: string
  language?: string
  isbn?: string
  description?: string
  subjects: string[]
  coverHref?: string
}

export interface ParsedEpub {
  meta: EpubMetadata
  toc: TocItem[]
  chapters: ParsedChapter[]
  cover?: { data: Uint8Array; ext: string }
  spineHrefs: string[]
}

/** 缓存到磁盘的正文（避免检索时反复解压 EPUB） */
export interface BookContent {
  bookId: ID
  chapters: ParsedChapter[]
  toc: TocItem[]
}

// ---------------------------------------------------------------- 搜索

export type SearchSource = 'metadata' | 'content'

export interface SearchHit {
  bookId: ID
  title: string
  authors: string[]
  cover?: string
  score: number
  source: SearchSource
  /** 正文命中片段（已做关键词上下文截取） */
  snippet?: string
  chapterIndex?: number
  chapterTitle?: string
  /** 命中在章节纯文本中的字符偏移，用于阅读器翻到命中所在页 */
  offset?: number
  matched: string[]
}

export interface SearchResult {
  hits: SearchHit[]
  took: number
  /** 正文命中的总处数（限量截断之前） */
  contentTotal: number
  /** 结果是否因限量被截断 */
  truncated: boolean
  /** 当前可参与正文检索的书数量 */
  searchableBooks: number
  /** 给用户看的诊断提示（未开启正文检索 / 缓存缺失等） */
  hint?: string
}

/** 为已有书补建正文文本缓存的结果 */
export interface ContentCacheResult {
  built: number
  skipped: number
  failed: number
}

export interface SearchQuery {
  text: string
  categoryId?: ID
  tagIds?: ID[]
  status?: ReadingStatus
  favoriteOnly?: boolean
  /** 是否检索正文，默认跟随设置 */
  content?: boolean
  limit?: number
}

export interface SearchProgress {
  phase: 'index' | 'content' | 'done'
  done: number
  total: number
}

// ---------------------------------------------------------------- 导入

export interface ImportOptions {
  paths: string[]
  categoryId?: ID
  tagIds?: ID[]
  copy?: boolean
}

export interface ImportResult {
  books: Book[]
  skipped: number
  failed: { path: string; reason: string }[]
  /** 2.0：非 EPUB 格式转码时的降级提示，不影响导入成功 */
  warnings?: { path: string; message: string }[]
}

export interface ImportProgress {
  current: number
  total: number
  fileName: string
  phase: 'parse' | 'convert' | 'store' | 'index' | 'metadata'
}

// ---------------------------------------------------------------- 格式工具（2.0）

export type TxtToEpubMode = 'merge' | 'separate'
export type TxtEncodingOption = 'auto' | 'utf8' | 'gb18030' | 'utf16le'

export interface TxtToEpubOptions {
  paths: string[]
  /** 输出目录；为空时由主进程让用户选择 */
  outputDir: string
  /** merge：多本合成一卷本；separate：每个 txt 各生成一本 */
  mode: TxtToEpubMode
  /** merge 模式下的书名 / 作者 */
  title?: string
  author?: string
  encoding?: TxtEncodingOption
  detectChapters?: boolean
}

export interface TxtToEpubOutput {
  path: string
  title: string
  chapters: number
  bytes: number
  warnings: string[]
}

export type TxtToEpubStage = 'scan' | 'read' | 'parse' | 'build' | 'verify' | 'write' | 'merge'

export interface TxtToEpubResult {
  outputs: TxtToEpubOutput[]
  failed: { path: string; reason: string; stage?: TxtToEpubStage }[]
  /** 本次转换的整体结论，UI 直接展示，避免只弹一个空泛的「转换失败」 */
  message?: string
}

// ---------------------------------------------------------------- 设置 / 快照

export interface AppSettings {
  reader: ReaderSettings
  /** 全局外观；旧快照没有此字段时按 light 处理，保证升级不突变 */
  theme?: ThemeMode
  autoMetadata: boolean
  contentSearch: boolean
  copyOnImport: boolean
  viewMode: 'grid' | 'list'
  sortBy: 'addedAt' | 'title' | 'lastReadAt' | 'rating'
  libraryDir?: string
  /** 用户自定义的 OPDS 书源（自定义源统一持久化在书库快照里） */
  customOpdsSources?: CustomOpdsSource[]
  /** 被用户关闭的内置书源 id */
  disabledOnlineSources?: string[]
  /** 对照翻译偏好（书源开关、语言、展示方式） */
  translation?: TranslationSettings
}

export interface LibrarySnapshot {
  version: number
  books: Book[]
  categories: Category[]
  tags: Tag[]
  progresses: Record<ID, ReadingProgress>
  bookmarks: Bookmark[]
  notes: Note[]
  settings: AppSettings
}

/** 供渲染进程使用的运行时环境信息 */
export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  isDev: boolean
  dataDir: string
  libraryDir: string
  /** 文件关联当前是否已注册 */
  associated: boolean
}

export interface MetadataPatch {
  title?: string
  authors?: string[]
  publisher?: string
  published?: string
  isbn?: string
  description?: string
  subjects?: string[]
  cover?: string
}

// ---------------------------------------------------------------- 在线取书
//
// 合规边界：内置书源只收录「公有领域 / 明确免费授权」的目录；
// 不接入盗版站点、不绕过付费墙或 DRM。自定义 OPDS 与 URL 直链由用户自行负责，
// UI 会明确提示仅用于自己有权获取的内容。

export interface OnlineSourceInfo {
  id: string
  name: string
  description: string
  /** 版权 / 授权说明，UI 必须展示 */
  license: string
  homepage: string
  language: string
  builtIn: boolean
  enabled: boolean
  /** 最近一次健康探测结果 */
  healthy?: boolean
  latencyMs?: number
  lastError?: string
  /** 自定义 OPDS 源的入口地址 */
  endpoint?: string
}

export interface OnlineFormat {
  format: 'epub' | 'pdf' | 'other'
  url: string
  size?: number
}

export interface OnlineBook {
  /** `${sourceId}:${externalId}`，跨源去重与下载任务的唯一键 */
  id: string
  sourceId: string
  externalId: string
  title: string
  authors: string[]
  language?: string
  publisher?: string
  published?: string
  description?: string
  subjects: string[]
  coverUrl?: string
  /** 主进程把封面取回并内联成 data URL，绕过渲染层 CSP 的外部图片限制 */
  coverData?: string
  landingUrl?: string
  license: string
  formats: OnlineFormat[]
  /** 是否存在可直接下载的 EPUB */
  downloadable: boolean
  /** 热门榜用：下载量 / 热度（不同源口径不同，只用于展示与排序） */
  popularity?: number
  /** 热门榜用：榜单名次或榜单说明，例如「昨日 #3」 */
  badge?: string
}

export interface OnlineSearchQuery {
  text: string
  sourceIds?: string[]
  limit?: number
}

/** 热门书单请求；指定 sourceIds 时允许查看未启用的书源（用户主动点名） */
export interface OnlineFeaturedQuery {
  sourceIds?: string[]
  limit?: number
}

/** 每个书源一份独立榜单，界面按源切换，不做跨源去重 */
export interface OnlineFeaturedGroup {
  sourceId: string
  label: string
  books: OnlineBook[]
  took: number
  error?: string
}

export interface OnlineFeaturedResult {
  /** 「全部」视图：跨源去重后按源交错排列，避免一个源刷屏 */
  books: OnlineBook[]
  groups: OnlineFeaturedGroup[]
  took: number
}

export interface OnlineSourceResult {
  sourceId: string
  books: OnlineBook[]
  took: number
  error?: string
}

export interface OnlineSearchResult {
  books: OnlineBook[]
  sources: OnlineSourceResult[]
  took: number
}

export interface OnlineDownloadRequest {
  bookId: string
  /** 覆盖下载链接：用于「URL 直链导入」或自定义源 */
  url?: string
  title?: string
  categoryId?: ID
  tagIds?: ID[]
}

export interface OnlineDownloadProgress {
  jobId: string
  bookId: string
  title: string
  phase: 'connecting' | 'downloading' | 'validating' | 'importing' | 'done' | 'error'
  received: number
  total: number
  message?: string
  importedBookId?: ID
  error?: string
}

export interface CustomOpdsSource {
  id: ID
  name: string
  endpoint: string
  enabled: boolean
}

// ---------------------------------------------------------------- 对照翻译
//
// 只调用各厂商面向公众免费开放、无需 API Key 的网页翻译通道；
// 低频、个人阅读用途，遵守各站频率限制，不伪造付费凭证、不绕过鉴权。
// 所有请求都由主进程发起（渲染层 CSP 不放行外部 connect-src）。

export type TranslationProviderId = 'tencent' | 'bing' | 'mymemory' | 'google' | 'libre'
export type TranslationDisplayMode = 'bilingual' | 'translation' | 'original'

export interface TranslationLanguage {
  id: string
  name: string
}

export interface TranslationSettings {
  /** 主目标语言 */
  targetLang: string
  /** 第二对照语言，空字符串表示关闭 */
  secondaryLang: string
  displayMode: TranslationDisplayMode
  /** 首选通道，失败时按启用顺序自动回退 */
  preferredProvider: TranslationProviderId
  /** 被关闭的通道 id */
  disabledProviders: TranslationProviderId[]
  /** 切章时自动翻译当前章 */
  autoTranslate: boolean
  /** 自建 LibreTranslate 兼容端点（留空则不启用该通道） */
  customEndpoint: string
}

export interface TranslationProviderInfo {
  id: TranslationProviderId
  name: string
  description: string
  homepage: string
  /** 免费/授权说明，UI 必须展示 */
  license: string
  builtIn: boolean
  enabled: boolean
  healthy?: boolean
  latencyMs?: number
  lastError?: string
  /** 单次请求的文本字符上限 */
  maxChars: number
  /** 单次可批量翻译的段数 */
  batchSize: number
}

export interface TranslateText {
  id: string
  text: string
}

export interface TranslateRequest {
  jobId: string
  bookId: ID
  chapterIndex: number
  targetLang: string
  /** 'auto' 或具体语言 id；缺省为 auto */
  sourceLang?: string
  /** 指定通道；不指定时按首选 + 启用顺序自动回退 */
  providerId?: TranslationProviderId
  texts: TranslateText[]
  /** 忽略已有缓存强制重译 */
  force?: boolean
}

export interface TranslatedSegment {
  id: string
  translation: string
  providerId?: TranslationProviderId
  cached: boolean
}

export interface TranslateResult {
  jobId: string
  chapterIndex: number
  targetLang: string
  detectedLanguage?: string
  /** 实际成功使用的通道（可能多个，回退时按使用顺序） */
  usedProviders: TranslationProviderId[]
  segments: TranslatedSegment[]
  errors: { id: string; message: string }[]
  took: number
  cached: number
  translated: number
  cancelled: boolean
}

export interface TranslateProgress {
  jobId: string
  phase: 'translating' | 'done' | 'error'
  done: number
  total: number
  providerId?: TranslationProviderId
  message?: string
}
