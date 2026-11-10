/**
 * 对照翻译的渲染层状态。
 *
 * 只通过强类型 IPC 调用主进程（渲染层 CSP 不放行外部 connect-src）；
 * 段落与译文按 id 对齐，主译文 / 第二语言译文分别缓存、分别请求。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { CH, invoke } from '../api'
import { DEFAULT_TRANSLATION_SETTINGS } from '@shared/constants'
import type {
  TranslateProgress,
  TranslateResult,
  TranslationLanguage,
  TranslationProviderId,
  TranslationProviderInfo,
  TranslationSettings
} from '@shared/types'
import type { ParagraphSegment } from '../reader/paragraphs'
import { useSettingsStore } from './settings'
import { useReaderStore } from './reader'

export interface CompareRow {
  id: string
  text: string
  offset: number
  translation: string
  secondary: string
  providerId?: TranslationProviderId
  error?: string
  cached?: boolean
}

export interface SelectionTranslation {
  text: string
  translation: string
  providerId?: TranslationProviderId
  busy: boolean
  error?: string
}

function newJobId(): string {
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export const useTranslationStore = defineStore('translation', () => {
  const settings = useSettingsStore()
  const reader = useReaderStore()

  const languages = ref<TranslationLanguage[]>([])
  const providers = ref<TranslationProviderInfo[]>([])
  const rows = ref<CompareRow[]>([])
  const chapterIndex = ref(-1)
  const chapterTitle = ref('')
  const jobId = ref('')
  const busy = ref(false)
  const progress = ref<TranslateProgress | null>(null)
  const error = ref('')
  const stats = ref({ cached: 0, translated: 0, took: 0, usedProviders: [] as string[] })
  const selection = ref<SelectionTranslation | null>(null)
  let currentSegments: ParagraphSegment[] = []

  const cfg = computed<TranslationSettings>(() => ({
    ...DEFAULT_TRANSLATION_SETTINGS,
    ...(settings.settings.translation || {})
  }))
  const targetLang = computed(() => cfg.value.targetLang)
  const secondaryLang = computed(() => cfg.value.secondaryLang)
  const displayMode = computed(() => cfg.value.displayMode)
  const enabledProviders = computed(() => providers.value.filter((p) => p.enabled))
  const hasTranslation = computed(() => rows.value.some((r) => r.translation))

  async function load(): Promise<void> {
    ;[languages.value, providers.value] = await Promise.all([
      invoke(CH.translateLanguages),
      invoke(CH.translateProviders)
    ])
  }

  function setProgress(payload: TranslateProgress): void {
    // 划词翻译用独立 jobId，其进度不应覆盖章节翻译的进度条
    if (payload.jobId !== jobId.value) return
    progress.value = payload
    if (payload.message && payload.phase === 'error') error.value = payload.message
  }

  function langName(id: string): string {
    return languages.value.find((l) => l.id === id)?.name || id
  }

  function providerName(id?: string): string {
    return providers.value.find((p) => p.id === id)?.name || id || '本地缓存'
  }

  async function patchConfig(patch: Partial<TranslationSettings>): Promise<void> {
    const next = { ...cfg.value, ...patch }
    if (next.secondaryLang === next.targetLang) next.secondaryLang = ''
    settings.settings.translation = next
    await settings.save({ translation: next })
    // 语言变化后旧译文不再对得上，清掉让用户重新翻译（缓存仍在，重译很快）
    if ('targetLang' in patch || 'secondaryLang' in patch) {
      rows.value = rows.value.map((r) => ({ ...r, translation: '', secondary: '', error: undefined, cached: false }))
      chapterIndex.value = -1
    }
  }

  async function probe(ids?: TranslationProviderId[]): Promise<void> {
    providers.value = await invoke(CH.translateProbe, ids ? [...ids] : undefined)
  }

  async function toggleProvider(id: TranslationProviderId, enabled: boolean): Promise<void> {
    providers.value = await invoke(CH.translateProviderToggle, id, enabled)
  }

  async function setEndpoint(endpoint: string): Promise<void> {
    providers.value = await invoke(CH.translateSetEndpoint, endpoint)
  }

  async function clearCache(): Promise<number> {
    const result = await invoke(CH.translateCacheClear, targetLang.value)
    rows.value = rows.value.map((r) => ({ ...r, cached: false }))
    return result.removed
  }

  function applyResult(result: TranslateResult, field: 'translation' | 'secondary'): void {
    const map = new Map(result.segments.map((s) => [s.id, s]))
    const failures = new Map(result.errors.map((e) => [e.id, e.message]))
    rows.value = rows.value.map((row) => {
      const hit = map.get(row.id)
      const failure = failures.get(row.id)
      if (field === 'translation') {
        return {
          ...row,
          translation: hit?.translation || '',
          providerId: hit?.providerId || row.providerId,
          cached: hit?.cached ?? row.cached,
          error: failure || (hit ? undefined : '未完成翻译')
        }
      }
      return hit ? { ...row, secondary: hit.translation } : row
    })
  }

  /** 翻译当前章节；force=true 时忽略缓存强制重译 */
  async function translateChapter(
    index: number,
    title: string,
    segments: ParagraphSegment[],
    force = false
  ): Promise<void> {
    if (!segments.length) {
      error.value = '本章没有可翻译的正文'
      return
    }
    if (busy.value) stop()
    const job = newJobId()
    jobId.value = job
    busy.value = true
    error.value = ''
    progress.value = { jobId: job, phase: 'translating', done: 0, total: segments.length }
    currentSegments = segments
    chapterIndex.value = index
    chapterTitle.value = title
    rows.value = segments.map((s) => ({
      id: s.id,
      text: s.text,
      offset: s.offset,
      translation: '',
      secondary: ''
    }))
    try {
      const result = await invoke(CH.translateRun, {
        jobId: job,
        bookId: reader.bookId,
        chapterIndex: index,
        targetLang: targetLang.value,
        texts: segments.map((s) => ({ id: s.id, text: s.text })),
        force
      })
      if (job !== jobId.value) return
      applyResult(result, 'translation')
      stats.value = {
        cached: result.cached,
        translated: result.translated,
        took: result.took,
        usedProviders: result.usedProviders
      }
      if (!result.segments.length && result.errors.length) error.value = result.errors[0].message

      // 第二对照语言按需单独请求，缓存同样命中，不会重复消耗额度
      const second = secondaryLang.value
      if (second && second !== targetLang.value && result.segments.length) {
        const extra = await invoke(CH.translateRun, {
          jobId: `${job}-b`,
          bookId: reader.bookId,
          chapterIndex: index,
          targetLang: second,
          texts: segments.map((s) => ({ id: s.id, text: s.text })),
          force
        })
        if (job === jobId.value) applyResult(extra, 'secondary')
      }
    } catch (e) {
      if (job === jobId.value) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (job === jobId.value) {
        busy.value = false
        progress.value = null
      }
    }
  }

  function retry(): void {
    if (!currentSegments.length) return
    void translateChapter(chapterIndex.value, chapterTitle.value, currentSegments, true)
  }

  function stop(): void {
    if (jobId.value) void invoke(CH.translateCancel, jobId.value)
    jobId.value = ''
    busy.value = false
    progress.value = null
  }

  /** 划词翻译：单段短请求，结果显示在浮动卡片 */
  async function translateSelection(text: string): Promise<void> {
    const value = text.replace(/\s+/g, ' ').trim().slice(0, 400)
    if (!value) return
    selection.value = { text: value, translation: '', busy: true }
    try {
      const result = await invoke(CH.translateRun, {
        jobId: newJobId(),
        bookId: reader.bookId,
        chapterIndex: chapterIndex.value >= 0 ? chapterIndex.value : 0,
        targetLang: targetLang.value,
        texts: [{ id: 'selection', text: value }]
      })
      const hit = result.segments[0]
      selection.value = {
        text: value,
        translation: hit?.translation || '',
        providerId: hit?.providerId,
        busy: false,
        error: hit ? undefined : result.errors[0]?.message || '翻译失败'
      }
    } catch (e) {
      selection.value = {
        text: value,
        translation: '',
        busy: false,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  function clearSelection(): void {
    selection.value = null
  }

  return {
    languages, providers, rows, chapterIndex, chapterTitle, jobId, busy, progress, error, stats,
    selection, cfg, targetLang, secondaryLang, displayMode, enabledProviders, hasTranslation,
    load, setProgress, langName, providerName, patchConfig, probe, toggleProvider, setEndpoint,
    clearCache, translateChapter, retry, stop, translateSelection, clearSelection
  }
})
