import { readFile, readdir, mkdir, stat, writeFile, access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dialog } from 'electron'
import type {
  TxtToEpubOptions,
  TxtToEpubOutput,
  TxtToEpubResult,
  TxtToEpubStage
} from '@shared/types'
import type { IEpubParser } from '../infra/epub-parser'
import {
  buildEpub,
  mergeTxtBooks,
  parseTxt,
  safeFileName,
  titleFromFileName,
  type TxtEncoding
} from '../infra/formats'

/**
 * 格式工具服务（2.0）：多个 TXT -> EPUB。
 *
 * 与「导入 TXT」复用同一套 parseTxt / buildEpub，保证生成物与导入后读到的书完全一致。
 * 两种模式：
 * - separate：每个 txt 各自生成一本，文件名取书名（不覆盖已有文件，自动加序号）；
 * - merge：所有 txt 合成一本，每个文件是一「卷」、文件内章节是二级目录。
 *
 * 所有产物都会回喂 ZipEpubParser 做一次真实结构自校验，避免产出「能写不能读」的 EPUB。
 *
 * 错误策略：不抛一个笼统的异常让 UI 只能弹「转换失败」，而是把每个文件的
 * 「文件名 + 失败阶段 + 可操作的原因」结构化返回，并给出整次转换的 message。
 */
const STAGE_LABEL: Record<TxtToEpubStage, string> = {
  scan: '查找文件',
  read: '读取文件',
  parse: '解析正文',
  build: '生成 EPUB',
  verify: '校验 EPUB',
  write: '写入磁盘',
  merge: '合并章节'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stageError(stage: TxtToEpubStage, message: string): Error & { stage: TxtToEpubStage } {
  return Object.assign(new Error(message), { stage })
}

/** 把系统级错误翻译成用户能直接采取行动的中文说明 */
function explain(stage: TxtToEpubStage, raw: string): string {
  let detail = raw
  if (/EACCES|EPERM|operation not permitted|Access is denied/i.test(raw)) {
    detail = `没有权限（系统提示：${raw}）。请换一个输出目录，或以可写目录重试。`
  } else if (/ENOENT|no such file|系统找不到/i.test(raw)) {
    detail = `路径不存在或已被移动（系统提示：${raw}）。`
  } else if (/ENOSPC|not enough space|磁盘空间/i.test(raw)) {
    detail = `磁盘空间不足（系统提示：${raw}）。`
  } else if (/EBUSY|resource busy|being used by another/i.test(raw)) {
    detail = `文件被其它程序占用（系统提示：${raw}），请关闭占用程序后重试。`
  }
  return `${STAGE_LABEL[stage]}失败：${detail}`
}

type FailedItem = TxtToEpubResult['failed'][number]

export class ToolsService {
  constructor(private readonly parser: IEpubParser) {}

  async pickTxtFiles(): Promise<string[]> {
    const result = await dialog.showOpenDialog({
      title: '选择要转换的 TXT 文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  }

  async pickOutputDir(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择 EPUB 输出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] || null
  }

  /**
   * 目录递归展开，只收 .txt。
   * 每个「找不到 / 不是 txt / 打不开」的输入路径都变成一条明确失败记录，绝不静默丢弃。
   */
  private async expand(paths: string[]): Promise<{ files: string[]; failed: FailedItem[] }> {
    const out: string[] = []
    const failed: FailedItem[] = []
    const seen = new Set<string>()
    let unreadableDirs = 0
    const walk = async (target: string, depth: number): Promise<void> => {
      if (depth > 6) return
      const info = await stat(target).catch(() => null)
      if (!info) {
        if (depth === 0) {
          failed.push({
            path: target,
            stage: 'scan',
            reason: '查找文件失败：路径不存在或无法访问（文件可能已被移动、重命名或删除）'
          })
        }
        return
      }
      if (info.isFile()) {
        if (!/\.txt$/i.test(target)) {
          if (depth === 0) {
            failed.push({ path: target, stage: 'scan', reason: '查找文件失败：不是 .txt 文件' })
          }
          return
        }
        if (!seen.has(target)) {
          seen.add(target)
          out.push(target)
        }
        return
      }
      if (!info.isDirectory()) return
      const entries = await readdir(target, { withFileTypes: true }).catch(() => null)
      if (!entries) {
        unreadableDirs += 1
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        await walk(join(target, entry.name), depth + 1)
      }
    }
    for (const path of paths) await walk(path, 0)
    if (unreadableDirs) {
      failed.push({
        path: '(子目录)',
        stage: 'scan',
        reason: `查找文件失败：有 ${unreadableDirs} 个子目录无法读取，可能没有访问权限`
      })
    }
    return { files: out, failed }
  }

  /** 已存在同名文件时不覆盖，自动加 _2 / _3，避免误删用户已有 EPUB */
  private async freeOutputPath(dir: string, title: string): Promise<string> {
    const base = safeFileName(title)
    let candidate = join(dir, `${base}.epub`)
    let n = 2
    while (await access(candidate).then(() => true).catch(() => false)) {
      candidate = join(dir, `${base}_${n}.epub`)
      n += 1
    }
    return candidate
  }

  private async emit(
    dir: string,
    title: string,
    chapters: number,
    warnings: string[],
    data: Uint8Array
  ): Promise<TxtToEpubOutput> {
    // 生成物必须能被现有解析器读回，否则视为失败
    let parsed
    try {
      parsed = await this.parser.parse(data)
    } catch (error) {
      throw stageError('verify', `生成的 EPUB 无法通过书猎解析器校验：${messageOf(error)}`)
    }
    if (!parsed.chapters.length) {
      throw stageError('verify', '生成的 EPUB 没有可读章节（源文本可能没有正文内容）')
    }
    const path = await this.freeOutputPath(dir, title)
    try {
      await writeFile(path, data)
    } catch (error) {
      throw stageError('write', `无法写入 ${path}：${messageOf(error)}`)
    }
    return {
      path,
      title,
      chapters: parsed.chapters.length || chapters,
      bytes: data.byteLength,
      warnings
    }
  }

  private pushFailure(result: TxtToEpubResult, path: string, error: unknown, fallback: TxtToEpubStage): void {
    const tagged = error as { stage?: TxtToEpubStage } | null
    const stage = tagged?.stage || fallback
    result.failed.push({
      path,
      stage,
      reason: `${basename(path)} · ${explain(stage, messageOf(error))}`
    })
  }

  async convertTxtToEpub(options: TxtToEpubOptions): Promise<TxtToEpubResult> {
    const result: TxtToEpubResult = { outputs: [], failed: [] }
    const outDir = String(options.outputDir || '').trim()
    if (!outDir) {
      result.failed.push({
        path: '(输出目录)',
        stage: 'write',
        reason: '尚未选择输出目录：请点「选择」指定一个用于保存 EPUB 的文件夹'
      })
      result.message = '转换未开始：缺少输出目录。'
      return result
    }
    try {
      await mkdir(outDir, { recursive: true })
    } catch (error) {
      result.failed.push({
        path: outDir,
        stage: 'write',
        reason: explain('write', `无法创建输出目录 ${outDir}：${messageOf(error)}`)
      })
      result.message = '转换未开始：输出目录不可用。'
      return result
    }

    const { files, failed } = await this.expand(options.paths || [])
    result.failed.push(...failed)
    if (!files.length) {
      result.message = result.failed.length
        ? `没有找到可转换的 TXT 文件：${result.failed[0].reason}`
        : '没有找到可转换的 TXT 文件：请先添加 .txt 文件（文件夹里没有 .txt 也会出现此提示）。'
      return result
    }

    const encoding = (options.encoding || 'auto') as TxtEncoding
    const detectChapters = options.detectChapters !== false
    const parts: { fileName: string; book: ReturnType<typeof parseTxt> }[] = []

    /** 给每一步打上阶段标签；emit 自己抛的标签优先保留 */
    const at = async <T>(stage: TxtToEpubStage, fn: () => Promise<T> | T): Promise<T> => {
      try {
        return await fn()
      } catch (error) {
        if ((error as { stage?: TxtToEpubStage } | null)?.stage) throw error
        throw stageError(stage, messageOf(error))
      }
    }

    for (const file of files) {
      try {
        const bytes = new Uint8Array(await at('read', () => readFile(file)))
        const book = await at('parse', () =>
          parseTxt(bytes, { fileName: basename(file), encoding, detectChapters })
        )
        if (options.mode === 'merge') {
          parts.push({ fileName: basename(file), book })
          continue
        }
        const data = await at('build', () => buildEpub(book))
        result.outputs.push(
          await at('write', () => this.emit(outDir, book.title, book.chapters.length, book.warnings, data))
        )
      } catch (error) {
        this.pushFailure(result, file, error, 'read')
      }
    }

    if (options.mode === 'merge' && parts.length) {
      const firstTitle = titleFromFileName(parts[0].fileName).title
      const title = options.title?.trim() || (parts.length === 1 ? firstTitle : `${firstTitle} 等 ${parts.length} 部合集`)
      try {
        const merged = mergeTxtBooks(parts, title, options.author?.trim())
        const data = await at('build', () => buildEpub(merged))
        result.outputs.push(
          await at('write', () => this.emit(outDir, title, merged.chapters.length, merged.warnings, data))
        )
      } catch (error) {
        this.pushFailure(result, join(outDir, `${safeFileName(title)}.epub`), error, 'merge')
      }
    }

    const okCount = result.outputs.length
    result.message = okCount
      ? `成功生成 ${okCount} 本 EPUB，已保存到 ${outDir}${result.failed.length ? `；另有 ${result.failed.length} 项失败，详见下方列表` : ''}。`
      : `没有生成任何 EPUB。首个原因：${result.failed[0]?.reason || '未知错误'}`
    return result
  }
}
