/**
 * IPC 强类型契约。
 * 主进程 handler、preload 桥接、渲染进程调用三端共用这一份映射，
 * 新增接口只需在此登记一次，编译期即可发现通道名 / 参数 / 返回值的错配。
 */
import type {
  AppInfo,
  AppSettings,
  Book,
  BookContent,
  Bookmark,
  Category,
  ContentCacheResult,
  CustomOpdsSource,
  ID,
  ImportOptions,
  ImportProgress,
  ImportResult,
  LibrarySnapshot,
  MetadataPatch,
  Note,
  OnlineDownloadProgress,
  OnlineDownloadRequest,
  OnlineFeaturedQuery,
  OnlineFeaturedResult,
  OnlineSearchQuery,
  OnlineSearchResult,
  OnlineSourceInfo,
  ReadingProgress,
  SearchProgress,
  SearchQuery,
  SearchResult,
  Tag,
  ThemeMode,
  TranslateProgress,
  TxtToEpubOptions,
  TxtToEpubResult,
  TranslateRequest,
  TranslateResult,
  TranslationLanguage,
  TranslationProviderId,
  TranslationProviderInfo
} from './types'

export const CH = {
  appReady: 'app:ready',
  appInfo: 'app:info',
  libraryList: 'library:list',
  libraryGet: 'library:get',
  libraryUpdate: 'library:update',
  libraryRemove: 'library:remove',
  libraryReveal: 'library:reveal',
  categorySave: 'category:save',
  categoryRemove: 'category:remove',
  tagSave: 'tag:save',
  tagRemove: 'tag:remove',
  importPick: 'import:pick',
  importPickFolder: 'import:pick-folder',
  importPaths: 'import:paths',
  toolsPickTxt: 'tools:pick-txt',
  toolsPickOutput: 'tools:pick-output',
  toolsTxtToEpub: 'tools:txt-to-epub',
  search: 'search:query',
  searchRebuild: 'search:rebuild',
  searchRebuildContent: 'search:rebuild-content',
  onlineSources: 'online:sources',
  onlineProbe: 'online:probe',
  onlineFeatured: 'online:featured',
  onlineSearch: 'online:search',
  onlineDownload: 'online:download',
  onlineCancel: 'online:cancel',
  onlineSourceToggle: 'online:source-toggle',
  onlineOpdsSave: 'online:opds-save',
  onlineOpdsRemove: 'online:opds-remove',
  translateLanguages: 'translate:languages',
  translateProviders: 'translate:providers',
  translateProbe: 'translate:probe',
  translateProviderToggle: 'translate:provider-toggle',
  translateSetEndpoint: 'translate:set-endpoint',
  translateRun: 'translate:run',
  translateCancel: 'translate:cancel',
  translateCacheClear: 'translate:cache-clear',
  readerLoad: 'reader:load',
  readerContent: 'reader:content',
  progressGet: 'reader:progress-get',
  progressSave: 'reader:progress-save',
  bookmarkList: 'reader:bookmark-list',
  bookmarkAdd: 'reader:bookmark-add',
  bookmarkRemove: 'reader:bookmark-remove',
  noteList: 'reader:note-list',
  noteAdd: 'reader:note-add',
  noteUpdate: 'reader:note-update',
  noteRemove: 'reader:note-remove',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  themeSet: 'system:theme-set',
  metadataRefresh: 'metadata:refresh',
  associationGet: 'system:association-get',
  associationSet: 'system:association-set',
  systemPickDir: 'system:pick-directory',
  windowAction: 'system:window',
  shellOpen: 'system:shell-open'
} as const

export type WindowAction = 'minimize' | 'maximize' | 'unmaximize' | 'close' | 'fullscreen' | 'is-maximized'

/** 通道 -> [参数元组, 返回值] */
export interface IpcContract {
  'app:ready': () => { pendingFiles: string[]; info: AppInfo }
  'app:info': () => AppInfo
  'library:list': () => LibrarySnapshot
  'library:get': (id: ID) => Book | null
  'library:update': (id: ID, patch: Partial<Book>) => Book
  'library:remove': (ids: ID[], deleteFile?: boolean) => { removed: number }
  'library:reveal': (id: ID) => void
  'category:save': (category: Category) => Category
  'category:remove': (id: ID) => void
  'tag:save': (tag: Tag) => Tag
  'tag:remove': (id: ID) => void
  'import:pick': () => string[]
  'import:pick-folder': () => string[]
  'import:paths': (options: ImportOptions) => ImportResult
  'tools:pick-txt': () => string[]
  'tools:pick-output': () => string | null
  'tools:txt-to-epub': (options: TxtToEpubOptions) => TxtToEpubResult
  'search:query': (query: SearchQuery) => SearchResult
  'search:rebuild': () => void
  'search:rebuild-content': () => ContentCacheResult
  'online:sources': () => OnlineSourceInfo[]
  'online:probe': (sourceIds?: string[]) => OnlineSourceInfo[]
  'online:featured': (query?: OnlineFeaturedQuery) => OnlineFeaturedResult
  'online:search': (query: OnlineSearchQuery) => OnlineSearchResult
  'online:download': (request: OnlineDownloadRequest) => OnlineDownloadProgress
  'online:cancel': (jobId: string) => void
  'online:source-toggle': (sourceId: string, enabled: boolean) => OnlineSourceInfo[]
  'online:opds-save': (source: CustomOpdsSource) => OnlineSourceInfo[]
  'online:opds-remove': (id: ID) => OnlineSourceInfo[]
  'translate:languages': () => TranslationLanguage[]
  'translate:providers': () => TranslationProviderInfo[]
  'translate:probe': (ids?: TranslationProviderId[]) => TranslationProviderInfo[]
  'translate:provider-toggle': (id: TranslationProviderId, enabled: boolean) => TranslationProviderInfo[]
  'translate:set-endpoint': (endpoint: string) => TranslationProviderInfo[]
  'translate:run': (request: TranslateRequest) => TranslateResult
  'translate:cancel': (jobId: string) => void
  'translate:cache-clear': (targetLang?: string) => { removed: number }
  'reader:load': (bookId: ID) => ArrayBuffer
  'reader:content': (bookId: ID) => BookContent | null
  'reader:progress-get': (bookId: ID) => ReadingProgress | null
  'reader:progress-save': (progress: ReadingProgress) => void
  'reader:bookmark-list': (bookId: ID) => Bookmark[]
  'reader:bookmark-add': (bookmark: Bookmark) => Bookmark
  'reader:bookmark-remove': (id: ID) => void
  'reader:note-list': (bookId: ID) => Note[]
  'reader:note-add': (note: Note) => Note
  'reader:note-update': (id: ID, patch: Partial<Note>) => Note
  'reader:note-remove': (id: ID) => void
  'settings:get': () => AppSettings
  'settings:save': (settings: Partial<AppSettings>) => AppSettings
  /** 同步外观到主进程：设置 nativeTheme.themeSource + 写启动首帧用的偏好缓存 */
  'system:theme-set': (mode: ThemeMode) => { dark: boolean }
  'metadata:refresh': (bookId: ID) => MetadataPatch | null
  'system:association-get': () => { associated: boolean; detail: string }
  'system:association-set': (enable: boolean) => { associated: boolean; detail: string }
  'system:pick-directory': () => string | null
  'system:window': (action: WindowAction) => boolean | void
  'system:shell-open': (target: string) => void
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = Parameters<IpcContract[C]>
export type IpcResult<C extends IpcChannel> = ReturnType<IpcContract[C]>

// ---------------------------------------------------------------- 主进程 -> 渲染进程事件

export const EV = {
  openFiles: 'ev:open-files',
  importProgress: 'ev:import-progress',
  importDone: 'ev:import-done',
  searchProgress: 'ev:search-progress',
  contentProgress: 'ev:content-progress',
  onlineProgress: 'ev:online-progress',
  translateProgress: 'ev:translate-progress',
  metadataUpdated: 'ev:metadata-updated',
  libraryChanged: 'ev:library-changed',
  windowState: 'ev:window-state',
  /** 系统深浅色变化，渲染层在「跟随系统」模式下据此实时换肤 */
  nativeThemeChanged: 'ev:native-theme-changed'
} as const

export interface EventMap {
  'ev:open-files': { paths: string[] }
  'ev:import-progress': ImportProgress
  'ev:import-done': ImportResult
  'ev:search-progress': SearchProgress
  'ev:content-progress': { done: number; total: number; fileName: string }
  'ev:online-progress': OnlineDownloadProgress
  'ev:translate-progress': TranslateProgress
  'ev:metadata-updated': { bookId: ID; patch: MetadataPatch }
  'ev:library-changed': { reason: string }
  'ev:window-state': { maximized: boolean; fullScreen: boolean }
  'ev:native-theme-changed': { dark: boolean }
}

export type EventChannel = keyof EventMap
export type EventPayload<C extends EventChannel> = EventMap[C]

/** preload 暴露给 window.api 的形状 */
export interface Api {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void
  /** Electron 28+ 移除了 File.path，拖拽导入必须走 webUtils */
  getFilePath(file: File): string
}
