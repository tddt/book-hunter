<script setup lang="ts">
import { computed } from 'vue'
import { coverUrl, placeholderCover, formatSize } from '../api'
import AppIcon from './AppIcon.vue'
import { STATUS_LABEL } from '@shared/constants'
import type { Book, ReadingProgress, Tag } from '@shared/types'

const props = defineProps<{
  book: Book
  progress?: ReadingProgress | null
  mode: 'grid' | 'list'
  tags: Tag[]
}>()

const emit = defineEmits<{
  open: [book: Book]
  detail: [book: Book]
  menu: [book: Book, event: MouseEvent]
}>()

const cover = computed(() =>
  props.book.cover ? coverUrl(props.book.cover) : placeholderCover(props.book.title)
)
const percent = computed(() => Math.round((props.progress?.percentage || 0) * 100))
const bookTags = computed(() =>
  props.book.tagIds
    .map((id) => props.tags.find((t) => t.id === id))
    .filter((t): t is Tag => Boolean(t))
    .slice(0, 3)
)
const authors = computed(() => props.book.authors.join(' · ') || '佚名')
</script>

<template>
  <article
    v-if="mode === 'grid'"
    class="card grid-card panel"
    @dblclick="emit('open', book)"
    @click="emit('detail', book)"
  >
    <div class="cover-wrap">
      <img :src="cover" :alt="book.title" loading="lazy" draggable="false" />
      <span v-if="book.favorite" class="fav">★</span>
      <span class="status" :class="book.status">{{ STATUS_LABEL[book.status] }}</span>
      <button class="more" title="更多操作" @click.stop="emit('menu', book, $event)">
        <AppIcon name="dots" :size="16" :stroke-width="2.4" />
      </button>
      <div v-if="percent" class="cover-progress"><i :style="{ width: `${percent}%` }" /></div>
    </div>
    <div class="meta">
      <div class="title ellipsis" :title="book.title">{{ book.title }}</div>
      <div class="author ellipsis">{{ authors }}</div>
      <div class="foot">
        <div class="dots">
          <i v-for="t in bookTags" :key="t.id" class="tag-dot" :style="{ background: t.color }" :title="t.name" />
        </div>
        <span class="muted size">{{ percent ? `${percent}%` : '' }}</span>
      </div>
    </div>
  </article>

  <article v-else class="card list-card panel" @dblclick="emit('open', book)" @click="emit('detail', book)">
    <img class="list-cover" :src="cover" :alt="book.title" loading="lazy" draggable="false" />
    <div class="list-main">
      <div class="title ellipsis">{{ book.title }}</div>
      <div class="author ellipsis">{{ authors }} · {{ book.publisher || '未知出版方' }}</div>
      <div class="list-bar"><i :style="{ width: `${percent}%` }" /></div>
    </div>
    <div class="list-side">
      <span class="status" :class="book.status">{{ STATUS_LABEL[book.status] }}</span>
      <span class="muted">{{ formatSize(book.fileSize) }}</span>
      <div class="dots">
        <i v-for="t in bookTags" :key="t.id" class="tag-dot" :style="{ background: t.color }" />
      </div>
    </div>
    <button class="more" title="更多操作" @click.stop="emit('menu', book, $event)">
      <AppIcon name="dots" :size="16" :stroke-width="2.4" />
    </button>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.24s var(--ease-out), box-shadow 0.24s var(--ease-out),
    border-color 0.2s var(--ease);
}
.card:hover {
  transform: translateY(-5px);
  box-shadow: var(--sh-3);
  border-color: rgba(107, 140, 245, 0.45);
}
.grid-card {
  display: flex;
  flex-direction: column;
}
.cover-wrap {
  position: relative;
  /* 与紧凑网格列宽配套（146px 列 / 176px 封面），仍接近纸质书 1:1.2 的比例 */
  height: 176px;
  background: var(--c-surface-3);
  overflow: hidden;
}
/* 封面底部暗角，让状态胶囊与进度条始终清晰 */
.cover-wrap::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(16, 24, 44, 0) 60%, rgba(16, 24, 44, 0.24) 100%);
  pointer-events: none;
}
.cover-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.42s var(--ease-out);
}
.grid-card:hover .cover-wrap img { transform: scale(1.04); }
.fav {
  position: absolute;
  top: 9px;
  right: 9px;
  z-index: 2;
  width: 25px;
  height: 25px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-glass-3);
  color: var(--c-accent);
  font-size: 14px;
  box-shadow: var(--sh-1);
}
.status {
  position: absolute;
  left: 9px;
  bottom: 10px;
  z-index: 2;
  padding: 3px 9px;
  border-radius: var(--r-pill);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.2px;
  color: #fff;
  background: rgba(24, 33, 54, 0.7);
  backdrop-filter: blur(6px);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}
.status.reading { background: rgba(63, 104, 216, 0.9); }
.status.finished { background: rgba(55, 147, 108, 0.9); }
.more {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-glass-3);
  color: var(--c-text-2);
  box-shadow: var(--sh-1);
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 0.16s var(--ease), transform 0.16s var(--ease), color 0.16s;
}
.more:hover { color: var(--c-primary); }
.grid-card:hover .more,
.list-card:hover .more { opacity: 1; transform: none; }
.fav + .more { top: 40px; }
.cover-progress,
.list-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  height: 3px;
  background: rgba(0, 0, 0, 0.08);
}
.cover-progress i,
.list-bar i {
  display: block;
  height: 100%;
  background: var(--c-grad-primary);
  border-radius: 0 3px 3px 0;
}
.meta {
  padding: 9px 10px 10px;
}
.title {
  font-size: 14px;
  font-weight: 620;
  letter-spacing: 0.1px;
  color: var(--c-text);
}
.author {
  margin-top: 5px;
  font-size: var(--fs-sm);
  color: var(--c-text-3);
}
.foot {
  margin-top: 11px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 14px;
}
/* 紧凑网格内的文字层级：列表视图维持原字号不变 */
.grid-card .title { font-size: 13px; line-height: 1.35; }
.grid-card .author { margin-top: 3px; font-size: 11px; line-height: 1.35; }
.grid-card .foot { margin-top: 7px; min-height: 12px; }
.grid-card .status { left: 7px; bottom: 8px; padding: 2px 7px; font-size: 9px; }
.grid-card .fav { top: 7px; right: 7px; width: 22px; height: 22px; font-size: 12px; }
.grid-card .more { top: 7px; right: 7px; width: 24px; height: 24px; }
.grid-card .fav + .more { top: 34px; }
.dots { display: flex; gap: 5px; }
.size { font-size: var(--fs-xs); }

.list-card {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 11px 15px;
  margin-bottom: 10px;
  height: 86px;
}
.list-card:hover { transform: translateY(-2px); }
.list-cover {
  width: 46px;
  height: 64px;
  object-fit: cover;
  border-radius: var(--r-xs);
  box-shadow: 0 2px 8px rgba(23, 32, 53, 0.14);
  flex: none;
}
.list-main { flex: 1; min-width: 0; position: relative; }
.list-main .author { margin-top: 6px; }
.list-bar { position: static; width: 62%; height: 4px; margin-top: 10px; border-radius: 999px; }
.list-bar i { border-radius: 999px; }
.list-side {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: var(--fs-sm);
}
.list-side .status {
  position: static;
  backdrop-filter: none;
  box-shadow: none;
}
.list-card .more {
  position: static;
  flex: none;
  transform: none;
  box-shadow: none;
  background: transparent;
}

@media (max-width: 640px) {
  .list-card { gap: 10px; padding: 9px 10px; height: 76px; }
  .list-cover { width: 40px; height: 56px; }
  .list-side { gap: 8px; }
  .list-side .size,
  .list-side .dots { display: none; }
  .list-bar { width: 82%; }
  .grid-card .title { font-size: 12px; }
}
</style>
