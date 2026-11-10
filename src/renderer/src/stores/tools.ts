import { defineStore } from 'pinia'
import { ref } from 'vue'
import { CH, invoke } from '../api'
import type {
  TxtEncodingOption,
  TxtToEpubMode,
  TxtToEpubResult
} from '@shared/types'

/**
 * 「多个 TXT → EPUB」工具的状态与 IPC 封装（2.0）。
 * 只负责收集参数、调用主进程、保存结果；具体解析与生成全在主进程，
 * 与「导入 TXT」复用同一套 parseTxt / buildEpub，产物可直接导入书架。
 */
export const useToolsStore = defineStore('tools', () => {
  const paths = ref<string[]>([])
  const outputDir = ref('')
  const mode = ref<TxtToEpubMode>('merge')
  const encoding = ref<TxtEncodingOption>('auto')
  const detectChapters = ref(true)
  const title = ref('')
  const author = ref('')

  const busy = ref(false)
  const error = ref('')
  const result = ref<TxtToEpubResult | null>(null)

  function addPaths(list: string[]): number {
    const seen = new Set(paths.value)
    let added = 0
    for (const item of list) {
      const path = String(item || '').trim()
      if (!path || !/\.txt$/i.test(path) || seen.has(path)) continue
      seen.add(path)
      paths.value.push(path)
      added += 1
    }
    return added
  }

  function removePath(path: string): void {
    paths.value = paths.value.filter((p) => p !== path)
  }

  function clearPaths(): void {
    paths.value = []
    result.value = null
    error.value = ''
  }

  async function pickTxt(): Promise<void> {
    addPaths(await invoke(CH.toolsPickTxt))
  }

  async function pickOutput(): Promise<void> {
    const dir = await invoke(CH.toolsPickOutput)
    if (dir) outputDir.value = dir
  }

  async function convert(): Promise<boolean> {
    // 任何提前返回都必须带上人能看懂的原因，绝不留下「转换失败：」这种空提示
    if (busy.value) {
      error.value = '正在转换中，请等待本次转换结束'
      return false
    }
    if (!paths.value.length) {
      error.value = '请先添加要转换的 TXT 文件'
      return false
    }
    if (!outputDir.value) {
      error.value = '请先选择 EPUB 输出目录'
      return false
    }
    busy.value = true
    error.value = ''
    result.value = null
    try {
      const res = await invoke(CH.toolsTxtToEpub, {
        paths: [...paths.value],
        outputDir: outputDir.value,
        mode: mode.value,
        title: title.value.trim() || undefined,
        author: author.value.trim() || undefined,
        encoding: encoding.value,
        detectChapters: detectChapters.value
      })
      result.value = res
      if (!res.outputs.length) {
        // 主进程已把「哪个文件、哪一步、什么原因」写在 failed 里；这里兜底保证不为空
        error.value =
          res.failed[0]?.reason ||
          res.message ||
          '没有生成任何 EPUB，且主进程未返回原因（请查看应用日志）'
        return false
      }
      return true
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      // Electron 会把 IPC 错误包一层，去掉前缀只留业务原因
      error.value = raw.replace(/^Error invoking remote method[^:]*:\s*/i, '').trim() || '转换失败：IPC 调用异常'
      return false
    } finally {
      busy.value = false
    }
  }

  return {
    paths,
    outputDir,
    mode,
    encoding,
    detectChapters,
    title,
    author,
    busy,
    error,
    result,
    addPaths,
    removePath,
    clearPaths,
    pickTxt,
    pickOutput,
    convert
  }
})
