<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { CH, invoke, placeholderCover } from '../api'
import AppIcon from '../components/AppIcon.vue'
import { OPDS_PRESETS, useOnlineStore } from '../stores/online'
import type { OnlineBook, OnlineDownloadProgress, OnlineSourceInfo } from '@shared/types'

const router = useRouter()
const online = useOnlineStore()
const showSources = ref(true)
const showTools = ref(false)

onMounted(async () => {
  await online.loadSources()
  // 首屏只探测已启用的书源，避免不可达站点把「探测中」拖到十几秒；
  // 需要诊断全部书源时用面板里的「重新探测」
  void online.probe(online.enabledSources.map((s) => s.id))
  // 热门书单是首屏默认内容，无需输入关键词即可浏览 / 下载
  await online.loadFeatured()
})

const phaseLabel: Record<OnlineDownloadProgress['phase'], string> = {
  connecting: '连接中',
  downloading: '下载中',
  validating: '校验 EPUB',
  importing: '导入书库',
  done: '完成',
  error: '失败'
}

const resultSummary = computed(() =>
  online.sourceResults
    .map((s) => {
      const name = online.sources.find((x) => x.id === s.sourceId)?.name || s.sourceId
      return s.error ? `${name}: ${s.error}` : `${name}: ${s.books.length} 本`
    })
    .join(' · ')
)

function coverOf(book: OnlineBook): string {
  return book.coverData || placeholderCover(book.title)
}

function sourceName(id: string): string {
  return online.sources.find((s) => s.id === id)?.name || id
}

function healthLabel(source: OnlineSourceInfo): string {
  if (source.healthy === undefined) return '未探测'
  return source.healthy ? `可达 ${source.latencyMs}ms` : source.lastError || '不可达'
}

function isSelected(source: OnlineSourceInfo): boolean {
  return online.selected.length ? online.selected.includes(source.id) : source.enabled
}

function percent(job: OnlineDownloadProgress): number {
  if (job.phase === 'done') return 100
  if (job.phase === 'importing' || job.phase === 'validating') return 100
  if (!job.total) return 0
  return Math.min(100, Math.round((job.received / job.total) * 100))
}

function importedFor(book: OnlineBook): string | undefined {
  const hit = online.jobList.find(
    (j) => j.bookId === book.id && j.phase === 'done' && j.importedBookId
  )
  return hit?.importedBookId
}

function openBook(id: string): void {
  void router.push({ name: 'reader', params: { id } })
}

function openExternal(url?: string): void {
  // 渲染层 CSP 不放行外部链接，统一交给主进程用系统浏览器打开
  if (url) void invoke(CH.shellOpen, url)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

const currentGroupLabel = computed(
  () => online.featuredGroups.find((g) => g.sourceId === online.featuredTab)?.label || ''
)

function refreshFeatured(): void {
  const tab = online.featuredTab
  void online.loadFeatured(true, tab === 'all' ? undefined : [tab])
}
</script>

<template>
  <div class="online-view">
    <header class="hero">
      <h1>在线取书</h1>
      <p class="muted">
        聚合公有领域 / 免费授权书源，搜索、下载、校验后自动导入书库。
        <b class="license">仅提供公版与开放获取内容，不接入盗版站点、不绕过付费墙或 DRM。</b>
      </p>

      <div class="search-box">
        <AppIcon name="search" :size="20" class="icon" />
        <input
          v-model="online.text"
          type="text"
          placeholder="输入书名或作者，例如 Pride / Austen / 论语"
          @keyup.enter="online.run()"
        />
        <button v-if="online.text" class="clear" title="清空并返回热门书单" @click="online.text = ''; void online.openFeatured()">✕</button>
        <button class="btn btn-primary go" :disabled="online.busy" @click="online.run()">
          {{ online.busy ? '搜索中…' : '搜索' }}
        </button>
      </div>

      <div class="view-tabs">
        <button :class="{ on: online.mode === 'featured' }" @click="online.openFeatured()">
          ✦ 热门书单
        </button>
        <button :class="{ on: online.mode === 'search' }" @click="online.mode = 'search'">
          搜索结果<span v-if="online.books.length">（{{ online.books.length }}）</span>
        </button>
        <span class="spacer" />
        <span v-if="online.mode === 'search' && online.books.length" class="muted stat">
          找到 {{ online.books.length }} 本 · 耗时 {{ online.took }} ms
        </span>
        <span v-else-if="online.mode === 'featured' && online.featured" class="muted stat">
          {{ online.featured.groups.length }} 个榜单 · 共 {{ online.featured.books.length }} 本 · {{ online.featured.took }} ms
        </span>
      </div>

      <div v-if="online.mode === 'featured'" class="featured-tabs">
        <button :class="{ on: online.featuredTab === 'all' }" @click="online.selectFeaturedTab('all')">全部</button>
        <button
          v-for="group in online.featuredGroups"
          :key="group.sourceId"
          :class="{ on: online.featuredTab === group.sourceId }"
          :title="group.error || group.label"
          @click="online.selectFeaturedTab(group.sourceId)"
        >
          {{ sourceName(group.sourceId) }} · {{ group.books.length }}
        </button>
        <span class="muted f-label">{{ currentGroupLabel }}</span>
        <button class="link-btn" :disabled="online.featuredBusy" @click="refreshFeatured">
          {{ online.featuredBusy ? '载入中…' : '刷新榜单' }}
        </button>
      </div>

      <div class="filters">
        <button class="link-btn" @click="showSources = !showSources">
          书源管理 {{ showSources ? '▴' : '▾' }}（{{ online.enabledSources.length }} / {{ online.sources.length }} 启用）
        </button>
        <button class="link-btn" @click="showTools = !showTools">
          直链 / OPDS {{ showTools ? '▴' : '▾' }}
        </button>
      </div>

      <div v-if="online.error" class="notice err">{{ online.error }}</div>
      <div v-if="online.featuredError" class="notice err">热门书单载入失败：{{ online.featuredError }}</div>
      <div v-if="online.mode === 'search' && resultSummary" class="summary muted">{{ resultSummary }}</div>

      <!-- 书源管理：健康状态、启用开关、参与本次搜索 -->
      <div v-if="showSources" class="panel source-panel">
        <div class="panel-head">
          <b>书源</b>
          <span class="muted">点击名称前的勾选框可限定本次搜索范围；灰色代表当前网络不可达</span>
          <span class="spacer" />
          <button class="btn btn-ghost mini" :disabled="online.probing" @click="online.probe()">
            {{ online.probing ? '探测中…' : '重新探测' }}
          </button>
        </div>
        <div class="source-list">
          <div v-for="source in online.sources" :key="source.id" class="source-row" :class="{ off: !source.enabled }">
            <label class="pick">
              <input type="checkbox" :checked="isSelected(source)" :disabled="!source.enabled" @change="online.toggleSelected(source.id)" />
            </label>
            <span class="dot" :class="{ ok: source.healthy === true, bad: source.healthy === false }" :title="healthLabel(source)" />
            <div class="s-info">
              <div class="s-name">{{ source.name }} <span v-if="!source.builtIn" class="tag">自定义</span></div>
              <div class="s-desc muted">{{ source.description }}</div>
              <div class="s-meta muted">{{ source.language }} · {{ source.license }} · {{ healthLabel(source) }}</div>
            </div>
            <button class="btn btn-ghost mini" title="查看该书源的热门 / 精选书单" @click="online.openFeatured(source.id)">热门</button>
            <button class="btn btn-ghost mini" @click="online.toggleEnabled(source)">
              {{ source.enabled ? '停用' : '启用' }}
            </button>
            <button v-if="!source.builtIn && source.endpoint" class="btn btn-ghost mini danger" @click="online.removeOpds(source.endpoint ? source.id.replace(/^opds:/, '') : '')">删除</button>
          </div>
          <div v-if="!online.sources.length" class="empty muted">正在加载书源…</div>
        </div>
      </div>

      <!-- URL 直链 + 自定义 OPDS -->
      <div v-if="showTools" class="panel tools-panel">
        <div class="tool-block">
          <div class="tool-title"><b>URL 直链导入</b><span class="muted">粘贴任意 EPUB 直链，自动下载 / 校验 / 入库</span></div>
          <div class="tool-row">
            <input v-model="online.directUrl" class="input" placeholder="https://example.org/book.epub" @keyup.enter="online.importDirectUrl()" />
            <button class="btn btn-primary" @click="online.importDirectUrl()">下载并导入</button>
          </div>
          <p class="note">仅导入你有权获取的内容。支持下载确认页的自动跟随、多通道重试与 EPUB 结构校验；单本上限 80 MB。</p>
        </div>
        <div class="tool-block">
          <div class="tool-title"><b>自定义 OPDS 目录</b><span class="muted">接入任意 OPDS 1.x 书库，突破内置源的网络限制</span></div>
          <div class="presets">
            <button v-for="p in OPDS_PRESETS" :key="p.endpoint" @click="online.usePreset(p)">{{ p.name }}</button>
          </div>
          <div class="tool-row">
            <input v-model="online.opdsDraft.name" class="input" placeholder="书源名称" />
            <input v-model="online.opdsDraft.endpoint" class="input wide" placeholder="OPDS 地址，可用 {searchTerms} 作为关键词占位符" />
            <button class="btn btn-primary" @click="online.saveOpds()">添加</button>
          </div>
          <p class="note">地址含 <code>&#123;searchTerms&#125;</code> 时按模板搜索，否则拉取目录首页并在本地按书名 / 作者过滤。</p>
        </div>
      </div>
    </header>

    <!-- 下载任务 -->
    <div v-if="online.jobList.length" class="jobs">
      <div class="jobs-head">
        <b>下载任务（{{ online.activeJobs.length }} 进行中）</b>
        <span class="spacer" />
        <button class="link-btn" @click="online.clearFinished()">清除已完成</button>
      </div>
      <div v-for="job in online.jobList" :key="job.jobId" class="job" :class="job.phase">
        <span class="j-title ellipsis">{{ job.title }}</span>
        <span class="j-phase">{{ phaseLabel[job.phase] }}</span>
        <div class="j-bar"><i :style="{ width: `${percent(job)}%` }" /></div>
        <span class="j-num">{{ job.total ? `${(job.received / 1048576).toFixed(1)} / ${(job.total / 1048576).toFixed(1)} MB` : '' }}</span>
        <span v-if="job.message" class="j-msg ellipsis">{{ job.message }}</span>
        <span v-if="job.error" class="j-err ellipsis" :title="job.error">{{ job.error }}</span>
        <button v-if="job.importedBookId" class="btn btn-ghost mini" @click="openBook(job.importedBookId!)">打开</button>
        <button v-else-if="job.phase !== 'done' && job.phase !== 'error'" class="btn btn-ghost mini" @click="online.cancel(job.jobId)">取消</button>
      </div>
    </div>

    <!-- 结果 -->
    <div class="results">
      <div v-if="online.mode === 'search' && online.busy && !online.books.length" class="empty muted">
        正在向各书源发起检索…
      </div>
      <div v-else-if="online.mode === 'featured' && online.featuredBusy && !online.featured" class="empty muted">
        正在载入各书源的热门榜单…
      </div>
      <template v-else>
        <article v-for="book in online.displayedBooks" :key="book.id" class="book-card panel">
          <img class="cover" :src="coverOf(book)" :alt="book.title" />
          <div class="b-info">
            <div class="b-title ellipsis" :title="book.title">{{ book.title }}</div>
            <div class="b-author ellipsis muted">{{ book.authors.join(' · ') || '佚名' }}</div>
            <div class="b-tags">
              <span class="chip">{{ sourceName(book.sourceId) }}</span>
              <span v-if="book.badge" class="chip hot">{{ book.badge }}</span>
              <span v-if="book.popularity" class="chip">↓ {{ formatNumber(book.popularity) }}</span>
              <span v-if="book.language" class="chip">{{ book.language }}</span>
              <span class="chip ok">{{ book.license }}</span>
            </div>
            <p v-if="book.description" class="b-desc">{{ book.description }}</p>
            <div class="b-foot">
              <span class="muted">{{ book.formats.length }} 个下载通道</span>
              <span class="spacer" />
              <button v-if="importedFor(book)" class="btn btn-ghost mini" @click="openBook(importedFor(book)!)">已在书库 · 打开</button>
              <button v-else-if="book.landingUrl" class="btn btn-ghost mini" @click="openExternal(book.landingUrl)">详情</button>
              <button class="btn btn-primary mini" :disabled="!book.downloadable" @click="online.download(book)">
                {{ book.downloadable ? '下载并入库' : '无 EPUB' }}
              </button>
            </div>
          </div>
        </article>
        <div v-if="!online.displayedBooks.length" class="empty muted">
          <template v-if="online.mode === 'search'">
            <template v-if="online.text">没有找到匹配的公版书。可换英文关键词试试，或启用更多书源。</template>
            <template v-else>输入关键词开始检索 · 也可以展开「直链 / OPDS」直接导入</template>
          </template>
          <template v-else-if="online.featuredError">书单载入失败，可点「刷新榜单」重试</template>
          <template v-else-if="online.featuredTab !== 'all'">该书源暂时没有返回书目，可切到「全部」或点书源管理里的「热门」重试</template>
          <template v-else>暂无可用的热门书单。可在「书源管理」里启用更多书源，或刷新榜单</template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.online-view { height: 100%; display: flex; flex-direction: column; padding: 20px 22px 0; overflow: hidden; }
.hero { flex: none; }
.hero h1 { margin: 0 0 4px; font-size: var(--fs-xxl); font-weight: 650; }
.hero > p { margin: 0 0 14px; font-size: var(--fs-md); line-height: 1.6; }
.license { color: var(--c-text-2); font-weight: 500; }
.search-box {
  display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 6px 0 16px;
  background: var(--c-surface); border: 1.5px solid var(--c-border); border-radius: var(--r-m);
  box-shadow: var(--sh-1); transition: border-color .16s, box-shadow .16s;
}
.search-box:focus-within { border-color: var(--c-primary); box-shadow: 0 0 0 4px rgba(59,111,212,.1); }
.search-box .icon { color: var(--c-text-3); }
.search-box input { flex: 1; height: 100%; border: none; outline: none; background: transparent; font-size: 15px; user-select: text; }
.search-box .clear { color: var(--c-text-3); padding: 0 6px; }
.search-box .go { height: 34px; padding: 0 20px; }
.view-tabs { display: flex; align-items: center; gap: 6px; margin-top: 12px; border-bottom: 1px solid var(--c-border); }
.view-tabs > button {
  padding: 7px 16px; border: none; border-bottom: 2px solid transparent; background: transparent;
  color: var(--c-text-2); font-size: var(--fs-md); font-weight: 600;
}
.view-tabs > button:hover { color: var(--c-primary); }
.view-tabs > button.on { color: var(--c-primary); border-bottom-color: var(--c-primary); }
.view-tabs .stat { margin-right: 4px; font-size: var(--fs-xs); }
.featured-tabs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.featured-tabs > button {
  padding: 3px 11px; border-radius: 13px; border: 1px solid var(--c-border);
  background: var(--c-surface); color: var(--c-text-2); font-size: var(--fs-xs);
}
.featured-tabs > button:hover { border-color: var(--c-primary); color: var(--c-primary); }
.featured-tabs > button.on { background: var(--c-grad-primary); border-color: var(--c-primary); color: #fff; }
.featured-tabs .link-btn { margin-left: auto; }
.featured-tabs .f-label { font-size: var(--fs-xs); margin-left: 6px; }
.filters { display: flex; align-items: center; gap: 14px; margin-top: 10px; }
.link-btn { color: var(--c-primary); font-size: var(--fs-sm); }
.link-btn:hover { text-decoration: underline; }
.spacer { flex: 1; }
.stat { font-size: var(--fs-sm); }
.summary { margin-top: 8px; font-size: var(--fs-xs); line-height: 1.6; }
.notice { margin-top: 10px; padding: 8px 12px; border-radius: var(--r-s); font-size: var(--fs-sm); }
.notice.err { color: var(--c-danger); background: var(--c-danger-weak); border: 1px solid rgba(200,60,60,.28); }

.panel-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--c-border); font-size: var(--fs-md); }
.panel-head .muted { font-size: var(--fs-xs); }
.source-panel { margin-top: 12px; max-height: 232px; display: flex; flex-direction: column; }
.source-list { overflow-y: auto; }
.source-row { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--c-border); }
.source-row.off { opacity: .55; }
.pick input { accent-color: var(--c-primary); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-text-3); flex: none; }
.dot.ok { background: #3fa89b; }
.dot.bad { background: #d96a6a; }
.s-info { flex: 1; min-width: 0; }
.s-name { font-size: var(--fs-sm); font-weight: 600; }
.tag { margin-left: 6px; padding: 1px 6px; border-radius: 8px; background: var(--c-surface-3); color: var(--c-text-2); font-size: 10px; font-weight: 400; }
.s-desc, .s-meta { font-size: var(--fs-xs); line-height: 1.5; }
.s-desc { margin-top: 2px; }
.btn.mini { height: 26px; padding: 0 11px; font-size: var(--fs-xs); flex: none; }
.btn.danger:hover { color: var(--c-danger); }

.tools-panel { margin-top: 10px; padding: 12px 14px; }
.tool-block + .tool-block { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--c-border); }
.tool-title { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; font-size: var(--fs-md); }
.tool-title .muted { font-size: var(--fs-xs); }
.tool-row { display: flex; gap: 8px; }
.tool-row .input.wide { flex: 2; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.presets button { padding: 3px 10px; border-radius: 12px; border: 1px solid var(--c-border); color: var(--c-text-2); font-size: var(--fs-xs); }
.presets button:hover { color: var(--c-primary); border-color: var(--c-primary); }
.note { margin: 8px 0 0; font-size: var(--fs-xs); line-height: 1.7; color: var(--c-text-3); }
code { padding: 1px 5px; border-radius: 3px; background: var(--c-surface-3); }

.jobs { flex: none; margin-top: 12px; border: 1px solid var(--c-border); border-radius: var(--r-m); background: var(--c-surface); }
.jobs-head { display: flex; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--c-border); font-size: var(--fs-sm); }
.job { display: flex; align-items: center; gap: 10px; padding: 7px 14px; border-bottom: 1px solid var(--c-border); font-size: var(--fs-xs); }
.job:last-child { border-bottom: none; }
.j-title { max-width: 210px; }
.j-phase { color: var(--c-primary); white-space: nowrap; }
.job.error .j-phase, .j-err { color: var(--c-danger); }
.job.done .j-phase, .j-msg { color: var(--c-success); }
.j-bar { width: 130px; height: 4px; border-radius: 3px; background: var(--c-surface-3); overflow: hidden; flex: none; }
.j-bar i { display: block; height: 100%; background: var(--c-primary); transition: width .2s; }
.j-num { color: var(--c-text-3); white-space: nowrap; }
.j-msg, .j-err { flex: 1; min-width: 0; }

.results { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; align-content: start; padding: 14px 2px 24px; }
.book-card { display: flex; gap: 12px; padding: 12px; min-height: 132px; }
.cover { width: 68px; height: 94px; object-fit: cover; border-radius: 4px; flex: none; background: var(--c-surface-3); }
.b-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.b-title { font-size: 14px; font-weight: 650; }
.b-author { font-size: var(--fs-xs); margin-top: 3px; }
.b-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chip { padding: 1px 7px; border-radius: 9px; background: var(--c-surface-3); color: var(--c-text-2); font-size: 10px; }
.chip.ok { background: var(--c-success-weak); color: var(--c-success); }
.chip.hot { background: var(--c-accent-weak); color: var(--c-warn); }
.b-desc { margin: 7px 0 0; font-size: var(--fs-xs); line-height: 1.6; color: var(--c-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.b-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 8px; font-size: var(--fs-xs); }
.empty { grid-column: 1 / -1; padding: 46px 10px; text-align: center; font-size: var(--fs-md); line-height: 1.7; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { opacity: .62; }

@media (max-width: 640px) {
  /* 窄屏 hero 折行会占掉大半屏，若仍让 .results 用 flex:1 抢剩余高度，
     grid 的 auto 行会被压到 30px 上下、书卡内容全被裁掉。
     改为整页滚动 + 书卡保底高度；桌面宽度布局完全不动。 */
  .online-view { padding: 14px 12px 12px; overflow-x: hidden; overflow-y: auto; }
  .hero h1 { font-size: 22px; }
  .hero > p { margin-bottom: 10px; }
  .search-box { height: 44px; padding-left: 12px; gap: 7px; }
  .search-box input { font-size: 15px; min-width: 0; }
  .search-box .go { padding: 0 12px; }
  .view-tabs { overflow-x: auto; gap: 2px; }
  .view-tabs > button { padding: 7px 10px; white-space: nowrap; }
  .featured-tabs .link-btn { margin-left: 0; }
  .filters { flex-wrap: wrap; gap: 8px; }
  .source-panel { max-height: 170px; }
  .tool-row { flex-wrap: wrap; }
  .tool-row .input.wide { flex: 1 1 100%; }
  .results {
    flex: none; min-height: 0; overflow: visible;
    grid-template-columns: 1fr; grid-auto-rows: minmax(132px, auto);
    gap: 9px; padding: 10px 0 20px;
  }
  .book-card { min-height: 132px; padding: 10px; }
  .cover { width: 58px; height: 82px; }
  .j-title { max-width: 110px; }
  .j-bar { width: 60px; }
}
</style>
