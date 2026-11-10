<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CH, coverUrl, formatDate, formatSize, invoke, placeholderCover } from '../api'
import { COLOR_PALETTE, STATUS_LABEL } from '@shared/constants'
import { useLibraryStore } from '../stores/library'
import TagPicker from './TagPicker.vue'
import type { ReadingStatus } from '@shared/types'

const library = useLibraryStore()
const router = useRouter()
const book = computed(() => library.selectedBook)
const cover = computed(() =>
  book.value?.cover ? coverUrl(book.value.cover) : placeholderCover(book.value?.title || '书')
)

const form = reactive({
  title: '',
  authorsText: '',
  publisher: '',
  isbn: '',
  description: '',
  categoryId: '',
  tagIds: [] as string[],
  rating: 0,
  status: 'unread' as ReadingStatus,
  favorite: false
})

function reset(): void {
  const b = book.value
  if (!b) return
  Object.assign(form, {
    title: b.title,
    authorsText: b.authors.join(', '),
    publisher: b.publisher || '',
    isbn: b.isbn || '',
    description: b.description || '',
    categoryId: b.categoryId || '',
    tagIds: [...b.tagIds],
    rating: b.rating,
    status: b.status,
    favorite: b.favorite
  })
}
// 只在切换书籍时重置，元数据异步补全刷新不会冲掉正在编辑的内容
watch(() => book.value?.id, reset, { immediate: true })

async function save(): Promise<void> {
  if (!book.value) return
  await library.updateBook(book.value.id, {
    title: form.title.trim() || book.value.title,
    authors: form.authorsText.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
    publisher: form.publisher,
    isbn: form.isbn,
    description: form.description,
    categoryId: form.categoryId || undefined,
    tagIds: form.tagIds,
    rating: form.rating,
    status: form.status,
    favorite: form.favorite
  })
  library.message = '书籍信息已保存'
}

async function addTag(name: string): Promise<void> {
  const found = library.tags.find((t) => t.name === name)
  const tag =
    found ||
    (await library.saveTag({
      id: '',
      name,
      color: COLOR_PALETTE[library.tags.length % COLOR_PALETTE.length],
      createdAt: 0
    }))
  if (tag && !form.tagIds.includes(tag.id)) form.tagIds = [...form.tagIds, tag.id]
}

async function removeTag(id: string): Promise<void> {
  form.tagIds = form.tagIds.filter((t) => t !== id)
  await library.removeTag(id)
}

async function refreshMeta(): Promise<void> {
  if (!book.value) return
  library.message = '正在联网补全…'
  const patch = await invoke(CH.metadataRefresh, book.value.id)
  await library.load()
  library.message = patch ? '元数据已补全' : '未找到更多在线信息（离线或已完整）'
}

async function removeBook(deleteFile: boolean): Promise<void> {
  if (!book.value) return
  const tip = deleteFile
    ? '将同时删除磁盘上的 EPUB 文件，此操作不可恢复。\n还原方式：使用回收站软件或从备份重新导入。确定继续？'
    : '仅从书库移除记录，原始文件不会删除。确定继续？'
  if (!window.confirm(tip)) return
  await library.removeBooks([book.value.id], deleteFile)
}
</script>

<template>
  <transition name="slide">
    <div v-if="book" class="drawer-mask" @click.self="library.selectedId = null">
      <aside class="drawer">
        <header class="head">
          <b>书籍详情</b>
          <button class="btn-icon" title="关闭" @click="library.selectedId = null">✕</button>
        </header>

        <div class="scroll">
          <div class="hero">
            <img :src="cover" :alt="book.title" />
            <div class="hero-info">
              <div class="hero-title clamp-2">{{ book.title }}</div>
              <div class="muted">{{ book.authors.join(' · ') || '佚名' }}</div>
              <div class="stars">
                <button
                  v-for="n in 5"
                  :key="n"
                  :class="{ on: n <= form.rating }"
                  @click="form.rating = form.rating === n ? 0 : n"
                >★</button>
              </div>
              <button class="btn btn-primary read-btn" @click="router.push({ name: 'reader', params: { id: book.id } })">
                开始阅读
              </button>
            </div>
          </div>

          <div class="kv">
            <span>文件大小</span><span>{{ formatSize(book.fileSize) }}</span>
            <span>加入时间</span><span>{{ formatDate(book.addedAt) }}</span>
            <span>最近阅读</span><span>{{ formatDate(book.lastReadAt) }}</span>
            <span>章节数</span><span>{{ book.chapterCount }}</span>
            <span>元数据</span><span>{{ book.metadataSource === 'merged' ? '本地 + 在线' : '本地 OPF' }}</span>
          </div>

          <div class="form">
            <div class="field"><label>书名</label><input v-model="form.title" class="input" /></div>
            <div class="field"><label>作者（逗号分隔）</label><input v-model="form.authorsText" class="input" /></div>
            <div class="two">
              <div class="field"><label>出版社</label><input v-model="form.publisher" class="input" /></div>
              <div class="field"><label>ISBN</label><input v-model="form.isbn" class="input" /></div>
            </div>
            <div class="field"><label>简介</label><textarea v-model="form.description" class="input area" rows="3" /></div>

            <div class="field">
              <label>分类</label>
              <select v-model="form.categoryId" class="input">
                <option value="">未分类</option>
                <option v-for="c in library.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>

            <div class="field">
              <label>标签</label>
              <TagPicker
                v-model="form.tagIds"
                :tags="library.tags"
                @create="addTag"
                @remove="removeTag"
              />
            </div>

            <div class="field">
              <label>阅读状态</label>
              <div class="segment">
                <button
                  v-for="s in (['unread', 'reading', 'finished'] as ReadingStatus[])"
                  :key="s"
                  :class="{ on: form.status === s }"
                  @click="form.status = s"
                >{{ STATUS_LABEL[s] }}</button>
              </div>
            </div>

            <label class="check">
              <input v-model="form.favorite" type="checkbox" /> 加入收藏
            </label>

            <div v-if="book.subjects.length" class="subjects">
              <span v-for="s in book.subjects.slice(0, 8)" :key="s">{{ s }}</span>
            </div>

            <button class="btn btn-primary save" @click="save">保存修改</button>
          </div>

          <div class="actions">
            <button class="btn btn-ghost" @click="refreshMeta">联网补全元数据</button>
            <button class="btn btn-ghost" @click="library.reveal(book.id)">打开文件位置</button>
            <button class="btn btn-danger" @click="removeBook(false)">移出书库</button>
            <button class="btn btn-danger" @click="removeBook(true)">删除文件</button>
          </div>
          <p class="warn">「移出书库」只删除应用内的记录，不会删除磁盘文件；「删除文件」会连同 EPUB 一起删除。</p>
        </div>
      </aside>
    </div>
  </transition>
</template>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 26, 38, 0.32);
  z-index: 40;
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: 420px;
  height: 100%;
  background: var(--c-surface);
  box-shadow: var(--sh-3);
  display: flex;
  flex-direction: column;
}
.head {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  border-bottom: 1px solid var(--c-border);
}
.scroll { flex: 1; overflow: auto; padding: 18px; }
.hero { display: flex; gap: 16px; }
.hero img { width: 106px; height: 148px; object-fit: cover; border-radius: 5px; box-shadow: var(--sh-1); }
.hero-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.hero-title { font-size: 17px; font-weight: 600; line-height: 1.4; }
.stars { display: flex; gap: 2px; }
.stars button { color: #d8dde6; font-size: 18px; line-height: 1; }
.stars button.on { color: #f5b73d; }
.read-btn { margin-top: auto; }
.kv {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 6px 12px;
  margin: 18px 0;
  padding: 12px;
  background: var(--c-surface-2);
  border-radius: var(--r-m);
  font-size: var(--fs-sm);
}
.kv span:nth-child(odd) { color: var(--c-text-3); }
.form { display: flex; flex-direction: column; gap: 13px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.area { height: auto; padding: 8px 11px; resize: vertical; line-height: 1.6; }
.segment { display: flex; gap: 6px; }
.segment button {
  flex: 1;
  height: 30px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-s);
  color: var(--c-text-2);
  font-size: var(--fs-md);
}
.segment button.on { background: var(--c-primary-weak); border-color: var(--c-primary); color: var(--c-primary); }
.check { display: flex; align-items: center; gap: 7px; font-size: var(--fs-md); color: var(--c-text-2); }
.subjects { display: flex; flex-wrap: wrap; gap: 5px; }
.subjects span {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--c-surface-3);
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.save { margin-top: 4px; height: 36px; }
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--c-border);
}
.warn { font-size: var(--fs-xs); color: var(--c-text-3); line-height: 1.7; margin-top: 10px; }

@media (max-width: 640px) {
  /* 手机宽度下 420px 抽屉会溢出，改为占满整屏的详情页 */
  .drawer { width: 100%; }
  .scroll { padding: 14px; }
  .hero { gap: 12px; }
  .hero img { width: 84px; height: 118px; }
  .hero-title { font-size: 15px; }
  .two { grid-template-columns: 1fr; }
  .actions { margin-top: 18px; }
}
</style>
