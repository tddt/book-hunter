/**
 * 格式适配层统一出口（2.0）。
 * 新增格式只需：写一个 `xxx.ts` 产出 NormalizedBook，再在 convertBytesToEpub 里登记一行。
 * 上层（导入服务 / 转码工具）只依赖这里，不直接接触任何第三方解析库。
 */
import type { ImportFormat, NormalizedBook } from './normalized'
import { buildEpub } from './epub-writer'
import { parseTxt } from './txt'
import { parsePdf } from './pdf'
import { parseMobi } from './mobi'

export * from './normalized'
export { buildEpub, chapterFile } from './epub-writer'
export { parseTxt, decodeTxt, splitTxtChapters, mergeTxtBooks } from './txt'
export type { TxtEncoding, TxtParseOptions, TxtChapter } from './txt'
export { parsePdf } from './pdf'
export type { PdfParseOptions } from './pdf'
export { parseMobi } from './mobi'
export type { MobiParseOptions } from './mobi'

export interface ConvertedEpub {
  data: Uint8Array
  warnings: string[]
  /** 转换后供 UI 展示的格式说明 */
  format: ImportFormat
}

/** 各格式 -> 统一中间表示；epub 不走这里（保持原有解析路径零改动） */
export async function parseAsBook(
  bytes: Uint8Array,
  format: ImportFormat,
  fileName: string
): Promise<NormalizedBook> {
  switch (format) {
    case 'txt':
      return parseTxt(bytes, { fileName })
    case 'pdf':
      return parsePdf(bytes, { fileName })
    case 'mobi':
    case 'azw3':
      return parseMobi(bytes, { fileName, format })
    default:
      throw new Error(`无需转换的格式：${format}`)
  }
}

/** 任意支持格式的字节 -> 标准 EPUB 字节；读完可直接落盘或交回 ZipEpubParser 自校验 */
export async function convertBytesToEpub(
  bytes: Uint8Array,
  format: ImportFormat,
  fileName: string
): Promise<ConvertedEpub> {
  if (format === 'epub') return { data: bytes, warnings: [], format }
  const book = await parseAsBook(bytes, format, fileName)
  const data = await buildEpub(book)
  return { data, warnings: book.warnings, format }
}
