/**
 * 受支持的电子书格式（2.0）。
 *
 * 这一层是纯数据 + 纯函数，不依赖 Electron / Node / DOM，主进程、preload、渲染层都能引用。
 * 把扩展名集中在这里，是为了让「文件对话框 filters」「命令行参数」「拖拽过滤」「转码分派」
 * 四处永远用同一份清单，避免新增格式时漏改某一处。
 */

/** 规范格式：epub 原生入库，其余导入时统一转成标准 EPUB */
export type ImportFormat = 'epub' | 'mobi' | 'azw3' | 'pdf' | 'txt'

/** 规范扩展名（不含别名） */
export const IMPORT_EXTENSIONS: ImportFormat[] = ['epub', 'mobi', 'azw3', 'pdf', 'txt']

/** 需要转成 EPUB 才能阅读的格式 */
export const CONVERTIBLE_FORMATS: ImportFormat[] = ['mobi', 'azw3', 'pdf', 'txt']

/** 常见别名：azw / kf8 归入 azw3，prc 归入 mobi */
export const BOOK_ALIASES = ['azw', 'prc', 'kf8'] as const

/** 文件对话框 filters.extensions（Electron 要求不带点号） */
export const BOOK_DIALOG_EXTENSIONS: string[] = [...IMPORT_EXTENSIONS, ...BOOK_ALIASES]

/** 路径后缀判断；不带 g 标志，避免复用正则时的 lastIndex 陷阱 */
export const BOOK_PATH_RE = /\.(?:epub|mobi|azw3|azw|kf8|prc|pdf|txt)$/i

/** 界面统一展示的格式说明 */
export const FORMAT_HINT = 'EPUB / MOBI / AZW3 / PDF / TXT'

/** 从文件名 / 路径得到规范格式；别名归一化，未知返回 null */
export function formatOf(pathOrName: string): ImportFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(String(pathOrName || '').trim())
  if (!match) return null
  switch (match[1].toLowerCase()) {
    case 'epub':
      return 'epub'
    case 'mobi':
    case 'prc':
      return 'mobi'
    case 'azw3':
    case 'azw':
    case 'kf8':
      return 'azw3'
    case 'pdf':
      return 'pdf'
    case 'txt':
      return 'txt'
    default:
      return null
  }
}

/**
 * 是否是「可导入的书籍路径」。
 * 命令行里会出现 --enable-logging、-psn_0_123 之类的开关，必须以 - 开头排除，
 * 否则 Electron 的启动参数会被误当成书导入。
 */
export function isBookPath(value: string): boolean {
  const path = String(value ?? '').trim()
  return path.length > 0 && !path.startsWith('-') && BOOK_PATH_RE.test(path)
}
