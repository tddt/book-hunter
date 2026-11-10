import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { CH, invoke } from '../api'
import type { SearchHit, SearchProgress } from '@shared/types'

export const useSearchStore = defineStore('search', () => {
  const text = ref('')
  const hits = ref<SearchHit[]>([])
  const progress = ref<SearchProgress | null>(null)
  const busy = ref(false)
  const took = ref(0)
  const error = ref('')
  const contentTotal = ref(0)
  const truncated = ref(false)
  const hint = ref('')
  const searchableBooks = ref(0)
  const categoryId = ref<string | undefined>(undefined)
  const tagIds = ref<string[]>([])
  const favoriteOnly = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  const metaHits = computed(() => hits.value.filter((h) => h.source === 'metadata'))
  const contentHits = computed(() => hits.value.filter((h) => h.source === 'content'))

  async function run(): Promise<void> {
    const requestedText = text.value
    busy.value = true
    progress.value = null
    error.value = ''
    try {
      const result = await invoke(CH.search, {
        text: requestedText,
        categoryId: categoryId.value,
        // 展开成普通数组：ref([]).value 是 Proxy，直接跨 contextBridge 会克隆失败
        tagIds: [...tagIds.value],
        favoriteOnly: favoriteOnly.value
      })
      // 正文扫描期间用户可能又改了关键词，丢弃过期结果
      if (requestedText !== text.value) return
      hits.value = result.hits
      took.value = result.took
      contentTotal.value = result.contentTotal
      truncated.value = result.truncated
      hint.value = result.hint || ''
      searchableBooks.value = result.searchableBooks
    } catch (cause) {
      if (requestedText === text.value) {
        hits.value = []
        contentTotal.value = 0
        error.value = cause instanceof Error ? cause.message : String(cause)
        console.error('检索失败', cause)
      }
    } finally {
      if (requestedText === text.value) busy.value = false
    }
  }

  function setText(value: string): void {
    text.value = value
    schedule()
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(), 260)
  }

  return {
    text,
    hits,
    progress,
    busy,
    took,
    error,
    contentTotal,
    truncated,
    hint,
    searchableBooks,
    categoryId,
    tagIds,
    favoriteOnly,
    metaHits,
    contentHits,
    run,
    setText,
    schedule
  }
})
