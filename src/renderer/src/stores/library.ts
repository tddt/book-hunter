import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { CH, invoke } from '../api'
import type {
  Book,
  Category,
  ImportOptions,
  ImportProgress,
  LibrarySnapshot,
  ReadingProgress,
  Tag
} from '@shared/types'

export const useLibraryStore = defineStore('library', () => {
  const books = ref<Book[]>([])
  const categories = ref<Category[]>([])
  const tags = ref<Tag[]>([])
  const progresses = ref<Record<string, ReadingProgress>>({})

  const activeCategory = ref<string>('all')
  const activeTags = ref<string[]>([])
  const quickFilter = ref('')
  const viewMode = ref<'grid' | 'list'>('grid')
  const sortBy = ref<'addedAt' | 'title' | 'lastReadAt' | 'rating'>('addedAt')
  const selectedId = ref<string | null>(null)
  const importing = ref<ImportProgress | null>(null)
  const busy = ref(false)
  const message = ref('')

  function applySnapshot(s: LibrarySnapshot): void {
    books.value = s.books
    categories.value = s.categories
    tags.value = s.tags
    progresses.value = s.progresses
    viewMode.value = s.settings.viewMode
    sortBy.value = s.settings.sortBy
  }

  async function load(): Promise<void> {
    applySnapshot(await invoke(CH.libraryList))
  }

  const categoryMap = computed(() => new Map(categories.value.map((c) => [c.id, c])))
  const tagMap = computed(() => new Map(tags.value.map((t) => [t.id, t])))
  const selectedBook = computed(
    () => books.value.find((b) => b.id === selectedId.value) || null
  )

  const stats = computed(() => ({
    total: books.value.length,
    reading: books.value.filter((b) => b.status === 'reading').length,
    finished: books.value.filter((b) => b.status === 'finished').length,
    favorite: books.value.filter((b) => b.favorite).length,
    size: books.value.reduce((sum, b) => sum + b.fileSize, 0)
  }))

  const visibleBooks = computed(() => {
    let list = books.value.slice()
    const cat = activeCategory.value
    if (cat === 'favorite') list = list.filter((b) => b.favorite)
    else if (cat === 'unread' || cat === 'reading' || cat === 'finished')
      list = list.filter((b) => b.status === cat)
    else if (cat !== 'all') list = list.filter((b) => b.categoryId === cat)
    if (activeTags.value.length)
      list = list.filter((b) => activeTags.value.every((t) => b.tagIds.includes(t)))
    const q = quickFilter.value.trim().toLowerCase()
    if (q)
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.authors.join(' ').toLowerCase().includes(q) ||
          (b.description || '').toLowerCase().includes(q)
      )
    switch (sortBy.value) {
      case 'title':
        list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
        break
      case 'lastReadAt':
        list.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
        break
      case 'rating':
        list.sort((a, b) => b.rating - a.rating || b.addedAt - a.addedAt)
        break
      default:
        list.sort((a, b) => b.addedAt - a.addedAt)
    }
    return list
  })

  async function importPaths(
    paths: string[],
    options: Partial<ImportOptions> = {}
  ): Promise<void> {
    if (!paths.length || busy.value) return
    busy.value = true
    try {
      const result = await invoke(CH.importPaths, { paths, ...options })
      const parts = [`成功导入 ${result.books.length} 本`]
      if (result.skipped) parts.push(`重复跳过 ${result.skipped} 本`)
      if (result.failed.length)
        parts.push(`失败 ${result.failed.length} 本（${result.failed[0].reason}）`)
      // 2.0：非 EPUB 转码 / 扫描版 PDF 等降级提示，不阻断导入但必须让用户看见
      if (result.warnings?.length)
        parts.push(`${result.warnings.length} 条提示：${result.warnings[0].message}`)
      message.value = parts.join(' · ')
      await load()
    } catch (error) {
      message.value = `导入失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      busy.value = false
      importing.value = null
    }
  }

  async function pickFiles(): Promise<void> {
    await importPaths(await invoke(CH.importPick))
  }

  async function pickFolder(): Promise<void> {
    await importPaths(await invoke(CH.importPickFolder))
  }

  async function updateBook(id: string, patch: Partial<Book>): Promise<void> {
    await invoke(CH.libraryUpdate, id, patch)
    await load()
  }

  async function removeBooks(ids: string[], deleteFile = false): Promise<void> {
    await invoke(CH.libraryRemove, ids, deleteFile)
    if (selectedId.value && ids.includes(selectedId.value)) selectedId.value = null
    await load()
  }

  async function saveCategory(category: Category): Promise<Category> {
    const saved = await invoke(CH.categorySave, category)
    await load()
    return saved
  }

  async function removeCategory(id: string): Promise<void> {
    await invoke(CH.categoryRemove, id)
    if (activeCategory.value === id) activeCategory.value = 'all'
    await load()
  }

  async function saveTag(tag: Tag): Promise<Tag> {
    const saved = await invoke(CH.tagSave, tag)
    await load()
    return saved
  }

  async function removeTag(id: string): Promise<void> {
    await invoke(CH.tagRemove, id)
    activeTags.value = activeTags.value.filter((t) => t !== id)
    await load()
  }

  function toggleTagFilter(id: string): void {
    activeTags.value = activeTags.value.includes(id)
      ? activeTags.value.filter((t) => t !== id)
      : [...activeTags.value, id]
  }

  async function setViewMode(mode: 'grid' | 'list'): Promise<void> {
    viewMode.value = mode
    await invoke(CH.settingsSave, { viewMode: mode })
  }

  async function setSortBy(value: typeof sortBy.value): Promise<void> {
    sortBy.value = value
    await invoke(CH.settingsSave, { sortBy: value })
  }

  async function reveal(id: string): Promise<void> {
    await invoke(CH.libraryReveal, id)
  }

  return {
    books,
    categories,
    tags,
    progresses,
    activeCategory,
    activeTags,
    quickFilter,
    viewMode,
    sortBy,
    selectedId,
    importing,
    busy,
    message,
    categoryMap,
    tagMap,
    selectedBook,
    stats,
    visibleBooks,
    applySnapshot,
    load,
    importPaths,
    pickFiles,
    pickFolder,
    updateBook,
    removeBooks,
    saveCategory,
    removeCategory,
    saveTag,
    removeTag,
    toggleTagFilter,
    setViewMode,
    setSortBy,
    reveal
  }
})
