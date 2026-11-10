import type {
  AppSettings,
  LibrarySnapshot,
  ReaderThemeId,
  ThemeMode,
  TranslationLanguage,
  TranslationSettings
} from './types'

export const APP_NAME = '书猎'
export const SNAPSHOT_VERSION = 1

export interface ReaderThemeDef {
  id: ReaderThemeId
  name: string
  bg: string
  fg: string
  muted: string
  link: string
  chrome: string
  /** 阅读器外壳（工具栏/抽屉）配色，浅色主题用浅色，夜读用深色 */
  shell: string
  shellFg: string
}

export const READER_THEMES: ReaderThemeDef[] = [
  { id: 'paper', name: '素纸', bg: '#ffffff', fg: '#2b2b2b', muted: '#8a8a8a', link: '#3a6ea5', chrome: '#f7f7f8', shell: '#ffffff', shellFg: '#2b2b2b' },
  { id: 'sepia', name: '羊皮纸', bg: '#f5ecd9', fg: '#4b3b2a', muted: '#9b8a70', link: '#8a5a2b', chrome: '#efe3cc', shell: '#f5ecd9', shellFg: '#4b3b2a' },
  { id: 'green', name: '护眼', bg: '#e4f0e2', fg: '#2f4233', muted: '#7d9b80', link: '#3a7a4a', chrome: '#d7e8d5', shell: '#e4f0e2', shellFg: '#2f4233' },
  { id: 'ink', name: '水墨', bg: '#e9e9e6', fg: '#333536', muted: '#8d9093', link: '#4a5560', chrome: '#dededb', shell: '#e9e9e6', shellFg: '#333536' },
  { id: 'night', name: '夜读', bg: '#191b1f', fg: '#b7bcc6', muted: '#6f7681', link: '#7ea6d8', chrome: '#23262c', shell: '#202329', shellFg: '#c3c8d0' }
]

export const FONT_FAMILIES = [
  { name: '系统默认', value: '-apple-system, "Microsoft YaHei", "PingFang SC", sans-serif' },
  { name: '宋体', value: '"SimSun", "Songti SC", "Noto Serif CJK SC", serif' },
  { name: '黑体', value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { name: '楷体', value: '"KaiTi", "Kaiti SC", "STKaiti", serif' },
  { name: '等宽', value: 'Consolas, "Cascadia Mono", monospace' }
] as const

/** 标签 / 分类可选色板 */
export const COLOR_PALETTE = [
  '#e05c5c', '#e8894a', '#d9a441', '#6fa960', '#3fa89b',
  '#4a90d9', '#6c6ed8', '#a565c9', '#d4679b', '#7b8794'
] as const

export const HIGHLIGHT_COLORS = ['#ffe27a', '#b7e6a1', '#a9d8f5', '#f7b6c2', '#d9c2f0'] as const

export const STATUS_LABEL: Record<string, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读'
}

/**
 * 对照翻译支持的目标语言。以 TranSmart 实测可用的语种为基准，
 * 其它通道不支持某个语种时由适配器自己映射 / 报错并自动回退。
 */
export const TRANSLATION_LANGUAGES: TranslationLanguage[] = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'zh-TW', name: '繁體中文' },
  { id: 'en', name: '英语' },
  { id: 'ja', name: '日语' },
  { id: 'ko', name: '韩语' },
  { id: 'fr', name: '法语' },
  { id: 'de', name: '德语' },
  { id: 'es', name: '西班牙语' },
  { id: 'ru', name: '俄语' },
  { id: 'it', name: '意大利语' },
  { id: 'pt', name: '葡萄牙语' },
  { id: 'ar', name: '阿拉伯语' },
  { id: 'th', name: '泰语' },
  { id: 'vi', name: '越南语' },
  { id: 'tr', name: '土耳其语' }
]

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  targetLang: 'zh-CN',
  secondaryLang: '',
  displayMode: 'bilingual',
  preferredProvider: 'tencent',
  // Google gtx 在国内常年不可达，默认关掉但不删除，用户在海外可自行启用
  disabledProviders: ['google'],
  autoTranslate: false,
  customEndpoint: ''
}

/** 外观三态。label/icon 供设置页与标题栏快捷切换共用，避免两处文案漂移 */
export const THEME_MODES: { id: ThemeMode; label: string; desc: string; icon: string }[] = [
  { id: 'light', label: '浅色', desc: '明亮的素纸底色，适合白天', icon: 'sun' },
  { id: 'dark', label: '深色', desc: '低亮度的深色界面，适合夜间', icon: 'moon' },
  { id: 'system', label: '跟随系统', desc: '随 Windows 的深浅色设置自动切换', icon: 'monitor' }
]

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  reader: {
    theme: 'paper',
    fontSize: 19,
    lineHeight: 1.9,
    paragraphSpacing: 0.9,
    lineWidth: 680,
    pageMargin: 36,
    fontFamily: FONT_FAMILIES[0].value,
    textIndent: true,
    justify: true,
    pageMode: 'paginated',
    animation: 'slide',
    spread: 'auto'
  },
  autoMetadata: true,
  contentSearch: true,
  copyOnImport: true,
  viewMode: 'grid',
  sortBy: 'addedAt',
  translation: { ...DEFAULT_TRANSLATION_SETTINGS, disabledProviders: [...DEFAULT_TRANSLATION_SETTINGS.disabledProviders] }
}

export const DEFAULT_CATEGORIES = [
  { name: '文学小说', color: '#4a90d9' },
  { name: '技术编程', color: '#6fa960' },
  { name: '人文社科', color: '#d9a441' },
  { name: '商业经管', color: '#3fa89b' },
  { name: '待整理', color: '#7b8794' }
] as const

export function createEmptySnapshot(): LibrarySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    books: [],
    categories: [],
    tags: [],
    progresses: {},
    bookmarks: [],
    notes: [],
    settings: structuredClone(DEFAULT_SETTINGS)
  }
}

/** 搜索/导入时排除的噪声字符 */
export const MIN_SEARCH_LENGTH = 1
export const SEARCH_SNIPPET_RADIUS = 46
