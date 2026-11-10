import type { ReaderLocator, ReaderSettings, TocItem, TranslationDisplayMode } from '@shared/types'

/** 阅读器与 UI 之间的唯一契约；换引擎时 UI 不用改 */
export interface ReaderLocation {
  /** 定位键，写进历史字段 cfi 以兼容旧数据结构 */
  cfi: string
  locator: ReaderLocator
  /** 全书进度 0~1，按章节字数加权 */
  percentage: number
  chapterIndex: number
  chapterTitle: string
  /** 本章页序（0 基）与总页数；滚动模式下 pages = 0 */
  page: number
  pages: number
  /** 章内进度 0~1 */
  chapterPercent: number
}

export interface SelectionInfo {
  cfiRange: string
  text: string
  locator: ReaderLocator
}

/** 内嵌对照译文的一行；offset 是章内纯文本字符偏移 */
export interface TranslationRow {
  id: string
  offset: number
  text: string
  translation: string
  secondary: string
  error?: string
}

/** 与设置里的展示方式共用同一份枚举，避免两处漂移 */
export type TranslationMode = TranslationDisplayMode

export interface EngineHooks {
  onRelocated(loc: ReaderLocation): void
  onSelected(sel: SelectionInfo): void
  /** 选区被清空（用户点击空白处）时收起划词工具条 */
  onSelectionCleared?(): void
  onRendered?(chapterIndex: number): void
  onKey?(key: string): void
}

export interface EngineOptions {
  container: HTMLElement
  buffer: ArrayBuffer
  settings: ReaderSettings
  initial: ReaderLocator | null
  /** 旧版本 CFI 进度只能靠百分比兜底 */
  fallbackPercentage: number
  hooks: EngineHooks
}

export interface IReaderEngine {
  init(options: EngineOptions): Promise<void>
  display(locator: ReaderLocator | null): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  goTo(percentage: number): Promise<void>
  goToChapter(index: number, anchor?: string): Promise<void>
  /** 全文搜索命中跳转：定位到章节内关键词所在页并高亮 */
  goToMatch(chapterIndex: number, offset: number, term: string): Promise<void>
  /** 对照翻译：按章内字符偏移翻到原文所在页，不改动 DOM */
  goToOffset(chapterIndex: number, offset: number): Promise<void>
  applySettings(settings: ReaderSettings): void
  resize(): void
  highlight(key: string, color: string): void
  unhighlight(key: string): void
  highlightTerm(term: string): void
  clearSelection(): void
  /** 把译文注入正文，与原文共用版心 / 字体 / 主题 / 翻页 / 进度 */
  setTranslations(
    rows: TranslationRow[],
    mode: TranslationMode,
    chapterIndex: number,
    primaryLabel?: string,
    secondaryLabel?: string
  ): void
  clearTranslations(): void
  navigation(): TocItem[]
  chapterCount(): number
  /** 供书内搜索使用，不依赖主进程是否生成了正文缓存 */
  chapterTexts(): { index: number; title: string; text: string }[]
  chapterHrefs(): string[]
  chapterParagraphs(index: number): string[]
  destroy(): void
}

/**
 * 定位键编码。仍存进 Bookmark/Note/Progress 的 cfi 字段，
 * 旧数据结构不需迁移；旧 CFI（epubcfi(...)）解码失败时由 UI 用百分比兜底。
 */
export function encodeLocator(loc: ReaderLocator): string {
  const parts = [
    loc.chapterIndex,
    loc.page,
    Math.round(loc.percent * 10000),
    loc.range ? loc.range.start : -1,
    loc.range ? loc.range.end : -1
  ]
  return `sl1|${parts.join('|')}`
}

export function decodeLocator(key: string): ReaderLocator | null {
  if (!key || !key.startsWith('sl1|')) return null
  const parts = key.slice(4).split('|').map(Number)
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
  const loc: ReaderLocator = {
    chapterIndex: Math.max(0, parts[0]),
    page: Math.max(0, parts[1]),
    percent: Math.min(1, Math.max(0, parts[2] / 10000))
  }
  if (parts.length >= 5 && parts[3] >= 0 && parts[4] > parts[3]) {
    loc.range = { start: parts[3], end: parts[4] }
  }
  return loc
}

export { NativeReaderEngine } from './native-engine'
