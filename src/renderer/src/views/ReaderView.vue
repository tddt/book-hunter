<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CH, highlightHtml, invoke } from '../api'
import AppIcon from '../components/AppIcon.vue'
import { FONT_FAMILIES, HIGHLIGHT_COLORS, READER_THEMES } from '@shared/constants'
import { useSettingsStore } from '../stores/settings'
import { useReaderStore } from '../stores/reader'
import { useLibraryStore } from '../stores/library'
import { useTranslationStore, type CompareRow } from '../stores/translation'
import type { TranslationMode } from '../reader/engine'
import { buildSegments } from '../reader/paragraphs'
import {
  NativeReaderEngine,
  decodeLocator,
  encodeLocator,
  type ReaderLocation,
  type SelectionInfo
} from '../reader/engine'
import type {
  Bookmark,
  Note,
  ReaderLocator,
  ReaderSettings,
  TocItem,
  TranslationProviderId,
  TranslationSettings
} from '@shared/types'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const store = useReaderStore()
const library = useLibraryStore()
const translation = useTranslationStore()

const stageEl = ref<HTMLDivElement | null>(null)
const engine = new NativeReaderEngine()
const location = ref<ReaderLocation | null>(null)
const loading = ref(true)
const errorMsg = ref('')
const selection = ref<SelectionInfo | null>(null)
const noteEditor = ref<{
  id?: string
  key: string
  locator: ReaderLocator
  excerpt: string
  text: string
  color: string
} | null>(null)
const findText = ref('')
const pendingTerm = ref('')
const chapterTexts = ref<{ index: number; title: string; text: string }[]>([])
const chapterHrefs = ref<string[]>([])
const tocItems = ref<TocItem[]>([])
const lastMouse = { x: 0, y: 0 }
const viewportW = ref(window.innerWidth)
const viewportH = ref(window.innerHeight)
const chromeVisible = ref(false)
const moreOpen = ref(false)
const showProviders = ref(false)
const endpointDraft = ref('')
/** 正文内嵌对照阅读：译文直接进阅读引擎，与原文共用版心 / 翻页 / 主题 */
const translationActive = ref(false)
const showParagraphList = ref(false)

const displayModes: { id: TranslationMode; label: string }[] = [
  { id: 'bilingual', label: '双语' },
  { id: 'translation', label: '仅译文' },
  { id: 'original', label: '仅原文' }
]

const drawerTitle = computed(() =>
  store.drawer
    ? { toc: '目录', bookmark: '书签', note: '笔记与划线', find: '书内搜索', translate: '对照翻译设置' }[
        store.drawer
      ]
    : ''
)
const chrome = computed(
  () =>
    chromeVisible.value ||
    Boolean(store.drawer) ||
    store.settingsOpen ||
    Boolean(selection.value) ||
    Boolean(noteEditor.value) ||
    Boolean(translation.selection) ||
    loading.value
)
const reader = computed(() => settings.settings.reader)
const theme = computed(
  () => READER_THEMES.find((t) => t.id === reader.value.theme) || READER_THEMES[0]
)
const percent = computed(() => (location.value?.percentage || 0) * 100)
const pageLabel = computed(() => {
  const loc = location.value
  if (!loc) return '准备中'
  return loc.pages > 0
    ? `第 ${loc.page + 1} / ${loc.pages} 页`
    : `本章 ${Math.round(loc.chapterPercent * 100)}%`
})

let saveTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let readerTimer: ReturnType<typeof setTimeout> | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let autoTranslateTimer: ReturnType<typeof setTimeout> | null = null
let stageObserver: ResizeObserver | null = null

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}
function setNumber(event: Event, key: 'fontSize' | 'lineHeight' | 'paragraphSpacing' | 'pageMargin' | 'lineWidth'): void {
  updateReader({ [key]: Number(inputValue(event)) } as Partial<ReaderSettings>)
}
function setFromSelect(event: Event, key: 'fontFamily' | 'pageMode' | 'animation' | 'spread'): void {
  updateReader({ [key]: inputValue(event) } as Partial<ReaderSettings>)
}
function setBool(event: Event, key: 'textIndent' | 'justify'): void {
  updateReader({ [key]: (event.target as HTMLInputElement).checked } as Partial<ReaderSettings>)
}

// ---------------------------------------------------------------- 启动 / 销毁

onMounted(async () => {
  const id = String(route.params.id || '')
  await Promise.all([settings.load(), store.open(id), translation.load()])
  window.addEventListener('keydown', onWindowKey)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('resize', onResize)
  observeStage()
  try {
    const buffer = await invoke(CH.readerLoad, id)
    await nextTick()
    const progress = store.progress
    const initial = progress?.locator || decodeLocator(progress?.cfi || '')
    await engine.init({
      container: stageEl.value!,
      buffer,
      settings: reader.value,
      initial,
      fallbackPercentage: initial ? 0 : progress?.percentage || 0,
      hooks: {
        onRelocated: (loc) => {
          const chapterChanged = location.value?.chapterIndex !== loc.chapterIndex
          location.value = loc
          scheduleSave()
          // 开启「切章自动翻译」时做防抖，避免快速翻页连续消耗免费额度。
          // 只有正文内嵌对照阅读开着才翻译，避免译文没地方显示却白耗免费额度。
          if (chapterChanged && translationActive.value && translation.cfg.autoTranslate) {
            if (autoTranslateTimer) clearTimeout(autoTranslateTimer)
            autoTranslateTimer = setTimeout(() => void translateCurrent(), 650)
          }
        },
        onSelected: (sel) => {
          selection.value = sel
          showChrome(true)
        },
        onSelectionCleared: () => {
          selection.value = null
        },
        onRendered: () => {
          if (pendingTerm.value) engine.highlightTerm(pendingTerm.value)
        }
      }
    })
    chapterTexts.value = engine.chapterTexts()
    chapterHrefs.value = engine.chapterHrefs()
    tocItems.value = store.content?.toc?.length ? store.content.toc : engine.navigation()

    const chapter = Number(route.query.chapter)
    if (Number.isFinite(chapter) && chapter >= 0 && chapter < engine.chapterCount()) {
      pendingTerm.value = String(route.query.q || '')
      const offset = Number(route.query.o)
      if (pendingTerm.value && Number.isFinite(offset) && offset >= 0) {
        // 来自「全文搜索」：直接翻到命中所在页并高亮，而不是停在章节开头
        await engine.goToMatch(chapter, offset, pendingTerm.value)
      } else {
        await engine.goToChapter(chapter)
        if (pendingTerm.value) engine.highlightTerm(pendingTerm.value)
      }
    }

    for (const note of store.notes) {
      engine.highlight(note.locator ? encodeLocator(note.locator) : note.cfi, note.color)
    }
  } catch (error) {
    console.error('[reader] open failed', error)
    errorMsg.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    flushSave()
  }
  if (idleTimer) clearTimeout(idleTimer)
  if (resizeTimer) clearTimeout(resizeTimer)
  if (autoTranslateTimer) clearTimeout(autoTranslateTimer)
  translation.stop()
  translation.clearSelection()
  if (readerTimer) {
    clearTimeout(readerTimer)
    void settings.saveReader({})
  }
  stageObserver?.disconnect()
  stageObserver = null
  window.removeEventListener('keydown', onWindowKey)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('resize', onResize)
  engine.destroy()
})

// ---------------------------------------------------------------- 沉浸 / 进度

function showChrome(sticky = false): void {
  chromeVisible.value = true
  if (idleTimer) clearTimeout(idleTimer)
  if (sticky) return
  idleTimer = setTimeout(() => {
    chromeVisible.value = false
    moreOpen.value = false
  }, 2600)
}

function onMouseMove(event: MouseEvent): void {
  lastMouse.x = event.clientX
  lastMouse.y = event.clientY
  const nearTop = event.clientY < 76
  const nearBottom = event.clientY > window.innerHeight - 96
  if (nearTop || nearBottom) showChrome()
  else if (chromeVisible.value && !store.drawer && !store.settingsOpen && !selection.value && !noteEditor.value) {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => (chromeVisible.value = false), 1100)
  }
}

function onResize(): void {
  viewportW.value = window.innerWidth
  viewportH.value = window.innerHeight
}

function observeStage(): void {
  if (!stageEl.value || typeof ResizeObserver === 'undefined') return
  stageObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => engine.resize(), 140)
  })
  stageObserver.observe(stageEl.value)
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 900)
}

function flushSave(): void {
  const loc = location.value
  if (!loc) return
  void store.saveProgress({
    bookId: store.bookId,
    cfi: loc.cfi,
    locator: loc.locator,
    percentage: loc.percentage,
    chapterIndex: loc.chapterIndex,
    chapterTitle: loc.chapterTitle,
    page: loc.page,
    pages: loc.pages,
    updatedAt: Date.now()
  })
}

// ---------------------------------------------------------------- 翻页 / 导航

async function next(): Promise<void> {
  await engine.next()
}
async function prev(): Promise<void> {
  await engine.prev()
}

function jumpChapter(delta: number): void {
  const index = (location.value?.chapterIndex || 0) + delta
  if (index >= 0 && index < engine.chapterCount()) void engine.goToChapter(index)
}

function seek(event: Event): void {
  void engine.goTo(Number(inputValue(event)) / 100)
}

function onWindowKey(event: KeyboardEvent): void {
  handleKey(event.key)
}

function handleKey(key: string): void {
  const active = document.activeElement
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
    if (key === 'Escape') (active as HTMLElement).blur()
    return
  }
  switch (key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      void next()
      break
    case 'ArrowLeft':
    case 'PageUp':
      void prev()
      break
    case 'Escape':
      if (noteEditor.value) noteEditor.value = null
      else if (selection.value) closeSelection()
      else if (translation.selection) translation.clearSelection()
      else if (translationActive.value) closeTranslate()
      else if (moreOpen.value) moreOpen.value = false
      else if (store.settingsOpen) store.settingsOpen = false
      else if (store.drawer) store.drawer = null
      else void router.push({ name: 'library' })
      break
    case 't':
    case 'T':
      toggleDrawer('toc')
      break
    case 'v':
    case 'V':
      openTranslate()
      break
    case 'b':
    case 'B':
      void addBookmark()
      break
    case 'f':
    case 'F':
      void invoke(CH.windowAction, 'fullscreen')
      break
    default:
      break
  }
}

function toggleDrawer(kind: 'toc' | 'bookmark' | 'note' | 'find'): void {
  store.toggleDrawer(kind)
  showChrome(true)
}

// ---------------------------------------------------------------- 目录 / 书签 / 笔记

const flatToc = computed(() => {
  const out: { item: TocItem; depth: number }[] = []
  const walk = (items: TocItem[], depth: number): void => {
    for (const item of items) {
      out.push({ item, depth })
      walk(item.children, depth + 1)
    }
  }
  walk(tocItems.value, 0)
  return out
})

async function openToc(item: TocItem): Promise<void> {
  const [path, anchor] = (item.href || '').split('#')
  const index = chapterHrefs.value.findIndex(
    (h) => h === path || h.endsWith(`/${path}`) || path.endsWith(`/${h}`)
  )
  if (index >= 0) await engine.goToChapter(index, anchor)
  store.drawer = null
}

async function addBookmark(): Promise<void> {
  const loc = location.value
  if (!loc) return
  await invoke(CH.bookmarkAdd, {
    id: '',
    bookId: store.bookId,
    cfi: loc.cfi,
    locator: loc.locator,
    percentage: loc.percentage,
    excerpt: loc.chapterTitle,
    createdAt: 0
  })
  await store.refreshAnnotations()
  library.message = '已添加书签'
}

async function removeBookmark(id: string): Promise<void> {
  await invoke(CH.bookmarkRemove, id)
  await store.refreshAnnotations()
}

function openAt(item: Bookmark | Note): void {
  const loc = item.locator || decodeLocator(item.cfi)
  if (loc) void engine.display(loc)
  else void engine.goTo(item.percentage)
  store.drawer = null
}

function locatorKeyOf(item: Note): string {
  return item.locator ? encodeLocator(item.locator) : item.cfi
}

// ---------------------------------------------------------------- 划线 / 笔记

function onCopy(): void {
  if (!selection.value) return
  void navigator.clipboard
    .writeText(selection.value.text)
    .then(() => (library.message = '已复制到剪贴板'))
    .catch(() => (library.message = '复制失败，可手动选中复制'))
  closeSelection()
}

async function addHighlight(color: string): Promise<void> {
  const sel = selection.value
  if (!sel) return
  try {
    await invoke(CH.noteAdd, {
      id: '',
      bookId: store.bookId,
      cfi: sel.cfiRange,
      locator: sel.locator,
      percentage: location.value?.percentage || 0,
      excerpt: sel.text.slice(0, 240),
      text: '',
      color,
      createdAt: 0,
      updatedAt: 0
    })
    // 先持久化成功再落高亮，避免「看着划上了、重开就没了」
    engine.highlight(sel.cfiRange, color)
    await store.refreshAnnotations()
    closeSelection()
    library.message = '已添加划线'
  } catch (error) {
    library.message = `划线保存失败：${error instanceof Error ? error.message : String(error)}`
  }
}

function openNoteEditor(): void {
  const sel = selection.value
  if (!sel) return
  noteEditor.value = {
    key: sel.cfiRange,
    locator: sel.locator,
    excerpt: sel.text.slice(0, 240),
    text: '',
    color: HIGHLIGHT_COLORS[0]
  }
  closeSelection()
}

function editNote(note: Note): void {
  const loc = note.locator || decodeLocator(note.cfi)
  if (!loc) {
    library.message = '这条笔记的定位信息已损坏，无法编辑'
    return
  }
  noteEditor.value = {
    id: note.id,
    key: locatorKeyOf(note),
    locator: loc,
    excerpt: note.excerpt,
    text: note.text,
    color: note.color || HIGHLIGHT_COLORS[0]
  }
}

async function saveNote(): Promise<void> {
  const editor = noteEditor.value
  if (!editor) return
  try {
    if (editor.id) {
      await invoke(CH.noteUpdate, editor.id, { text: editor.text.trim(), color: editor.color })
    } else {
      await invoke(CH.noteAdd, {
        id: '',
        bookId: store.bookId,
        cfi: editor.key,
        locator: editor.locator,
        percentage: location.value?.percentage || 0,
        excerpt: editor.excerpt,
        text: editor.text.trim(),
        color: editor.color,
        createdAt: 0,
        updatedAt: 0
      })
      engine.highlight(editor.key, editor.color)
    }
    await store.refreshAnnotations()
    noteEditor.value = null
    library.message = '笔记已保存'
  } catch (error) {
    library.message = `笔记保存失败：${error instanceof Error ? error.message : String(error)}`
  }
}

async function removeNote(note: Note): Promise<void> {
  engine.unhighlight(locatorKeyOf(note))
  await invoke(CH.noteRemove, note.id)
  await store.refreshAnnotations()
}

function closeSelection(): void {
  selection.value = null
  engine.clearSelection()
}

function searchSelection(): void {
  const sel = selection.value
  if (!sel) return
  findText.value = sel.text.slice(0, 24)
  store.drawer = 'find'
  closeSelection()
}

// ---------------------------------------------------------------- 书内搜索

const findResults = computed(() => {
  const needle = findText.value.trim().toLowerCase()
  if (!needle) return []
  const out: { chapterIndex: number; chapterTitle: string; snippet: string; offset: number }[] = []
  for (const chapter of chapterTexts.value) {
    const lower = chapter.text.toLowerCase()
    let at = lower.indexOf(needle)
    let guard = 0
    // 列出每一处命中（上限 200），而不是每章只给第一条
    while (at >= 0 && out.length < 200 && guard < 60) {
      guard += 1
      out.push({
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        snippet: chapter.text.slice(Math.max(0, at - 26), at + needle.length + 44),
        offset: at
      })
      at = lower.indexOf(needle, at + needle.length)
    }
    if (out.length >= 200) break
  }
  return out
})

async function gotoFind(result: { chapterIndex: number; offset: number }): Promise<void> {
  const term = findText.value.trim()
  pendingTerm.value = term
  await engine.goToMatch(result.chapterIndex, result.offset, term)
  store.drawer = null
}

// ---------------------------------------------------------------- 对照翻译

const translatePct = computed(() => {
  const p = translation.progress
  return p && p.total ? Math.round((p.done / p.total) * 100) : 0
})
const usedProviderNames = computed(() =>
  translation.stats.usedProviders.map((id) => translation.providerName(id)).join(' / ')
)

function currentChapter(): number {
  return location.value?.chapterIndex ?? 0
}

async function translateCurrent(force = false): Promise<void> {
  const texts = chapterTexts.value.length ? chapterTexts.value : engine.chapterTexts()
  const start = currentChapter()
  const own = buildSegments(texts[start]?.text || '', engine.chapterParagraphs(start), start)
  let index = start
  let segments = own

  // 真书第 1 节常是纯封面 / 插图页（渲染层正文为 0 字）。
  // 这时不要让用户点开面板只看到一句「本章没有可翻译的正文」，
  // 向后找最近一章有实质正文（>=3 段）的章节，找不到再退而取第一个非空章节。
  if (!own.length && texts.length) {
    let fallback: { index: number; segments: typeof own } | null = null
    for (let step = 1; step < texts.length; step += 1) {
      const candidate = (start + step) % texts.length
      const built = buildSegments(texts[candidate]?.text || '', engine.chapterParagraphs(candidate), candidate)
      if (!built.length) continue
      if (!fallback) fallback = { index: candidate, segments: built }
      if (built.length >= 3) {
        index = candidate
        segments = built
        break
      }
    }
    if (!segments.length && fallback) {
      index = fallback.index
      segments = fallback.segments
    }
  }
  if (!segments.length) {
    translation.error = '本书没有可翻译的正文'
    return
  }
  const chapter = texts[index]
  if (index !== start) {
    // 译文现在嵌在正文里，必须与引擎渲染的章节一致，否则用户看不到译文
    await engine.goToChapter(index)
    library.message = `当前是无正文的扉页，已跳到「${chapter?.title || `第 ${index + 1} 节`}」并翻译`
  }
  await translation.translateChapter(
    index,
    chapter?.title || location.value?.chapterTitle || `第 ${index + 1} 节`,
    segments,
    force
  )
}

/** 把当前译文同步进阅读引擎；译文节点与原文共用同一套排版与翻页 */
function syncTranslations(): void {
  if (!translationActive.value) return
  engine.setTranslations(
    translation.rows,
    translation.displayMode,
    translation.chapterIndex,
    `${translation.langName(translation.targetLang)}译文`,
    translation.secondaryLang ? translation.langName(translation.secondaryLang) : ''
  )
}

function openTranslate(): void {
  if (translationActive.value) {
    closeTranslate()
    return
  }
  translationActive.value = true
  // 不再弹 440px 右侧抽屉把版心挤窄：译文直接进正文，阅读体验与原生一致
  store.drawer = null
  store.settingsOpen = false
  showChrome(true)
  if (!translation.hasTranslation || translation.chapterIndex !== currentChapter()) {
    void translateCurrent()
  } else {
    syncTranslations()
  }
}

function closeTranslate(): void {
  translationActive.value = false
  translation.stop()
  translation.clearSelection()
  engine.clearTranslations()
  store.drawer = null
}

async function setDisplayMode(mode: TranslationMode): Promise<void> {
  await translation.patchConfig({ displayMode: mode })
  syncTranslations()
}

function openTranslateSettings(): void {
  store.drawer = store.drawer === 'translate' ? null : 'translate'
  showChrome(true)
}

watch(
  [() => translation.rows, () => translation.displayMode, () => translation.chapterIndex],
  () => syncTranslations(),
  { flush: 'post' }
)

function gotoSegment(row: CompareRow): void {
  if (row.offset < 0) return
  void engine.goToOffset(
    translation.chapterIndex >= 0 ? translation.chapterIndex : currentChapter(),
    row.offset
  )
}

function setTransLang(event: Event, field: 'targetLang' | 'secondaryLang'): void {
  const value = (event.target as HTMLSelectElement).value
  void translation.patchConfig({ [field]: value } as Partial<TranslationSettings>)
}

function setTransMode(event: Event): void {
  void translation.patchConfig({
    displayMode: (event.target as HTMLSelectElement).value as TranslationSettings['displayMode']
  })
}

function setTransBool(event: Event): void {
  void translation.patchConfig({ autoTranslate: (event.target as HTMLInputElement).checked })
}

function setPreferred(event: Event): void {
  void translation.patchConfig({
    preferredProvider: (event.target as HTMLSelectElement).value as TranslationProviderId
  })
}

async function refreshProviders(): Promise<void> {
  await translation.probe()
}

async function toggleProvider(id: TranslationProviderId, enabled: boolean): Promise<void> {
  await translation.toggleProvider(id, enabled)
}

async function saveEndpoint(): Promise<void> {
  try {
    await translation.setEndpoint(endpointDraft.value)
    library.message = '自建端点已保存'
  } catch (e) {
    library.message = e instanceof Error ? e.message : String(e)
  }
}

async function wipeCache(): Promise<void> {
  const removed = await translation.clearCache()
  library.message = `已清理 ${removed} 段译文缓存`
}

function translateSelected(): void {
  const sel = selection.value
  if (!sel) return
  void translation.translateSelection(sel.text)
  closeSelection()
}

function copyTranslation(): void {
  const value = translation.selection?.translation
  if (!value) return
  void navigator.clipboard
    .writeText(value)
    .then(() => (library.message = '译文已复制'))
    .catch(() => (library.message = '复制失败，可手动选中复制'))
}

// ---------------------------------------------------------------- 设置 / 窗口

function updateReader(patch: Partial<ReaderSettings>): void {
  Object.assign(settings.settings.reader, patch)
  engine.applySettings(settings.settings.reader)
  if (readerTimer) clearTimeout(readerTimer)
  readerTimer = setTimeout(() => void settings.saveReader({}), 420)
}

function windowAction(action: 'minimize' | 'maximize' | 'close' | 'fullscreen'): void {
  moreOpen.value = false
  void invoke(CH.windowAction, action)
}
</script>

<template>
  <div
    class="reader-root"
    :data-reader-theme="reader.theme"
    :style="{ background: theme.bg, color: theme.fg }"
    @click.self="closeSelection"
  >
    <!-- 全屏阅读区：引擎在这里挂载自研排版 -->
    <div ref="stageEl" class="reader-stage" />

    <!-- 顶部 / 底部悬停触发区，平时完全隐藏 -->
    <div class="hot-zone hot-top" @mouseenter="showChrome()" />
    <div class="hot-zone hot-bottom" @mouseenter="showChrome()" />

    <transition name="chrome">
      <header v-show="chrome" class="topbar" :style="{ background: theme.shell, color: theme.shellFg, borderColor: theme.chrome }">
        <button class="icon-btn" title="返回书架 (Esc)" @click="router.push({ name: 'library' })">
          <AppIcon name="arrow-left" :size="17" />
        </button>
        <div class="book-title ellipsis">{{ store.book?.title || '正在打开…' }}</div>
        <div class="spacer" />
        <button class="icon-btn" :class="{ on: store.drawer === 'toc' }" title="目录 (T)" @click="toggleDrawer('toc')">
          <AppIcon name="list" :size="17" />
        </button>
        <button class="icon-btn" :class="{ on: store.drawer === 'bookmark' }" title="书签 (B)" @click="toggleDrawer('bookmark')">
          <AppIcon name="bookmark" :size="16" />
        </button>
        <button class="icon-btn" :class="{ on: store.drawer === 'note' }" title="笔记与划线" @click="toggleDrawer('note')">
          <AppIcon name="edit" :size="17" />
        </button>
        <button class="icon-btn" :class="{ on: store.drawer === 'find' }" title="书内搜索" @click="toggleDrawer('find')">
          <AppIcon name="search" :size="17" />
        </button>
        <button class="icon-btn tr-btn" :class="{ on: translationActive }" title="正文对照阅读 (V)" @click="openTranslate">译</button>
        <button class="icon-btn" :class="{ on: store.settingsOpen }" title="阅读设置" @click="store.settingsOpen = !store.settingsOpen; store.drawer = null; showChrome(true)">Aa</button>
        <div class="more-wrap">
          <button class="icon-btn" title="更多" @click="moreOpen = !moreOpen">
            <AppIcon name="dots" :size="17" :stroke-width="2.2" />
          </button>
          <div v-if="moreOpen" class="more-menu panel" :style="{ background: theme.shell, color: theme.shellFg }">
            <button @click="windowAction('fullscreen')">全屏阅读 <kbd>F</kbd></button>
            <button @click="windowAction('minimize')">最小化</button>
            <button @click="windowAction('maximize')">最大化</button>
            <button class="danger" @click="windowAction('close')">关闭应用</button>
          </div>
        </div>
      </header>
    </transition>

    <transition name="chrome">
      <footer v-show="chrome" class="bottombar" :style="{ background: theme.shell, color: theme.shellFg, borderColor: theme.chrome }">
        <button class="text-btn" title="上一章" @click="jumpChapter(-1)">« 上一章</button>
        <div class="seek-wrap">
          <input class="range seek" type="range" min="0" max="1000" :value="Math.round(percent * 10)" title="拖动跳转全书进度" @change="seek" />
        </div>
        <div class="progress-text">
          <b>{{ percent.toFixed(1) }}%</b>
          <span class="muted">{{ pageLabel }} · {{ location?.chapterTitle || '准备中' }}</span>
        </div>
        <button class="text-btn" title="下一章" @click="jumpChapter(1)">下一章 »</button>
      </footer>
    </transition>

    <!-- 加载 / 错误 -->
    <transition name="fade">
      <div v-if="loading" class="center-state"><span class="spinner" />正在打开电子书…</div>
    </transition>
    <transition name="fade">
      <div v-if="errorMsg" class="center-state err panel">
        <b>打开失败</b>
        <p>{{ errorMsg }}</p>
        <button class="btn btn-ghost" @click="router.push({ name: 'library' })">返回书架</button>
      </div>
    </transition>

    <!-- 右侧抽屉：目录 / 书签 / 笔记 / 搜索 -->
    <transition name="slide">
      <aside v-if="store.drawer" class="drawer" :class="{ translate: store.drawer === 'translate' }" :style="{ background: theme.shell, color: theme.shellFg, borderColor: theme.chrome }">
        <div class="drawer-head">
          <b>{{ drawerTitle }}</b>
          <button class="icon-btn" @click="store.drawer = null">✕</button>
        </div>

        <div v-if="store.drawer === 'toc'" class="drawer-scroll">
          <button v-for="(row, i) in flatToc" :key="i" class="toc-item" :style="{ paddingLeft: `${14 + row.depth * 16}px` }" @click="openToc(row.item)">
            <span class="ellipsis">{{ row.item.label }}</span>
          </button>
          <div v-if="!flatToc.length" class="drawer-empty">本书没有提供目录</div>
        </div>

        <div v-else-if="store.drawer === 'bookmark'" class="drawer-scroll">
          <div v-for="bm in store.bookmarks" :key="bm.id" class="anno-item" @click="openAt(bm)">
            <div class="anno-head"><span class="ellipsis">{{ bm.excerpt }}</span><b>{{ Math.round(bm.percentage * 100) }}%</b></div>
            <button class="anno-del" @click.stop="removeBookmark(bm.id)">删除</button>
          </div>
          <div v-if="!store.bookmarks.length" class="drawer-empty">还没有书签，按 B 可快速添加</div>
        </div>

        <div v-else-if="store.drawer === 'note'" class="drawer-scroll">
          <div v-for="note in store.notes" :key="note.id" class="anno-item" @click="openAt(note)">
            <div class="anno-quote" :style="{ borderLeftColor: note.color }">{{ note.excerpt }}</div>
            <div v-if="note.text" class="anno-text">{{ note.text }}</div>
            <div class="anno-actions">
              <button class="anno-edit" @click.stop="editNote(note)">编辑</button>
              <button class="anno-del" @click.stop="removeNote(note)">删除</button>
            </div>
          </div>
          <div v-if="!store.notes.length" class="drawer-empty">在正文里拖选文字，即可划线、写笔记或划词翻译</div>
        </div>

        <div v-else-if="store.drawer === 'translate'" class="drawer-scroll tr-scroll">
          <div class="tr-controls">
            <div class="tr-grid">
              <label>译文语言
                <select class="input" :value="translation.targetLang" @change="setTransLang($event, 'targetLang')">
                  <option v-for="l in translation.languages" :key="l.id" :value="l.id">{{ l.name }}</option>
                </select>
              </label>
              <label>第二对照
                <select class="input" :value="translation.secondaryLang" @change="setTransLang($event, 'secondaryLang')">
                  <option value="">不启用</option>
                  <option v-for="l in translation.languages" :key="l.id" :value="l.id">{{ l.name }}</option>
                </select>
              </label>
            </div>
            <div class="tr-row">
              <label class="muted">显示方式</label>
              <select class="input" :value="translation.displayMode" @change="setTransMode($event)">
                <option value="bilingual">原文 + 译文</option>
                <option value="translation">仅译文</option>
                <option value="original">仅原文</option>
              </select>
            </div>
            <div class="tr-actions">
              <button class="btn btn-primary mini" :disabled="translation.busy" @click="translateCurrent(false)">翻译本章</button>
              <button v-if="translation.busy" class="btn btn-ghost mini" @click="translation.stop()">停止</button>
              <button v-else-if="translation.hasTranslation" class="btn btn-ghost mini" @click="translation.retry()">强制重译</button>
            </div>
            <div v-if="translation.busy && translation.progress" class="tr-progress">
              <span class="muted">
                {{ translation.progress.done }} / {{ translation.progress.total }} 段 ·
                {{ translation.providerName(translation.progress.providerId) }}
              </span>
              <div class="tr-bar"><i :style="{ width: `${translatePct}%` }" /></div>
            </div>
            <div v-if="translation.hasTranslation" class="tr-meta muted">
              {{ translation.chapterTitle }} · 缓存 {{ translation.stats.cached }} 段 / 新译
              {{ translation.stats.translated }} 段 · {{ translation.stats.took }} ms
              <template v-if="usedProviderNames"> · {{ usedProviderNames }}</template>
            </div>
            <div v-if="translation.error" class="notice err">{{ translation.error }}</div>
            <label class="switch-row">
              <input type="checkbox" :checked="translation.cfg.autoTranslate" @change="setTransBool($event)" />
              <span>切章自动翻译</span>
            </label>
            <button class="link-btn" @click="showProviders = !showProviders">
              通道管理 {{ showProviders ? '▴' : '▾' }}（{{ translation.enabledProviders.length }} / {{ translation.providers.length }} 启用）
            </button>

            <div v-if="showProviders" class="tr-providers">
              <div v-for="p in translation.providers" :key="p.id" class="tr-provider">
                <div class="tr-phead">
                  <b>{{ p.name }}</b>
                  <span :class="['tr-dot', p.healthy === false ? 'bad' : p.healthy ? 'ok' : '']" :title="p.lastError || p.description" />
                </div>
                <p class="muted">{{ p.description }}</p>
                <div class="tr-pfoot">
                  <span class="chip">{{ p.license }}</span>
                  <span class="spacer" />
                  <button class="btn btn-ghost mini" @click="translation.probe([p.id])">探测</button>
                  <button class="btn btn-ghost mini" @click="toggleProvider(p.id, !p.enabled)">
                    {{ p.enabled ? '停用' : '启用' }}
                  </button>
                </div>
                <div v-if="p.lastError" class="tr-err">{{ p.lastError }}</div>
              </div>
              <div class="tr-endpoint">
                <div class="set-label">自建 LibreTranslate 兼容端点</div>
                <input v-model="endpointDraft" class="input" placeholder="https://your-host" />
                <div class="tr-actions">
                  <button class="btn btn-ghost mini" @click="saveEndpoint">保存端点</button>
                  <button class="btn btn-ghost mini" @click="refreshProviders">重新探测</button>
                  <button class="btn btn-ghost mini" @click="wipeCache">清空缓存</button>
                </div>
              </div>
            </div>
          </div>

          <div class="tr-inline-tip">
            译文已按段落直接嵌入正文，与原文共用字体、字号、行距、主题和翻页；这里只用于定位与排查。
          </div>
          <button class="tr-list-toggle" @click="showParagraphList = !showParagraphList">
            段落对照列表 {{ showParagraphList ? '▴' : '▾' }}（{{ translation.rows.length }} 段）
          </button>
          <div v-if="showParagraphList" class="tr-list">
            <article
              v-for="row in translation.rows"
              :key="row.id"
              class="tr-pair"
              :title="row.offset >= 0 ? '点击回到原文位置' : ''"
              @click="gotoSegment(row)"
            >
              <div v-if="translation.displayMode !== 'translation'" class="tr-src">{{ row.text }}</div>
              <div
                v-if="translation.displayMode !== 'original'"
                class="tr-dst"
                :class="{ pending: !row.translation, failed: Boolean(row.error) }"
              >{{ row.translation || row.error || '待翻译' }}</div>
              <div v-if="translation.secondaryLang && row.secondary" class="tr-dst second">
                <span class="tr-lang">{{ translation.langName(translation.secondaryLang) }}</span>{{ row.secondary }}
              </div>
              <div v-if="row.cached" class="tr-cached">缓存</div>
            </article>
            <div v-if="!translation.rows.length" class="drawer-empty">
              还没有译文。点「翻译本章」开始，或选中一段文字后点「翻译」。
            </div>
          </div>
        </div>

        <div v-else class="drawer-scroll">
          <input v-model="findText" class="input find-input" placeholder="在本书中查找…" />
          <div class="find-count muted">找到 {{ findResults.length }}{{ findResults.length >= 200 ? '+' : '' }} 处 · 点击跳到命中所在页</div>
          <button v-for="(r, i) in findResults" :key="i" class="find-item" @click="gotoFind(r)">
            <div class="find-title ellipsis">{{ r.chapterTitle }}</div>
            <p v-html="highlightHtml(r.snippet, [findText])" />
          </button>
        </div>
      </aside>
    </transition>

    <!-- 阅读设置 -->
    <transition name="slide">
      <aside v-if="store.settingsOpen" class="drawer settings" :style="{ background: theme.shell, color: theme.shellFg, borderColor: theme.chrome }" @click.stop>
        <div class="drawer-head"><b>阅读设置</b><button class="icon-btn" @click="store.settingsOpen = false">✕</button></div>
        <div class="drawer-scroll">
          <div class="set-group">
            <div class="set-label">阅读主题</div>
            <div class="themes">
              <button v-for="t in READER_THEMES" :key="t.id" :class="{ on: reader.theme === t.id }" :style="{ background: t.bg, color: t.fg, borderColor: reader.theme === t.id ? t.link : 'transparent' }" :title="t.name" @click="updateReader({ theme: t.id })">{{ t.name }}</button>
            </div>
          </div>

          <div class="set-group">
            <div class="set-label">字体与排版</div>
            <div class="set-row"><label>字体</label>
              <select class="input" :value="reader.fontFamily" @change="setFromSelect($event, 'fontFamily')">
                <option v-for="f in FONT_FAMILIES" :key="f.name" :value="f.value">{{ f.name }}</option>
              </select>
            </div>
            <div class="set-row"><label>字号 <b>{{ reader.fontSize }}px</b></label>
              <input class="range" type="range" min="14" max="34" :value="reader.fontSize" @input="setNumber($event, 'fontSize')" />
            </div>
            <div class="set-row"><label>行距 <b>{{ reader.lineHeight.toFixed(1) }}</b></label>
              <input class="range" type="range" min="1.3" max="2.6" step="0.1" :value="reader.lineHeight" @input="setNumber($event, 'lineHeight')" />
            </div>
            <div class="set-row"><label>段距 <b>{{ reader.paragraphSpacing.toFixed(1) }}</b></label>
              <input class="range" type="range" min="0.2" max="2" step="0.1" :value="reader.paragraphSpacing" @input="setNumber($event, 'paragraphSpacing')" />
            </div>
            <div class="set-row"><label>版心宽度 <b>{{ reader.lineWidth }}px</b></label>
              <input class="range" type="range" min="420" max="960" step="20" :value="reader.lineWidth" @input="setNumber($event, 'lineWidth')" />
            </div>
            <div class="set-row"><label>页边距 <b>{{ reader.pageMargin }}px</b></label>
              <input class="range" type="range" min="16" max="96" step="4" :value="reader.pageMargin" @input="setNumber($event, 'pageMargin')" />
            </div>
            <label class="switch-row"><input type="checkbox" :checked="reader.textIndent" @change="setBool($event, 'textIndent')" /><span>中文首行缩进</span></label>
            <label class="switch-row"><input type="checkbox" :checked="reader.justify" @change="setBool($event, 'justify')" /><span>两端对齐</span></label>
          </div>

          <div class="set-group">
            <div class="set-label">翻页</div>
            <div class="set-two">
              <div class="set-row"><label>阅读模式</label>
                <select class="input" :value="reader.pageMode" @change="setFromSelect($event, 'pageMode')">
                  <option value="paginated">分页</option><option value="scrolled">连续滚动</option>
                </select>
              </div>
              <div class="set-row"><label>动画</label>
                <select class="input" :value="reader.animation" @change="setFromSelect($event, 'animation')">
                  <option value="slide">平移</option><option value="fade">淡入</option><option value="none">无</option>
                </select>
              </div>
            </div>
            <div class="set-row"><label>宽屏双页</label>
              <select class="input" :value="reader.spread" @change="setFromSelect($event, 'spread')">
                <option value="auto">宽屏自动双页</option><option value="none">始终单页</option>
              </select>
            </div>
          </div>
          <div class="set-group">
            <div class="set-label">对照翻译</div>
            <div class="set-row">
              <label>首选通道</label>
              <select class="input" :value="translation.cfg.preferredProvider" @change="setPreferred($event)">
                <option v-for="p in translation.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <label class="switch-row">
              <input type="checkbox" :checked="translation.cfg.autoTranslate" @change="setTransBool($event)" />
              <span>切章自动翻译</span>
            </label>
            <p class="set-tip inline">按 V 打开对照翻译，选中文字可划词翻译。译文按「目标语言 + 原文」缓存，重开应用离线可用。</p>
          </div>
          <p class="set-tip">← → / 空格翻页 · T 目录 · V 对照翻译 · B 书签 · F 全屏 · Esc 返回<br />把鼠标移到屏幕顶部或底部可唤出工具栏</p>
        </div>
      </aside>
    </transition>

    <!-- 正文对照阅读：轻量控制条，不占版心、不挤窄阅读区 -->
    <transition name="fade">
      <div
        v-if="translationActive"
        class="tr-inline-bar"
        :class="{ dim: !chrome }"
        :style="{ background: theme.shell, color: theme.shellFg, borderColor: theme.chrome }"
        @click.stop
      >
        <span class="tr-inline-title">
          <AppIcon name="translate" :size="14" /> 对照阅读 · {{ translation.langName(translation.targetLang) }}
        </span>
        <span class="tr-inline-sep" />
        <div class="tr-inline-modes">
          <button
            v-for="m in displayModes"
            :key="m.id"
            :class="{ on: translation.displayMode === m.id }"
            @click="setDisplayMode(m.id)"
          >{{ m.label }}</button>
        </div>
        <span class="tr-inline-sep" />
        <span class="tr-inline-status">
          {{ translation.busy
            ? `${translation.progress?.done || 0}/${translation.progress?.total || 0} 段`
            : `${translation.rows.length} 段` }}
        </span>
        <button class="tr-inline-btn" :disabled="translation.busy" @click="translateCurrent(false)">翻译本章</button>
        <button v-if="translation.busy" class="tr-inline-btn" @click="translation.stop()">停止</button>
        <button class="tr-inline-btn" @click="openTranslateSettings()">设置</button>
        <button class="tr-inline-close" title="退出对照阅读 (Esc)" @click="closeTranslate()">✕</button>
      </div>
    </transition>

    <!-- 选字浮动工具条 -->
    <div v-if="selection" class="sel-bar panel" :style="{ left: `${Math.min(lastMouse.x, viewportW - 330)}px`, top: `${Math.max(64, Math.min(viewportH - 64, lastMouse.y - 54))}px` }" @click.stop>
      <button @click="onCopy">复制</button>
      <span class="sel-divider" />
      <button v-for="color in HIGHLIGHT_COLORS" :key="color" class="color" :style="{ background: color }" title="划线" @click="addHighlight(color)" />
      <span class="sel-divider" />
      <button @click="openNoteEditor">笔记</button>
      <button @click="searchSelection">查找</button>
      <button class="tr-sel-btn" @click="translateSelected">翻译</button>
    </div>

    <!-- 划词翻译结果 -->
    <transition name="fade">
      <div
        v-if="translation.selection"
        class="tr-pop panel"
        :style="{ background: theme.shell, color: theme.shellFg, borderColor: theme.chrome }"
        @click.stop
      >
        <div class="tr-pop-head">
          <b>划词翻译 · {{ translation.langName(translation.targetLang) }}</b>
          <button class="icon-btn" @click="translation.clearSelection()">✕</button>
        </div>
        <p class="tr-pop-src">{{ translation.selection.text }}</p>
        <div v-if="translation.selection.busy" class="muted">正在翻译…</div>
        <div v-else-if="translation.selection.error" class="tr-err">{{ translation.selection.error }}</div>
        <p v-else class="tr-pop-dst">{{ translation.selection.translation }}</p>
        <div class="tr-pop-foot">
          <span class="muted">{{ translation.providerName(translation.selection.providerId) }} · 免费公共翻译通道</span>
          <span class="spacer" />
          <button class="link-btn" :disabled="!translation.selection.translation" @click="copyTranslation">复制译文</button>
        </div>
      </div>
    </transition>

    <!-- 笔记编辑 -->
    <transition name="fade">
      <div v-if="noteEditor" class="modal-mask" @click.self="noteEditor = null">
        <div class="modal panel">
          <b>{{ noteEditor?.id ? '编辑笔记' : '写笔记' }}</b>
          <blockquote>{{ noteEditor.excerpt }}</blockquote>
          <textarea v-model="noteEditor.text" rows="4" placeholder="写下此刻的想法…" />
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="noteEditor = null">取消</button>
            <button class="btn btn-primary" @click="saveNote">保存笔记</button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.reader-root { width: 100%; height: 100%; position: relative; overflow: hidden; user-select: none; }
.reader-stage { position: absolute; inset: 0; }
.hot-zone { position: absolute; left: 0; right: 0; height: 74px; z-index: 8; }
.hot-top { top: 0; }
.hot-bottom { bottom: 0; }

.topbar, .bottombar {
  position: absolute; left: 0; right: 0; z-index: 20;
  display: flex; align-items: center; gap: 6px; padding: 0 16px;
  background: var(--r-shell); color: var(--r-shell-fg);
  box-shadow: 0 2px 18px rgba(0, 0, 0, 0.08);
}
.topbar { top: 0; height: 54px; border-bottom: 1px solid var(--r-border); }
.bottombar { bottom: 0; height: 62px; border-top: 1px solid var(--r-border); gap: 14px; }
.chrome-enter-active, .chrome-leave-active { transition: opacity 0.22s, transform 0.22s; }
.chrome-enter-from, .chrome-leave-to { opacity: 0; }
.topbar.chrome-enter-from, .topbar.chrome-leave-to { transform: translateY(-100%); }
.bottombar.chrome-enter-from, .bottombar.chrome-leave-to { transform: translateY(100%); }

.book-title { font-size: 13px; font-weight: 600; max-width: 340px; opacity: 0.85; }
.spacer { flex: 1; }
.icon-btn {
  min-width: 34px; height: 34px; padding: 0 8px; border-radius: 8px;
  font-size: 15px; line-height: 1; color: inherit; background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.16s;
}
.icon-btn:hover, .icon-btn.on { background: var(--r-hover); }
.text-btn { height: 32px; padding: 0 10px; border-radius: 7px; font-size: 12px; white-space: nowrap; color: inherit; opacity: 0.8; }
.text-btn:hover { background: var(--r-hover); opacity: 1; }

.more-wrap { position: relative; }
.more-menu {
  position: absolute; right: 0; top: 40px; width: 176px; padding: 6px;
  border: 1px solid var(--r-border); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16); z-index: 40;
}
.more-menu button { width: 100%; height: 34px; padding: 0 10px; border-radius: 6px; text-align: left; font-size: 12px; display: flex; justify-content: space-between; align-items: center; color: inherit; }
.more-menu button:hover { background: var(--r-hover); }
.more-menu .danger:hover { color: #d9534f; }
kbd { font-family: inherit; opacity: 0.5; }

.seek-wrap { flex: 1; min-width: 80px; }
.range { width: 100%; accent-color: var(--c-primary, #4a7fd0); cursor: pointer; }
.progress-text { display: flex; flex-direction: column; align-items: flex-end; min-width: 210px; font-size: 11px; line-height: 1.5; }
.progress-text b { font-size: 13px; }
.muted { opacity: 0.6; }

.center-state {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  z-index: 30; display: flex; flex-direction: column; align-items: center; gap: 12px;
  font-size: 13px; opacity: 0.75;
}
.center-state.err { padding: 24px 30px; border-radius: 12px; max-width: 460px; text-align: center; opacity: 1; }
.center-state.err p { font-size: 12px; opacity: 0.75; word-break: break-all; }
.spinner { width: 22px; height: 22px; border: 2px solid var(--r-border); border-top-color: var(--c-primary, #4a7fd0); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.drawer {
  position: absolute; right: 0; top: 0; bottom: 0; width: 340px; z-index: 26;
  border-left: 1px solid var(--r-border); box-shadow: -10px 0 32px rgba(0, 0, 0, 0.1);
  display: flex; flex-direction: column;
}
.drawer-head { height: 54px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 12px 0 18px; border-bottom: 1px solid var(--r-border); font-size: 13px; }
.drawer-scroll { flex: 1; overflow-y: auto; padding: 12px 0 24px; }
.slide-enter-active, .slide-leave-active { transition: transform 0.24s var(--ease, ease), opacity 0.24s; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); opacity: 0; }

.toc-item { display: block; width: 100%; height: 36px; padding-right: 14px; text-align: left; font-size: 12px; color: inherit; border-radius: 6px; }
.toc-item:hover { background: var(--r-hover); }
.drawer-empty { padding: 40px 18px; text-align: center; font-size: 12px; opacity: 0.55; }
.anno-item { position: relative; padding: 12px 18px; border-bottom: 1px solid var(--r-border); cursor: pointer; font-size: 12px; }
.anno-item:hover { background: var(--r-hover); }
.anno-head { display: flex; justify-content: space-between; gap: 10px; }
.anno-quote { border-left: 3px solid; padding-left: 10px; opacity: 0.85; line-height: 1.6; }
.anno-text { margin-top: 8px; opacity: 0.7; }
.anno-actions { display: flex; gap: 14px; margin-top: 8px; }
.anno-edit, .anno-del { font-size: 11px; opacity: 0.5; }
.anno-edit:hover { opacity: 1; color: var(--c-primary, #4a7fd0); }
.anno-del:hover { opacity: 1; color: #d9534f; }
.find-input { margin: 0 14px 8px; width: calc(100% - 28px); }
.find-count { padding: 0 16px 10px; font-size: 11px; }
.find-item { display: block; width: 100%; padding: 10px 16px; text-align: left; color: inherit; border-bottom: 1px solid var(--r-border); }
.find-item:hover { background: var(--r-hover); }
.find-title { font-size: 11px; opacity: 0.6; margin-bottom: 4px; }
.find-item p { font-size: 12px; line-height: 1.6; opacity: 0.85; }

.settings { width: 356px; }
.set-group { padding: 14px 18px 18px; border-bottom: 1px solid var(--r-border); }
.set-label { font-size: 11px; opacity: 0.55; margin-bottom: 12px; letter-spacing: 1px; }
.themes { display: flex; gap: 8px; flex-wrap: wrap; }
.themes button { min-width: 58px; height: 32px; padding: 0 10px; border: 2px solid transparent; border-radius: 7px; font-size: 11px; }
.themes button.on { font-weight: 700; }
.set-row { margin-bottom: 12px; }
.set-row label { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.75; margin-bottom: 6px; }
.set-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.switch-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 10px; cursor: pointer; }
.switch-row input { accent-color: var(--c-primary, #4a7fd0); }
.set-tip { padding: 16px 18px; font-size: 11px; line-height: 1.8; opacity: 0.55; }
.input { width: 100%; height: 30px; padding: 0 8px; border: 1px solid var(--r-border); border-radius: 6px; background: transparent; color: inherit; font-size: 12px; }

.sel-bar {
  position: absolute; z-index: 45; display: flex; align-items: center; gap: 4px;
  padding: 5px 7px; border-radius: 10px; border: 1px solid var(--r-border);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.18);
}
.sel-bar button { height: 26px; padding: 0 8px; border-radius: 6px; font-size: 11px; color: inherit; white-space: nowrap; }
.sel-bar button:hover { background: var(--r-hover); }
.sel-bar .color { width: 20px; height: 20px; padding: 0; border-radius: 50%; }
.sel-divider { width: 1px; height: 18px; background: var(--r-border); margin: 0 3px; }

.modal-mask { position: absolute; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; }
.modal { width: 420px; padding: 20px; border-radius: 12px; }
.modal blockquote { margin: 12px 0; padding: 10px 12px; border-left: 3px solid var(--c-primary, #4a7fd0); font-size: 12px; line-height: 1.7; opacity: 0.8; max-height: 120px; overflow: auto; }
.modal textarea { width: 100%; padding: 10px; border: 1px solid var(--r-border); border-radius: 8px; background: transparent; color: inherit; font-size: 12px; resize: vertical; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------------------------------------------------------------- 对照翻译 */
.drawer.translate { width: 360px; }
.tr-btn { font-weight: 700; font-size: 13px; }
.tr-inline-tip {
  margin: 12px 16px 8px; padding: 9px 11px; border-radius: 8px;
  font-size: 11px; line-height: 1.7; opacity: 0.72;
  background: var(--r-hover);
}
.tr-list-toggle {
  display: block; width: calc(100% - 32px); margin: 0 16px 6px; padding: 7px 0;
  text-align: left; font-size: 11px; color: var(--c-primary, #4a7fd0);
}

/* 正文对照阅读的轻量控制条：不占版心，闲置时淡出，hover 恢复 */
.tr-inline-bar {
  position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); z-index: 24;
  display: flex; align-items: center; gap: 8px; max-width: calc(100% - 40px);
  padding: 6px 8px 6px 12px; border: 1px solid var(--r-border); border-radius: 999px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  font-size: 11px; white-space: nowrap; transition: opacity 0.3s;
}
.tr-inline-bar.dim { opacity: 0.42; }
.tr-inline-bar:hover { opacity: 1; }
.tr-inline-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 620; }
.tr-inline-sep { width: 1px; height: 16px; flex: none; background: var(--r-border); }
.tr-inline-modes { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--r-hover); }
.tr-inline-modes button {
  height: 22px; padding: 0 9px; border-radius: 999px; font-size: 10px;
  color: inherit; opacity: 0.7;
}
.tr-inline-modes button.on { background: var(--r-shell); opacity: 1; font-weight: 650; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1); }
.tr-inline-status { opacity: 0.6; }
.tr-inline-btn {
  height: 24px; padding: 0 9px; border-radius: 999px; font-size: 10px;
  color: inherit; border: 1px solid var(--r-border);
}
.tr-inline-btn:hover { background: var(--r-hover); }
.tr-inline-btn:disabled { opacity: 0.4; cursor: default; }
.tr-inline-close { width: 24px; height: 24px; border-radius: 50%; font-size: 11px; color: inherit; }
.tr-inline-close:hover { background: var(--r-hover); }
.tr-sel-btn { color: var(--c-primary, #4a7fd0); font-weight: 600; }
.tr-scroll { padding: 0 0 24px; }
.tr-controls { padding: 12px 16px; border-bottom: 1px solid var(--r-border); }
.tr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.tr-grid label, .tr-row label { display: block; font-size: 11px; opacity: 0.72; margin-bottom: 5px; }
.tr-row { margin-bottom: 10px; }
.tr-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.tr-controls .mini, .tr-providers .mini { height: 28px; padding: 0 10px; font-size: 11px; border-radius: 6px; }
.link-btn { background: transparent; color: var(--c-primary, #4a7fd0); font-size: 11px; }
.link-btn:disabled { opacity: 0.45; cursor: default; }
.notice { padding: 8px 10px; border-radius: 7px; font-size: 11px; line-height: 1.6; margin: 8px 0; }
.notice.err { background: rgba(217, 83, 79, 0.12); color: #d9534f; }
.tr-progress { margin: 8px 0; font-size: 11px; }
.tr-bar { height: 4px; margin-top: 5px; background: var(--r-border); border-radius: 3px; overflow: hidden; }
.tr-bar i { display: block; height: 100%; background: #4a7fd0; transition: width 0.2s; }
.tr-meta { font-size: 10px; line-height: 1.65; margin: 6px 0; }
.tr-providers { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--r-border); }
.tr-provider { padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--r-border); border-radius: 8px; }
.tr-phead { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
.tr-dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa2ad; }
.tr-dot.ok { background: #3fa89b; }
.tr-dot.bad { background: #d9534f; }
.tr-provider p { font-size: 10px; line-height: 1.55; margin: 6px 0; }
.tr-pfoot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 9px; padding: 2px 6px; border-radius: 4px; background: var(--r-hover); opacity: 0.85; }
.tr-err { font-size: 10px; color: #d9534f; margin-top: 6px; word-break: break-all; }
.tr-endpoint { padding: 10px 2px 2px; border-top: 1px dashed var(--r-border); }
.tr-endpoint .input { margin: 4px 0 8px; }
.tr-list { padding: 4px 0 24px; }
.tr-pair { position: relative; padding: 12px 16px; border-bottom: 1px solid var(--r-border); cursor: pointer; }
.tr-pair:hover { background: var(--r-hover); }
.tr-src { font-size: 11px; line-height: 1.65; opacity: 0.55; margin-bottom: 7px; }
.tr-dst { font-size: 13px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; }
.tr-dst.pending { opacity: 0.4; font-style: italic; }
.tr-dst.failed { color: #d9534f; font-size: 11px; }
.tr-dst.second { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--r-border); font-size: 12px; opacity: 0.85; }
.tr-lang { display: inline-block; margin-right: 6px; font-size: 10px; opacity: 0.6; }
.tr-cached { position: absolute; right: 12px; top: 10px; font-size: 9px; opacity: 0.4; }
.tr-pop {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(460px, 82vw); max-height: 62vh; overflow: auto; z-index: 48;
  padding: 14px 16px; border: 1px solid var(--r-border); border-radius: 12px;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.22);
}
.tr-pop-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; margin-bottom: 10px; }
.tr-pop-src { font-size: 11px; line-height: 1.7; opacity: 0.6; padding-bottom: 10px; border-bottom: 1px solid var(--r-border); max-height: 100px; overflow: auto; }
.tr-pop-dst { font-size: 14px; line-height: 1.85; margin: 12px 0; white-space: pre-wrap; }
.tr-pop-foot { display: flex; align-items: center; gap: 8px; font-size: 10px; }
.set-tip.inline { padding: 8px 0 0; }

/* ---------------------------------------------------------------- 手机布局
 * 阅读器在手机宽度下是全屏页（App.vue 不渲染标题栏与底部标签栏）。
 * 这里只收紧工具栏几何、把抽屉改成全屏，绝不动 nr-* 的分页几何与主题变量。 */
@media (max-width: 640px) {
  .topbar { height: 48px; padding: 0 6px; gap: 1px; }
  .topbar .icon-btn { min-width: 30px; height: 32px; padding: 0 5px; }
  .book-title { max-width: 78px; font-size: 12px; }
  .more-menu { top: 38px; width: 164px; }

  .bottombar { height: 54px; padding: 0 8px; gap: 7px; }
  .bottombar .text-btn { padding: 0 6px; font-size: 11px; }
  .seek-wrap { min-width: 56px; }
  /* 章节名在小屏让位给进度滑块，但百分比与上下章按钮全部保留 */
  .progress-text { min-width: 44px; font-size: 10px; }
  .progress-text .muted { display: none; }

  .drawer,
  .drawer.translate { width: 100%; }
  .settings { width: 100%; }
  .modal { width: min(420px, calc(100vw - 24px)); padding: 16px; }
  .center-state.err { max-width: calc(100vw - 32px); padding: 18px; }
  .tr-inline-bar { bottom: 64px; max-width: calc(100% - 16px); overflow-x: auto; }
  .tr-inline-status { display: none; }
  .sel-bar { max-width: calc(100% - 16px); overflow-x: auto; }
  .tr-pop { width: calc(100vw - 28px); max-height: 70vh; }
}
</style>
