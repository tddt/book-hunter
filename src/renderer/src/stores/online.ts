import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { CH, invoke } from '../api'
import type {
  CustomOpdsSource,
  OnlineBook,
  OnlineDownloadProgress,
  OnlineDownloadRequest,
  OnlineFeaturedGroup,
  OnlineFeaturedResult,
  OnlineSourceInfo,
  OnlineSourceResult
} from '@shared/types'

/** 界面内置的一键添加预设；实际可达性由健康探测决定 */
export const OPDS_PRESETS: { name: string; endpoint: string }[] = [
  { name: 'Standard Ebooks OPDS', endpoint: 'https://standardebooks.org/opds/all' },
  { name: 'Feedbooks 公版目录', endpoint: 'https://catalog.feedbooks.com/publicdomain/browse.en.atom' },
  { name: 'ManyBooks OPDS', endpoint: 'https://manybooks.net/opds' }
]

export const useOnlineStore = defineStore('online', () => {
  const text = ref('')
  const books = ref<OnlineBook[]>([])
  const sources = ref<OnlineSourceInfo[]>([])
  const sourceResults = ref<OnlineSourceResult[]>([])
  const busy = ref(false)
  const probing = ref(false)
  const error = ref('')
  const took = ref(0)
  const selected = ref<string[]>([])
  const directUrl = ref('')
  const jobs = ref<Record<string, OnlineDownloadProgress>>({})
  const opdsDraft = ref<CustomOpdsSource>({ id: '', name: '', endpoint: '', enabled: true })

  /** 首屏默认展示热门书单；输入关键词搜索后切到搜索结果 */
  const mode = ref<'featured' | 'search'>('featured')
  const featured = ref<OnlineFeaturedResult | null>(null)
  const featuredBusy = ref(false)
  const featuredError = ref('')
  const featuredLoaded = ref(false)
  /** 非空表示当前榜单只针对某一个书源（含未启用源） */
  const featuredScope = ref('')
  const featuredTab = ref('all')

  const enabledSources = computed(() => sources.value.filter((s) => s.enabled))
  const jobList = computed(() => Object.values(jobs.value))
  const activeJobs = computed(() => jobList.value.filter((j) => j.phase !== 'done' && j.phase !== 'error'))
  const featuredGroups = computed<OnlineFeaturedGroup[]>(() => featured.value?.groups || [])
  const featuredBooks = computed<OnlineBook[]>(() => {
    if (!featured.value) return []
    if (featuredTab.value === 'all') return featured.value.books
    return featuredGroups.value.find((g) => g.sourceId === featuredTab.value)?.books || []
  })
  const displayedBooks = computed<OnlineBook[]>(() =>
    mode.value === 'featured' ? featuredBooks.value : books.value
  )

  function updateJob(payload: OnlineDownloadProgress): void {
    jobs.value = { ...jobs.value, [payload.jobId]: payload }
  }

  function clearFinished(): void {
    const next: Record<string, OnlineDownloadProgress> = {}
    for (const [id, job] of Object.entries(jobs.value)) {
      if (job.phase !== 'done' && job.phase !== 'error') next[id] = job
    }
    jobs.value = next
  }

  async function loadSources(): Promise<void> {
    try {
      sources.value = await invoke(CH.onlineSources)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** ids 为空时探测全部书源；首屏只传已启用的，避免不可达站点拖慢 */
  async function probe(ids?: string[]): Promise<void> {
    if (probing.value) return
    probing.value = true
    try {
      sources.value = await invoke(CH.onlineProbe, ids?.length ? [...ids] : undefined)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      probing.value = false
    }
  }

  async function toggleEnabled(source: OnlineSourceInfo): Promise<void> {
    try {
      sources.value = await invoke(CH.onlineSourceToggle, source.id, !source.enabled)
      featuredLoaded.value = false
      if (mode.value === 'featured') await loadFeatured(true)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function toggleSelected(id: string): void {
    const i = selected.value.indexOf(id)
    if (i >= 0) selected.value.splice(i, 1)
    else selected.value.push(id)
  }

  /**
   * 载入热门书单。sourceIds 指定某源时允许查看未启用源的榜单
   * （界面里点「查看热门」属于用户主动行为，不受全局开关限制）。
   */
  async function loadFeatured(force = false, sourceIds?: string[]): Promise<void> {
    if (featuredBusy.value) return
    const scope = sourceIds?.length ? sourceIds[0] : ''
    if (!force && featuredLoaded.value && scope === featuredScope.value) return
    featuredBusy.value = true
    featuredError.value = ''
    try {
      const result = await invoke(CH.onlineFeatured, {
        limit: 24,
        ...(sourceIds?.length ? { sourceIds: [...sourceIds] } : {})
      })
      featured.value = result
      featuredScope.value = scope
      featuredLoaded.value = true
      if (featuredTab.value !== 'all' && !result.groups.some((g) => g.sourceId === featuredTab.value)) {
        featuredTab.value = 'all'
      }
    } catch (cause) {
      featuredError.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      featuredBusy.value = false
    }
  }

  /** 切换到热门视图；传入 sourceId 时只看该源的榜单 */
  async function openFeatured(sourceId?: string): Promise<void> {
    mode.value = 'featured'
    featuredTab.value = sourceId || 'all'
    if (sourceId) await loadFeatured(true, [sourceId])
    else if (featuredScope.value) await loadFeatured(true)
    else await loadFeatured()
  }

  function selectFeaturedTab(id: string): void {
    featuredTab.value = id
  }

  async function run(): Promise<void> {
    const query = text.value.trim()
    if (!query) {
      books.value = []
      sourceResults.value = []
      await openFeatured()
      return
    }
    mode.value = 'search'
    busy.value = true
    error.value = ''
    sourceResults.value = []
    try {
      const result = await invoke(CH.onlineSearch, {
        text: query,
        // 展开成普通数组：ref([]).value 是 Proxy，跨 contextBridge 会克隆失败
        sourceIds: selected.value.length ? [...selected.value] : undefined,
        limit: 24
      })
      books.value = result.books
      sourceResults.value = result.sources
      took.value = result.took
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy.value = false
    }
  }

  /** 不 await：下载由主进程事件流驱动，避免界面卡住几十秒 */
  function startDownload(request: OnlineDownloadRequest): void {
    void invoke(CH.onlineDownload, request).catch((cause) => {
      error.value = cause instanceof Error ? cause.message : String(cause)
    })
  }

  function download(book: OnlineBook): void {
    startDownload({ bookId: book.id, title: book.title })
  }

  function importDirectUrl(): void {
    const url = directUrl.value.trim()
    if (!url) return
    const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || '直链电子书')
    startDownload({ bookId: `direct:${Date.now()}`, url, title: name })
    directUrl.value = ''
  }

  async function cancel(jobId: string): Promise<void> {
    await invoke(CH.onlineCancel, jobId).catch(() => undefined)
  }

  async function saveOpds(): Promise<void> {
    const draft = opdsDraft.value
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      error.value = '请填写书源名称和 OPDS 地址'
      return
    }
    try {
      sources.value = await invoke(CH.onlineOpdsSave, {
        ...draft,
        name: draft.name.trim(),
        endpoint: draft.endpoint.trim()
      })
      opdsDraft.value = { id: '', name: '', endpoint: '', enabled: true }
      featuredLoaded.value = false
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function removeOpds(id: string): Promise<void> {
    sources.value = await invoke(CH.onlineOpdsRemove, id)
    featuredLoaded.value = false
  }

  function usePreset(preset: { name: string; endpoint: string }): void {
    opdsDraft.value = { id: '', name: preset.name, endpoint: preset.endpoint, enabled: true }
  }

  return {
    text, books, sources, sourceResults, busy, probing, error, took, selected,
    directUrl, jobs, opdsDraft, enabledSources, jobList, activeJobs,
    mode, featured, featuredBusy, featuredError, featuredLoaded, featuredScope,
    featuredTab, featuredGroups, featuredBooks, displayedBooks,
    updateJob, clearFinished, loadSources, probe, toggleEnabled, toggleSelected,
    loadFeatured, openFeatured, selectFeaturedTab,
    run, startDownload, download, importDirectUrl, cancel, saveOpds, removeOpds, usePreset
  }
})
