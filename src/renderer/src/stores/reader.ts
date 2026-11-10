import { defineStore } from 'pinia'
import { ref } from 'vue'
import { CH, invoke } from '../api'
import type { Book, BookContent, Bookmark, Note, ReadingProgress } from '@shared/types'

export type DrawerKind = 'toc' | 'bookmark' | 'note' | 'find' | 'translate'

export const useReaderStore = defineStore('reader', () => {
  const bookId = ref('')
  const book = ref<Book | null>(null)
  const content = ref<BookContent | null>(null)
  const progress = ref<ReadingProgress | null>(null)
  const bookmarks = ref<Bookmark[]>([])
  const notes = ref<Note[]>([])
  const drawer = ref<DrawerKind | null>(null)
  const settingsOpen = ref(false)
  const chromeVisible = ref(true)

  async function open(id: string): Promise<void> {
    bookId.value = id
    const [b, p, bm, n, c] = await Promise.all([
      invoke(CH.libraryGet, id),
      invoke(CH.progressGet, id),
      invoke(CH.bookmarkList, id),
      invoke(CH.noteList, id),
      invoke(CH.readerContent, id)
    ])
    book.value = b
    progress.value = p
    bookmarks.value = bm
    notes.value = n
    content.value = c
    drawer.value = null
    settingsOpen.value = false
  }

  async function saveProgress(value: ReadingProgress): Promise<void> {
    progress.value = value
    await invoke(CH.progressSave, value)
  }

  async function refreshAnnotations(): Promise<void> {
    ;[bookmarks.value, notes.value] = await Promise.all([
      invoke(CH.bookmarkList, bookId.value),
      invoke(CH.noteList, bookId.value)
    ])
  }

  function toggleDrawer(kind: DrawerKind): void {
    drawer.value = drawer.value === kind ? null : kind
    settingsOpen.value = false
  }

  return {
    bookId,
    book,
    content,
    progress,
    bookmarks,
    notes,
    drawer,
    settingsOpen,
    chromeVisible,
    open,
    saveProgress,
    refreshAnnotations,
    toggleDrawer
  }
})
