<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getFilePath } from '../api'
import { COLOR_PALETTE } from '@shared/constants'
import { FORMAT_HINT, isBookPath } from '@shared/formats'
import { useLibraryStore } from '../stores/library'
import BookCard from '../components/BookCard.vue'
import BookDetail from '../components/BookDetail.vue'
import AppIcon from '../components/AppIcon.vue'

const library = useLibraryStore()
const router = useRouter()
const dragging = ref(false)
const newCategory = ref('')
const categoryAdding = ref(false)
const menu = ref<{ bookId: string; x: number; y: number } | null>(null)
const moreOpen = ref(false)

/** 窄窗口下把次要操作收进「更多」，主操作「导入电子书」永远留在最右侧且不可压缩 */
function closeOverlays(): void {
  menu.value = null
  moreOpen.value = false
}
function onWindowKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeOverlays()
}
onMounted(() => window.addEventListener('keydown', onWindowKey))
onUnmounted(() => window.removeEventListener('keydown', onWindowKey))

const quickFilters = [
  { id: 'all', label: '全部藏书', icon: 'library' },
  { id: 'favorite', label: '我的收藏', icon: 'star' },
  { id: 'unread', label: '未读', icon: 'circle' },
  { id: 'reading', label: '在读', icon: 'clock' },
  { id: 'finished', label: '已读', icon: 'check' }
]

const gridStyle = computed(() => ({
  // 紧凑网格：卡片比 1.0 小一圈，同样的窗口宽度能多放约 35% 的书
  gridTemplateColumns:
    library.viewMode === 'grid' ? 'repeat(auto-fill, minmax(146px, 1fr))' : '1fr'
}))

function openBook(id: string): void {
  menu.value = null
  void router.push({ name: 'reader', params: { id } })
}

function openMenu(bookId: string, event: MouseEvent): void {
  menu.value = { bookId, x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 200) }
}

async function toggleFavorite(): Promise<void> {
  const id = menu.value?.bookId
  menu.value = null
  const book = library.books.find((b) => b.id === id)
  if (book) await library.updateBook(book.id, { favorite: !book.favorite })
}

async function markFinished(): Promise<void> {
  const id = menu.value?.bookId
  menu.value = null
  if (id) await library.updateBook(id, { status: 'finished' })
}

async function removeFromMenu(): Promise<void> {
  const id = menu.value?.bookId
  menu.value = null
  if (id && window.confirm('仅从书库移除记录，磁盘文件保留。确定？')) {
    await library.removeBooks([id])
  }
}

async function addCategory(): Promise<void> {
  const name = newCategory.value.trim()
  if (!name) return
  await library.saveCategory({
    id: '',
    name,
    color: COLOR_PALETTE[library.categories.length % COLOR_PALETTE.length],
    order: library.categories.length,
    createdAt: 0
  })
  newCategory.value = ''
  categoryAdding.value = false
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragging.value = false
  const paths: string[] = []
  for (const file of Array.from(event.dataTransfer?.files || [])) {
    try {
      const path = getFilePath(file)
      // 与文件对话框 / 命令行共用同一份扩展名清单；非 EPUB 由导入服务自动转码
      if (isBookPath(path)) paths.push(path)
    } catch {
      /* 非本地文件，忽略 */
    }
  }
  if (paths.length) {
    const cat = library.activeCategory
    const isRealCategory = library.categories.some((c) => c.id === cat)
    void library.importPaths(paths, isRealCategory ? { categoryId: cat } : {})
  } else {
    library.message = `请拖入 ${FORMAT_HINT} 文件`
  }
}
</script>

<template>
  <div class="library-view" @click="closeOverlays" @dragover.prevent="dragging = true" @dragleave="dragging = false">
    <header class="topbar">
      <div class="titles">
        <h1>我的书架</h1>
        <span class="muted sub-count">共 {{ library.stats.total }} 本 · 在读 {{ library.stats.reading }} 本</span>
      </div>
      <div class="quick-wrap">
        <AppIcon name="search" :size="15" class="quick-icon" />
        <input v-model="library.quickFilter" class="input quick" placeholder="筛选书名 / 作者" aria-label="筛选书名或作者" />
      </div>
      <div class="spacer" />

      <div class="top-actions">
        <button class="btn btn-ghost" @click="router.push({ name: 'tools' })">
          <AppIcon name="convert" :size="15" /> TXT 转 EPUB
        </button>
        <button class="btn btn-ghost" @click="library.pickFolder()">
          <AppIcon name="folder" :size="15" /> 导入文件夹
        </button>
      </div>

      <div class="more-wrap">
        <button
          class="btn btn-ghost more-btn"
          :class="{ on: moreOpen }"
          title="更多导入方式"
          aria-label="更多导入方式"
          :aria-expanded="moreOpen"
          @click.stop="moreOpen = !moreOpen"
        >
          <AppIcon name="dots" :size="16" :stroke-width="2.2" />
        </button>
        <div v-if="moreOpen" class="more-menu panel" @click.stop>
          <button @click="closeOverlays(); router.push({ name: 'tools' })">
            <AppIcon name="convert" :size="15" /> TXT 转 EPUB
          </button>
          <button @click="closeOverlays(); library.pickFolder()">
            <AppIcon name="folder" :size="15" /> 导入文件夹
          </button>
          <div class="divider" />
          <button @click="closeOverlays(); library.pickFiles()">
            <AppIcon name="plus" :size="15" /> 导入电子书
          </button>
        </div>
      </div>

      <button class="btn btn-primary main-action" @click="library.pickFiles()">
        <AppIcon name="plus" :size="15" :stroke-width="2" /> 导入电子书
      </button>
    </header>

    <div class="body">
      <aside class="filters panel">
        <div class="group-title">书库</div>
        <button
          v-for="f in quickFilters"
          :key="f.id"
          class="filter-item"
          :class="{ on: library.activeCategory === f.id }"
          @click="library.activeCategory = f.id"
        >
          <AppIcon :name="f.icon" :size="16" class="fi-icon" />
          <span>{{ f.label }}</span>
          <span class="muted count">
            {{ f.id === 'all' ? library.books.length : f.id === 'favorite' ? library.stats.favorite : library.books.filter((b) => b.status === f.id).length }}
          </span>
        </button>

        <div class="group-title with-add">
          <span>分类</span>
          <button title="新建分类" @click="categoryAdding = !categoryAdding">＋</button>
        </div>
        <div v-if="categoryAdding" class="add-row">
          <input v-model="newCategory" class="input" placeholder="分类名称" @keyup.enter="addCategory" />
          <button class="btn btn-soft" @click="addCategory">√</button>
        </div>
        <div
          v-for="c in library.categories"
          :key="c.id"
          class="filter-item"
          :class="{ on: library.activeCategory === c.id }"
          @click="library.activeCategory = c.id"
        >
          <i class="tag-dot" :style="{ background: c.color }" />
          <span class="ellipsis">{{ c.name }}</span>
          <button
            class="del"
            title="删除分类"
            @click.stop="library.removeCategory(c.id)"
          >×</button>
        </div>

        <div class="group-title">标签筛选</div>
        <div class="tag-cloud">
          <button
            v-for="t in library.tags"
            :key="t.id"
            class="tag-chip"
            :class="{ on: library.activeTags.includes(t.id) }"
            :style="{ borderColor: library.activeTags.includes(t.id) ? t.color : 'transparent', color: library.activeTags.includes(t.id) ? t.color : '' }"
            @click="library.toggleTagFilter(t.id)"
          >
            <i class="tag-dot" :style="{ background: t.color }" />{{ t.name }}
          </button>
          <span v-if="!library.tags.length" class="muted empty">还没有标签，在书籍详情里创建</span>
        </div>
      </aside>

      <section class="shelf">
        <div class="shelf-toolbar">
          <span class="muted">显示 {{ library.visibleBooks.length }} 本</span>
          <div class="spacer" />
          <select v-model="library.sortBy" class="input sort" @change="library.setSortBy(library.sortBy)">
            <option value="addedAt">最近加入</option>
            <option value="lastReadAt">最近阅读</option>
            <option value="title">书名排序</option>
            <option value="rating">我的评分</option>
          </select>
          <div class="view-switch">
            <button :class="{ on: library.viewMode === 'grid' }" title="网格视图" @click="library.setViewMode('grid')">
              <AppIcon name="grid" :size="15" />
            </button>
            <button :class="{ on: library.viewMode === 'list' }" title="列表视图" @click="library.setViewMode('list')">
              <AppIcon name="list" :size="15" />
            </button>
          </div>
        </div>

        <div class="scroll-area">
          <div v-if="library.visibleBooks.length" class="books" :style="gridStyle">
            <BookCard
              v-for="book in library.visibleBooks"
              :key="book.id"
              :book="book"
              :mode="library.viewMode"
              :tags="library.tags"
              :progress="library.progresses[book.id]"
              @open="openBook(book.id)"
              @detail="library.selectedId = book.id"
              @menu="(b, e) => openMenu(b.id, e)"
            />
          </div>
          <div v-else class="empty-state">
            <div class="empty-art">
              <div class="empty-glow" />
              <AppIcon name="bookshelf" :size="78" :stroke-width="1.15" />
            </div>
            <h2>{{ library.books.length ? '没有符合条件的书' : '书架还是空的' }}</h2>
            <p class="muted">支持 {{ FORMAT_HINT }}，非 EPUB 会自动转成 EPUB 入库；双击系统里的 .epub 也会自动导入。</p>
            <button class="btn btn-primary" @click="library.pickFiles()">
              <AppIcon name="plus" :size="15" :stroke-width="2" /> 选择电子书文件
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- 卡片右键菜单 -->
    <div
      v-if="menu"
      class="ctx-menu panel"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <button @click="openBook(menu.bookId)">阅读</button>
      <button @click="library.selectedId = menu.bookId; menu = null">查看详情</button>
      <button @click="toggleFavorite">切换收藏</button>
      <button @click="markFinished">标记已读</button>
      <div class="divider" />
      <button class="danger" @click="removeFromMenu">移出书库</button>
    </div>

    <transition name="fade">
      <div v-if="dragging" class="drop-overlay">
        <div class="drop-box">
          <div class="drop-icon"><AppIcon name="upload" :size="40" :stroke-width="1.4" /></div>
          <h2>松手即可导入</h2>
          <p>支持 {{ FORMAT_HINT }}，非 EPUB 自动转码</p>
        </div>
      </div>
    </transition>

    <BookDetail />
  </div>
</template>

<style scoped>
/* 容器查询按「内容区真实宽度」响应，而不是窗口宽度；侧栏收起后会自动放宽布局 */
.library-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  container-type: inline-size;
  container-name: shelf;
}
.topbar {
  height: 66px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 20px;
  background: var(--c-glass);
  border-bottom: 1px solid var(--c-border);
  backdrop-filter: blur(14px);
  z-index: 6;
}
.titles { display: flex; align-items: baseline; gap: 12px; white-space: nowrap; flex: none; }
.titles h1 { margin: 0; font-size: var(--fs-xl); font-weight: 680; letter-spacing: 0.4px; }
.titles .muted { font-size: var(--fs-sm); }
.quick-wrap { position: relative; width: 226px; margin-left: 14px; flex: 0 1 226px; min-width: 0; }
.quick-icon {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--c-text-3);
  pointer-events: none;
}
.quick { width: 100%; padding-left: 33px; }
/* 主操作永不被 flex 压缩，也永不因溢出被裁切 */
.top-actions { display: flex; align-items: center; gap: 9px; flex: none; }
.main-action { flex: none; }
.more-wrap { position: relative; display: none; flex: none; }
.more-btn { width: 34px; padding: 0; }
.more-btn.on { border-color: var(--c-primary); color: var(--c-primary); background: var(--c-primary-weak); }
.more-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 9px);
  width: 186px;
  padding: 6px;
  box-shadow: var(--sh-3);
  z-index: 40;
}
.more-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-md);
  color: var(--c-text-2);
  text-align: left;
}
.more-menu button:hover { background: var(--c-surface-hover); color: var(--c-text); }

/* ≈ 940px 以下：次要操作收进「更多」，保证主按钮完整可见 */
@container shelf (max-width: 940px) {
  .top-actions { display: none; }
  .more-wrap { display: block; }
  .quick-wrap { flex-basis: 196px; }
  .topbar { padding: 0 18px; }
}
/* ≈ 760px 以下：进一步压缩次要信息，把宽度让给书架内容 */
@container shelf (max-width: 760px) {
  .titles .sub-count { display: none; }
  .quick-wrap { flex: 1 1 140px; max-width: 210px; margin-left: 8px; }
  .filters { width: 168px; }
  .body { gap: 12px; padding: 14px; }
  .topbar { padding: 0 14px; }
}
.body { flex: 1; display: flex; min-height: 0; padding: 18px; gap: 18px; }
.filters {
  width: 200px;
  flex: none;
  padding: 14px 12px;
  overflow: auto;
  background: var(--c-glass-2);
  backdrop-filter: blur(8px);
}
.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 16px 8px 8px;
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 1.1px;
  color: var(--c-text-3);
}
.group-title:first-child { margin-top: 2px; }
.group-title button { color: var(--c-text-3); font-size: 15px; }
.group-title button:hover { color: var(--c-primary); }
.filter-item {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-radius: var(--r-s);
  color: var(--c-text-2);
  font-size: var(--fs-md);
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.filter-item:hover { background: var(--c-surface-hover); color: var(--c-text); }
.filter-item.on {
  background: var(--c-grad-soft);
  color: var(--c-primary);
  font-weight: 600;
  box-shadow: var(--sh-1);
}
.fi-icon { color: var(--c-text-3); }
.filter-item.on .fi-icon { color: var(--c-primary); }
.filter-item .count { margin-left: auto; font-size: var(--fs-xs); }
.filter-item .del { margin-left: auto; opacity: 0; color: var(--c-text-3); font-size: 14px; }
.filter-item:hover .del { opacity: 1; }
.filter-item .del:hover { color: var(--c-danger); }
.add-row { display: flex; gap: 4px; padding: 4px 6px 8px; }
.add-row .input { height: 28px; flex: 1; min-width: 0; }
.add-row .btn { height: 28px; padding: 0 9px; }
.tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 8px; }
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: var(--c-surface-3);
  font-size: var(--fs-sm);
  color: var(--c-text-2);
  transition: background var(--dur) var(--ease), transform 0.12s var(--ease);
}
.tag-chip:hover { transform: translateY(-1px); }
.tag-chip.on { background: var(--c-surface); font-weight: 600; box-shadow: var(--sh-1); }
.empty { font-size: var(--fs-xs); line-height: 1.7; }

.shelf { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.shelf-toolbar { display: flex; align-items: center; gap: 10px; padding: 0 2px 14px; }
.sort { height: 32px; width: 120px; }
.view-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-s);
  background: var(--c-surface);
  box-shadow: var(--sh-1);
}
.view-switch button {
  width: 28px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: var(--r-xs);
  color: var(--c-text-3);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.view-switch button:hover { color: var(--c-text); }
.view-switch button.on { background: var(--c-primary-weak); color: var(--c-primary); }
.scroll-area { flex: 1; overflow: auto; padding: 2px 6px 6px 2px; }
.books { display: grid; gap: 13px; align-content: start; }
.empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
}
.empty-art {
  position: relative;
  width: 148px;
  height: 148px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--c-primary);
  margin-bottom: 4px;
}
.empty-glow {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--c-grad-soft);
  box-shadow: 0 12px 36px rgba(63, 104, 216, 0.1);
}
.empty-art :deep(.app-icon) { position: relative; opacity: 0.82; }
.empty-state h2 { margin: 4px 0 0; font-size: 18px; font-weight: 650; letter-spacing: 0.3px; }
.empty-state p { margin: 0 0 10px; max-width: 380px; line-height: 1.75; font-size: var(--fs-md); }
.ctx-menu {
  position: fixed;
  width: 164px;
  padding: 6px;
  box-shadow: var(--sh-3);
  z-index: 50;
}
.ctx-menu button { width: 100%; height: 32px; padding: 0 11px; text-align: left; border-radius: var(--r-xs); color: var(--c-text-2); font-size: var(--fs-md); }
.ctx-menu button:hover { background: var(--c-surface-hover); color: var(--c-text); }
.ctx-menu button.danger { color: var(--c-danger); }
.ctx-menu .divider { margin: 4px 2px; }
.drop-overlay {
  position: fixed;
  inset: 0;
  background: rgba(63, 104, 216, 0.12);
  backdrop-filter: blur(3px);
  z-index: 70;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.drop-box {
  width: 344px;
  padding: 38px;
  border: 2px dashed var(--c-primary);
  border-radius: var(--r-l);
  background: var(--c-surface);
  box-shadow: var(--sh-3);
  text-align: center;
}
.drop-icon {
  width: 68px;
  height: 68px;
  margin: 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-primary-weak);
  color: var(--c-primary);
}
.drop-box h2 { margin: 16px 0 5px; font-size: 18px; }
.drop-box p { margin: 0; color: var(--c-text-3); font-size: var(--fs-sm); }

/* ---------------------------------------------------------------- 手机布局
 * 顶栏折成两行：第一行标题 + 导入主按钮，第二行全宽筛选框；
 * 左侧筛选栏变成可横向滚动的 chips 条，不再占掉一整列宽度。 */
@media (max-width: 640px) {
  .topbar {
    height: auto;
    min-height: 0;
    flex-wrap: wrap;
    gap: 8px;
    padding: 9px 12px;
  }
  .titles { order: 1; }
  .titles h1 { font-size: 18px; }
  .spacer { order: 2; }
  .more-wrap { order: 3; }
  .main-action { order: 4; }
  .quick-wrap {
    order: 5;
    flex: 1 1 100%;
    width: 100%;
    max-width: none;
    margin-left: 0;
  }
  .more-menu { width: 172px; }

  .body {
    flex-direction: column;
    padding: 10px 12px;
    gap: 10px;
  }
  .filters {
    width: 100%;
    flex: none;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    max-height: 46px;
    padding: 5px 6px;
    overflow-x: auto;
    overflow-y: hidden;
    border-radius: var(--r-s);
  }
  .filters .group-title,
  .filters .add-row,
  .filters .empty { display: none; }
  .filter-item {
    width: auto;
    flex: none;
    height: 32px;
    padding: 0 11px;
    font-size: var(--fs-sm);
    white-space: nowrap;
    border: 1px solid var(--c-border);
  }
  .filter-item .count,
  .filter-item .del { display: none; }
  .tag-cloud {
    display: flex;
    flex: none;
    flex-wrap: nowrap;
    gap: 6px;
    padding: 0;
  }
  .tag-chip { flex: none; }

  .shelf-toolbar { gap: 7px; padding-bottom: 10px; }
  .sort { width: 104px; }
  .books { gap: 10px; }
  .empty-state p { max-width: 100%; font-size: var(--fs-sm); }
  .empty-art { width: 116px; height: 116px; }
  .drop-box { width: min(344px, calc(100vw - 32px)); padding: 26px; }
}
</style>
