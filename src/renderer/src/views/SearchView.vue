<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { CH, coverUrl, highlightHtml, invoke, placeholderCover } from '../api'
import AppIcon from '../components/AppIcon.vue'
import { useSearchStore } from '../stores/search'
import { useLibraryStore } from '../stores/library'
import type { SearchHit } from '@shared/types'

const search = useSearchStore()
const library = useLibraryStore()
const router = useRouter()
const inputEl = ref<HTMLInputElement | null>(null)

const scanning = computed(
  () => search.progress?.phase === 'content' && search.busy && Boolean(search.progress.total)
)
const suggestions = ['章节', '前言', '导读', '序', '结语', '第一章']

onMounted(() => {
  inputEl.value?.focus()
  void search.run()
})

function onInput(event: Event): void {
  search.setText((event.target as HTMLInputElement).value)
}

function useSuggestion(word: string): void {
  search.setText(word)
  if (inputEl.value) inputEl.value.value = word
}

function openHit(hit: SearchHit): void {
  const query: Record<string, string> = {}
  if (hit.chapterIndex !== undefined) query.chapter = String(hit.chapterIndex)
  // 带上命中偏移，阅读器才能翻到命中所在的那一页，而不是只停在章节开头
  if (hit.offset !== undefined) query.o = String(hit.offset)
  if (hit.matched.length) query.q = hit.matched[0]
  void router.push({ name: 'reader', params: { id: hit.bookId }, query })
}

function coverOf(hit: SearchHit): string {
  return hit.cover ? coverUrl(hit.cover) : placeholderCover(hit.title)
}

const rebuilding = ref(false)
async function rebuildContentCache(): Promise<void> {
  if (rebuilding.value) return
  rebuilding.value = true
  try {
    const result = await invoke(CH.searchRebuildContent)
    library.message = `正文缓存：新建 ${result.built} 本，已有 ${result.skipped} 本，失败 ${result.failed} 本`
    await search.run()
  } catch (cause) {
    library.message = `重建失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    rebuilding.value = false
  }
}
</script>

<template>
  <div class="search-view">
    <header class="hero">
      <h1>全文搜索</h1>
      <p class="muted">同时检索书名、作者、分类、标签与整本书的正文内容</p>
      <div class="search-box">
        <AppIcon name="search" :size="20" class="icon" />
        <input
          ref="inputEl"
          :value="search.text"
          type="text"
          placeholder="输入关键词，例如「认知」「设计模式」「第一章」"
          @input="onInput"
          @keyup.enter="search.run()"
        />
        <button v-if="search.text" class="clear" title="清空" @click="search.setText(''); if (inputEl) inputEl.value = ''">✕</button>
        <button class="btn btn-primary go" @click="search.run()">搜索</button>
      </div>

      <div class="filters">
        <select v-model="search.categoryId" class="input" @change="search.run()">
          <option :value="undefined">全部分类</option>
          <option v-for="c in library.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <label class="check"><input v-model="search.favoriteOnly" type="checkbox" @change="search.run()" /> 仅收藏</label>
        <span class="spacer" />
        <span v-if="search.hits.length" class="muted stat">
          书名 {{ search.metaHits.length }} 条 · 正文 {{ search.contentHits.length }} 条（共 {{ search.contentTotal }} 处） · 耗时 {{ search.took }} ms
        </span>
      </div>

      <div v-if="scanning && search.progress" class="scan">
        <span>正在扫描正文 {{ search.progress.done }} / {{ search.progress.total }} 本…</span>
        <div class="scan-bar">
          <i :style="{ width: `${(search.progress.done / Math.max(1, search.progress.total)) * 100}%` }" />
        </div>
      </div>

      <div v-if="search.error" class="notice err">检索失败：{{ search.error }}</div>
      <div v-if="search.hint" class="notice warn">
        <span>{{ search.hint }}</span>
        <button class="btn btn-ghost mini" :disabled="rebuilding" @click="rebuildContentCache">
          {{ rebuilding ? '正在重建…' : '重建正文缓存' }}
        </button>
      </div>
      <div v-else-if="search.truncated && search.text" class="notice">
        正文共命中 {{ search.contentTotal }} 处，这里只展示最相关的 {{ search.contentHits.length }} 条；换更具体的关键词可以缩小范围。
      </div>
    </header>

    <div class="results">
      <section class="col">
        <div class="col-head">
          <b>书名 / 元数据</b>
          <span class="badge">{{ search.metaHits.length }}</span>
        </div>
        <div class="col-scroll">
          <button
            v-for="hit in search.metaHits"
            :key="`m-${hit.bookId}`"
            class="meta-hit panel"
            @click="openHit(hit)"
          >
            <img :src="coverOf(hit)" :alt="hit.title" />
            <div class="m-info">
              <div class="m-title ellipsis" v-html="highlightHtml(hit.title, hit.matched)" />
              <div class="m-author ellipsis">{{ hit.authors.join(' · ') || '佚名' }}</div>
              <div class="m-terms">
                <span v-for="t in hit.matched.slice(0, 4)" :key="t">{{ t }}</span>
              </div>
            </div>
            <span class="m-score">{{ hit.score.toFixed(0) }}</span>
          </button>
          <div v-if="!search.metaHits.length" class="col-empty muted">没有书名 / 元数据命中</div>
        </div>
      </section>

      <section class="col wide">
        <div class="col-head">
          <b>正文命中</b>
          <span class="badge">{{ search.contentHits.length }}</span>
          <span class="muted tip">点击片段直接跳到该章阅读</span>
        </div>
        <div class="col-scroll">
          <button
            v-for="(hit, i) in search.contentHits"
            :key="`c-${hit.bookId}-${hit.chapterIndex}-${i}`"
            class="content-hit panel"
            @click="openHit(hit)"
          >
            <div class="c-head">
              <img :src="coverOf(hit)" :alt="hit.title" />
              <span class="c-title ellipsis">{{ hit.title }}</span>
              <span class="c-chapter ellipsis">{{ hit.chapterTitle || `第 ${(hit.chapterIndex || 0) + 1} 节` }}</span>
              <span class="c-go">跳转到章节 →</span>
            </div>
            <p class="c-snippet" v-html="highlightHtml(hit.snippet || '', hit.matched)" />
          </button>
          <div v-if="!search.contentHits.length" class="col-empty muted">
            <template v-if="search.text">
              没有正文命中
              <template v-if="search.searchableBooks === 0">
                <br />当前没有可检索的正文缓存
                <button class="btn btn-ghost mini" :disabled="rebuilding" @click="rebuildContentCache">
                  {{ rebuilding ? '正在重建…' : '立即重建' }}
                </button>
              </template>
            </template>
            <template v-else>输入关键词开始检索</template>
          </div>
        </div>
      </section>
    </div>

    <div v-if="!search.text" class="suggest">
      <span class="muted">试试搜索：</span>
      <button v-for="s in suggestions" :key="s" @click="useSuggestion(s)">{{ s }}</button>
    </div>
  </div>
</template>

<style scoped>
.search-view { height: 100%; display: flex; flex-direction: column; padding: 20px 22px 14px; }
.hero { flex: none; }
.hero h1 { margin: 0 0 4px; font-size: var(--fs-xxl); font-weight: 650; }
.hero p { margin: 0 0 16px; font-size: var(--fs-md); }
.search-box {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 6px 0 16px;
  background: var(--c-surface);
  border: 1.5px solid var(--c-border);
  border-radius: var(--r-m);
  box-shadow: var(--sh-1);
  transition: border-color 0.16s, box-shadow 0.16s;
}
.search-box:focus-within { border-color: var(--c-primary); box-shadow: 0 0 0 4px rgba(59, 111, 212, 0.1); }
.search-box .icon { color: var(--c-text-3); }
.search-box input { flex: 1; height: 100%; border: none; outline: none; background: transparent; font-size: 16px; user-select: text; }
.search-box .clear { color: var(--c-text-3); padding: 0 6px; }
.search-box .go { height: 36px; padding: 0 22px; }
.filters { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.filters .input { height: 30px; width: 150px; }
.check { display: flex; align-items: center; gap: 6px; color: var(--c-text-2); font-size: var(--fs-md); }
.stat { font-size: var(--fs-sm); }
.scan { margin-top: 10px; font-size: var(--fs-sm); color: var(--c-primary); }
.scan-bar { height: 3px; background: var(--c-surface-3); border-radius: 3px; margin-top: 6px; overflow: hidden; }
.scan-bar i { display: block; height: 100%; background: var(--c-primary); transition: width 0.15s; }
.notice { margin-top: 10px; padding: 8px 12px; border-radius: var(--r-s); background: var(--c-surface-2); border: 1px solid var(--c-border); font-size: var(--fs-sm); color: var(--c-text-2); display: flex; align-items: center; gap: 12px; }
.notice.err { color: var(--c-danger); background: var(--c-danger-weak); border-color: rgba(200, 60, 60, .28); }
.notice.warn { color: var(--c-warn); background: var(--c-accent-weak); border-color: rgba(220, 165, 40, .3); }
.notice span { flex: 1; }
.btn.mini { height: 26px; padding: 0 12px; font-size: var(--fs-sm); flex: none; }

.results { flex: 1; min-height: 0; display: flex; gap: 16px; margin-top: 16px; }
.col { flex: 0 0 316px; display: flex; flex-direction: column; min-height: 0; }
.col.wide { flex: 1; min-width: 0; }
.col-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 10px; }
.badge { padding: 1px 7px; border-radius: 9px; background: var(--c-primary-weak); color: var(--c-primary); font-size: var(--fs-xs); }
.tip { margin-left: auto; font-size: var(--fs-xs); }
.col-scroll { flex: 1; overflow: auto; padding-right: 4px; }
.meta-hit {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px;
  margin-bottom: 8px;
  text-align: left;
  transition: border-color 0.15s, transform 0.15s;
}
.meta-hit:hover { border-color: var(--c-primary); transform: translateX(2px); }
.meta-hit img { width: 38px; height: 52px; object-fit: cover; border-radius: 3px; flex: none; }
.m-info { flex: 1; min-width: 0; }
.m-title { font-size: 14px; font-weight: 600; }
.m-author { font-size: var(--fs-sm); color: var(--c-text-3); margin-top: 3px; }
.m-terms { display: flex; gap: 4px; margin-top: 5px; }
.m-terms span { padding: 1px 6px; border-radius: 8px; background: var(--c-surface-3); color: var(--c-text-2); font-size: 10px; }
.m-score { color: var(--c-text-3); font-size: var(--fs-xs); }
.content-hit { width: 100%; display: block; padding: 12px 14px; margin-bottom: 9px; text-align: left; transition: border-color 0.15s; }
.content-hit:hover { border-color: var(--c-primary); }
.c-head { display: flex; align-items: center; gap: 9px; }
.c-head img { width: 22px; height: 30px; object-fit: cover; border-radius: 2px; flex: none; }
.c-title { font-weight: 600; max-width: 220px; }
.c-chapter { color: var(--c-text-3); font-size: var(--fs-sm); max-width: 200px; }
.c-go { margin-left: auto; color: var(--c-primary); font-size: var(--fs-sm); white-space: nowrap; }
.c-snippet { margin: 9px 0 0; line-height: 1.85; font-size: 14px; color: var(--c-text-2); }
.col-empty { padding: 30px 8px; text-align: center; line-height: 1.7; }
.suggest { flex: none; display: flex; align-items: center; gap: 8px; padding-top: 10px; }
.suggest button { padding: 3px 11px; border-radius: 12px; background: var(--c-surface); border: 1px solid var(--c-border); color: var(--c-text-2); font-size: var(--fs-sm); }
.suggest button:hover { color: var(--c-primary); border-color: var(--c-primary); }

@media (max-width: 640px) {
  .search-view { padding: 14px 12px 10px; }
  .hero h1 { font-size: 22px; }
  .hero p { margin-bottom: 12px; }
  .search-box { height: 44px; padding-left: 12px; gap: 7px; }
  .search-box input { font-size: 15px; min-width: 0; }
  .search-box .go { padding: 0 13px; }
  .filters { flex-wrap: wrap; gap: 8px; }
  .filters .input { width: 128px; }
  /* 双栏结果在手机上改为上下堆叠，上半区固定高度可单独滚动 */
  .results { flex-direction: column; gap: 10px; margin-top: 12px; }
  .col { flex: 0 0 34%; max-height: 34%; }
  .col.wide { flex: 1; min-height: 0; }
  .c-title, .c-chapter { max-width: 42vw; }
  .c-snippet { font-size: var(--fs-md); }
  .tip { display: none; }
}
</style>
