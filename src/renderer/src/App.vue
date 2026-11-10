<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CH, EV, invoke, on } from './api'
import { useLibraryStore } from './stores/library'
import { useSettingsStore } from './stores/settings'
import { useSearchStore } from './stores/search'
import { useOnlineStore } from './stores/online'
import { useTranslationStore } from './stores/translation'
import TitleBar from './components/TitleBar.vue'
import AppIcon from './components/AppIcon.vue'
import AboutDialog from './components/AboutDialog.vue'
import AppBoundary from './components/AppBoundary.vue'
import { nextMode, watchSystem } from './theme'

const route = useRoute()
const router = useRouter()
const library = useLibraryStore()
const settings = useSettingsStore()
const search = useSearchStore()
const online = useOnlineStore()
const translation = useTranslationStore()

const isReader = computed(() => route.name === 'reader')
const maximized = ref(false)
const toast = ref('')
const helpOpen = ref(false)
const helpTab = ref<'about' | 'keys' | 'diagnostics'>('about')
const runtimeError = ref('')
const disposers: Array<() => void> = []
let toastTimer: ReturnType<typeof setTimeout> | null = null

/** toast 语义：错误 / 成功 / 普通信息用不同色点，用户扫一眼就能判断结果 */
const toastKind = computed(() => {
  const text = toast.value
  if (/失败|错误|无法|不可用|异常|不支持|取消/.test(text)) return 'error'
  if (/成功|已完成|已保存|已导入|已复制|已重建|已加入|已生成|已恢复/.test(text)) return 'ok'
  return 'info'
})

function openHelp(tab: 'about' | 'keys' | 'diagnostics' = 'about'): void {
  helpTab.value = tab
  helpOpen.value = true
}

/** 其它页面（例如设置页）通过自定义事件请求打开指定帮助分页 */
function onOpenHelp(event: Event): void {
  const tab = (event as CustomEvent<string>).detail
  openHelp(tab === 'keys' || tab === 'diagnostics' ? tab : 'about')
}

function onGlobalKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && helpOpen.value) {
    helpOpen.value = false
    return
  }
  const active = document.activeElement
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === 'F1' || event.key === '?') {
    event.preventDefault()
    if (helpOpen.value) helpOpen.value = false
    else openHelp()
  }
}

/** 主进程/渲染层未捕获异常由 main.ts 转成自定义事件，这里统一给可见反馈 */
function onRuntimeError(event: Event): void {
  runtimeError.value = (event as CustomEvent<string>).detail || '未知错误'
}

/** 标题栏一键换肤：按当前实际深浅在浅 / 深之间切换；三态完整选择在设置页 */
function cycleTheme(): void {
  void settings.setTheme(nextMode(settings.dark))
}

watch(
  () => library.message,
  (value) => {
    if (!value) return
    toast.value = value
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.value = ''
      library.message = ''
    }, 3600)
  }
)

onMounted(() => {
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('shulie:app-error', onRuntimeError)
  window.addEventListener('shulie:open-help', onOpenHelp)
  // 事件订阅必须最先注册，且不依赖任何一次 IPC 是否成功。
  // 早期版本把订阅放在 await app:ready 之后，启动竞态会让所有更新通知静默丢失。
  disposers.push(
    on(EV.openFiles, ({ paths }) => void library.importPaths(paths)),
    on(EV.libraryChanged, () => void library.load()),
    on(EV.importProgress, (payload) => {
      library.importing = payload
    }),
    on(EV.importDone, () => {
      library.importing = null
      void library.load()
    }),
    on(EV.metadataUpdated, () => void library.load()),
    on(EV.searchProgress, (payload) => {
      search.progress = payload
    }),
    // 下载任务可能跨页面，订阅放在全局壳里，离开「在线取书」页也不会丢进度
    on(EV.onlineProgress, (payload) => online.updateJob(payload)),
    // 翻译进度也在全局壳里订阅：离开阅读器再回来不会丢进度，划词翻译用独立 jobId
    on(EV.translateProgress, (payload) => translation.setProgress(payload)),
    on(EV.windowState, (payload) => {
      maximized.value = payload.maximized
    }),
    // 系统切换深浅色时，主进程 nativeTheme 会转发；「跟随系统」模式据此实时换肤
    on(EV.nativeThemeChanged, ({ dark }) => settings.onNativeTheme(dark))
  )
  // 有些平台 Chromium 的 prefers-color-scheme 不自动更新，双保险
  disposers.push(watchSystem((value) => settings.onNativeTheme(value)))

  // 首屏数据彼此解耦：书库是核心数据，不能因为 app:ready / 应用信息失败而空白。
  // 加载失败再重试一次，兼容开发模式下主进程热重启造成的短暂窗口。
  void (async () => {
    try {
      await library.load()
    } catch (error) {
      console.warn('[app] 书库首次加载失败，重试一次', error)
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        await library.load()
      } catch (retryError) {
        console.error('[app] 书库加载失败', retryError)
      }
    }
  })()

  // 首帧已按 localStorage 镜像换肤；这里用书库快照里的真值再校准一次，
  // 并把 nativeTheme.themeSource 同步到用户偏好（system 模式才会跟随系统）。
  void settings.load()
    .then(() => settings.syncTheme())
    .catch((error) => console.error('[app] 设置加载失败', error))
  void settings.loadInfo().catch((error) => console.error('[app] 应用信息加载失败', error))

  // 冷启动携带的电子书路径（EPUB / MOBI / AZW3 / PDF / TXT）；失败只跳过文件导入，不影响书库显示
  void invoke(CH.appReady)
    .then((ready) => {
      if (ready.pendingFiles.length) void library.importPaths(ready.pendingFiles)
    })
    .catch((error) => console.warn('[app] app:ready 不可用，跳过冷启动文件', error))
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('shulie:app-error', onRuntimeError)
  window.removeEventListener('shulie:open-help', onOpenHelp)
  disposers.forEach((dispose) => dispose())
  if (toastTimer) clearTimeout(toastTimer)
})

const navItems = [
  { name: 'library', label: '我的书架', icon: 'library' },
  { name: 'search', label: '全文搜索', icon: 'search' },
  { name: 'online', label: '在线取书', icon: 'download' },
  { name: 'tools', label: '格式工具', icon: 'convert' },
  { name: 'settings', label: '设置', icon: 'settings' }
]

/** 导入进度阶段的中文化；2.0 新增 convert（非 EPUB 转码） */
const IMPORT_PHASE_LABEL: Record<string, string> = {
  parse: '解析文件',
  convert: '格式转换',
  store: '写入书库',
  index: '建立索引',
  metadata: '补全元数据'
}
</script>

<template>
  <div class="app-shell">
    <TitleBar v-if="!isReader" :maximized="maximized" :dark="settings.dark" @help="openHelp()" @theme="cycleTheme" />
    <div class="app-body">
      <aside v-if="!isReader" class="sidebar">
        <div class="brand">
          <div class="brand-logo"><AppIcon name="logo" :size="23" :stroke-width="1.6" /></div>
          <div class="brand-copy">
            <div class="brand-name">书猎</div>
            <div class="brand-sub">BOOK HUNTER 2.0</div>
          </div>
        </div>

        <div class="side-caption">工作区</div>
        <nav class="nav">
          <button
            v-for="item in navItems"
            :key="item.name"
            :class="{ active: route.name === item.name }"
            :data-label="item.label"
            :title="item.label"
            :aria-current="route.name === item.name ? 'page' : undefined"
            @click="router.push({ name: item.name })"
          >
            <AppIcon :name="item.icon" :size="18" />
            <span>{{ item.label }}</span>
            <span class="nav-arrow">›</span>
          </button>
        </nav>

        <div class="side-block">
          <div class="side-title">藏书概览</div>
          <div class="stat-grid">
            <div class="stat-cell"><b>{{ library.stats.total }}</b><span>总计</span></div>
            <div class="stat-cell"><b>{{ library.stats.reading }}</b><span>在读</span></div>
            <div class="stat-cell"><b>{{ library.stats.finished }}</b><span>已读</span></div>
            <div class="stat-cell"><b>{{ library.stats.favorite }}</b><span>收藏</span></div>
          </div>
        </div>

        <div class="side-foot">
          <button class="btn btn-primary side-import" title="导入电子书" @click="library.pickFiles()">
            <AppIcon name="plus" :size="16" :stroke-width="2" />
            <span class="side-import-label">导入电子书</span>
          </button>
          <button class="help-link" title="帮助与关于（F1）" @click="openHelp()">
            <AppIcon name="help" :size="14" /> <span class="help-label">帮助与关于</span>
            <span class="kbd help-kbd">F1</span>
          </button>
          <div class="tip">双击 .epub 可直接导入 · 支持多格式</div>
        </div>
      </aside>

      <main class="content">
        <AppBoundary>
          <router-view v-slot="{ Component }">
            <transition name="page" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </AppBoundary>
      </main>
    </div>

    <!-- ≤640px：侧栏退场，底部标签栏接管导航（桌面宽度下 display:none） -->
    <nav v-if="!isReader" class="tabbar" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.name"
        :class="{ active: route.name === item.name }"
        :aria-current="route.name === item.name ? 'page' : undefined"
        @click="router.push({ name: item.name })"
      >
        <AppIcon :name="item.icon" :size="20" />
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <!-- 全局导入进度 -->
    <transition name="fade">
      <div v-if="library.importing" class="import-float panel">
        <div class="import-head">
          <span class="import-icon"><AppIcon name="upload" :size="15" /></span>
          <b>正在导入</b>
          <span class="muted phase">{{ IMPORT_PHASE_LABEL[library.importing.phase] || library.importing.phase }}</span>
        </div>
        <div class="import-file ellipsis">{{ library.importing.fileName }}</div>
        <div class="bar">
          <i :style="{ width: `${(library.importing.current / Math.max(1, library.importing.total)) * 100}%` }" />
        </div>
        <div class="muted count">{{ library.importing.current }} / {{ library.importing.total }}</div>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="toast" class="toast" :class="toastKind" role="status">
        <span class="toast-mark"><AppIcon :name="toastKind === 'error' ? 'alert' : toastKind === 'ok' ? 'check' : 'sparkle'" :size="13" :stroke-width="2" /></span>
        <span>{{ toast }}</span>
      </div>
    </transition>

    <!-- 未捕获异常：不白屏、不打断当前页面，给一条可关闭可复制的提示 -->
    <transition name="fade">
      <div v-if="runtimeError" class="runtime-error" role="alert">
        <AppIcon name="alert" :size="16" />
        <span class="ellipsis">界面遇到一个问题：{{ runtimeError }}</span>
        <button title="关闭" @click="runtimeError = ''">×</button>
      </div>
    </transition>

    <AboutDialog :open="helpOpen" :initial-tab="helpTab" @close="helpOpen = false" />
  </div>
</template>

<style scoped>
.app-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
  background-image: var(--c-bg-grad);
}
.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.sidebar {
  width: var(--sidebar-w);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--c-grad-side);
  border-right: 1px solid var(--c-border);
  box-shadow: 2px 0 14px rgba(23, 32, 53, 0.025);
  padding: 0 14px 16px;
  position: relative;
  z-index: 2;
}
/* 侧栏顶部一条极淡的品牌光带 */
.sidebar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 130px;
  background: linear-gradient(180deg, rgba(107, 140, 245, 0.07), transparent);
  pointer-events: none;
}
.brand {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 22px 6px 24px;
}
.brand-logo {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: #fff;
  background: var(--c-grad-primary);
  box-shadow: var(--sh-primary), var(--sh-inset);
  flex: none;
}
.brand-copy { min-width: 0; }
.brand-name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 3px;
  line-height: 1.2;
  background: linear-gradient(120deg, #2f56c4, #6d8cf3);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.brand-sub {
  margin-top: 3px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 2.2px;
  color: var(--c-text-3);
}
/* 深色背景上原来的深蓝渐变文字会糊掉，提亮一档 */
[data-theme='dark'] .brand-name {
  background: linear-gradient(120deg, #9db4ff, #d0daff);
  -webkit-background-clip: text;
  background-clip: text;
}
.side-caption {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: var(--c-text-3);
  padding: 0 10px 9px;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.nav button {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--r-s);
  font-size: var(--fs-lg);
  color: var(--c-text-2);
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.nav button:hover {
  background: var(--c-surface-hover);
  color: var(--c-text);
}
.nav button.active {
  background: var(--c-grad-soft);
  color: var(--c-primary);
  font-weight: 600;
  box-shadow: var(--sh-1);
}
.nav button.active::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--c-grad-primary);
}
.nav-arrow {
  margin-left: auto;
  font-size: 18px;
  line-height: 1;
  color: var(--c-primary);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.nav button.active .nav-arrow { opacity: 0.7; transform: none; }
.side-block {
  margin-top: 26px;
  padding: 14px 12px 12px;
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  border-radius: var(--r-m);
  box-shadow: var(--sh-1);
}
.side-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--c-text-3);
  margin-bottom: 11px;
}
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--r-s);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
}
.stat-cell b {
  font-size: 17px;
  font-weight: 650;
  line-height: 1.1;
  color: var(--c-text);
}
.stat-cell span {
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}
.side-foot {
  margin-top: auto;
  padding-top: 16px;
}
.side-import {
  width: 100%;
  height: 38px;
}
.help-link {
  width: 100%;
  height: 32px;
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: var(--r-s);
  font-size: var(--fs-sm);
  color: var(--c-text-3);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.help-link:hover { background: var(--c-surface-hover); color: var(--c-primary); }
.help-kbd { margin-left: auto; }
.tip {
  margin-top: 8px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

/* 窄窗口：侧栏收成图标栏，文字用 tooltip 补足 */
@media (max-width: 1180px) {
  .sidebar { padding: 0 9px 14px; }
  .brand { justify-content: center; padding: 18px 0 20px; }
  .brand-copy,
  .side-caption,
  .side-block,
  .nav button span,
  .side-import-label,
  .help-label,
  .help-kbd,
  .tip { display: none; }
  .nav button { justify-content: center; padding: 0; height: 42px; }
  .nav button.active::before { left: -9px; }
  .nav button::after {
    content: attr(data-label);
    position: absolute;
    left: calc(100% + 12px);
    top: 50%;
    transform: translateY(-50%) translateX(-4px);
    padding: 6px 10px;
    border-radius: var(--r-s);
    background: var(--c-tooltip-bg);
    color: #fff;
    font-size: var(--fs-sm);
    white-space: nowrap;
    box-shadow: var(--sh-2);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
    z-index: 30;
  }
  .nav button:hover::after { opacity: 1; transform: translateY(-50%) translateX(0); }
  .side-import { width: 42px; height: 42px; padding: 0; margin: 0 auto; }
  .help-link { width: 42px; height: 34px; margin: 6px auto 0; }
  .side-foot { display: flex; flex-direction: column; align-items: center; }
}
.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.import-float {
  position: fixed;
  right: 22px;
  bottom: 22px;
  width: 296px;
  padding: 15px 17px;
  box-shadow: var(--sh-3);
  z-index: 60;
}
.import-head {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--fs-md);
}
.import-icon {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: var(--r-xs);
  background: var(--c-primary-weak);
  color: var(--c-primary);
  flex: none;
}
.import-head .phase { margin-left: auto; font-size: var(--fs-xs); }
.import-file {
  margin: 11px 0 9px;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.bar {
  height: 6px;
  background: var(--c-surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--c-grad-primary);
  border-radius: 999px;
  transition: width 0.25s var(--ease-out);
}
.count {
  margin-top: 7px;
  font-size: var(--fs-xs);
  text-align: right;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 36px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(560px, 76vw);
  padding: 10px 18px 10px 11px;
  border: 1px solid var(--c-toast-border);
  border-radius: var(--r-pill);
  background: var(--c-toast-bg);
  color: #fff;
  font-size: var(--fs-md);
  box-shadow: var(--sh-3);
  backdrop-filter: blur(8px);
  z-index: 80;
}
.toast-mark {
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(126, 160, 255, 0.2);
  color: #a9c1ff;
  flex: none;
}
.toast.ok .toast-mark { background: rgba(86, 200, 148, 0.2); color: #7fdfb0; }
.toast.error .toast-mark { background: rgba(240, 122, 126, 0.2); color: #ff9b9d; }
.runtime-error {
  position: fixed;
  left: 50%;
  top: calc(var(--titlebar-h) + 12px);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  width: min(560px, 76vw);
  padding: 9px 12px;
  border: 1px solid var(--c-danger);
  border-radius: var(--r-s);
  background: var(--c-danger-weak);
  color: var(--c-danger);
  font-size: var(--fs-sm);
  box-shadow: var(--sh-2);
  z-index: 85;
}
.runtime-error .ellipsis { flex: 1; }
.runtime-error button { font-size: 17px; line-height: 1; opacity: 0.7; }
.runtime-error button:hover { opacity: 1; }

/* ---------------------------------------------------------------- 手机布局
 * ≤640px 用移动端范式：侧栏退场、底部标签栏接管导航，主内容区靠
 * .app-shell 的 padding-bottom 让出标签栏高度（tabbar 是 fixed，不占 flex）。
 * 桌面宽度下这块完全不生效，原有布局零改动。 */
.tabbar { display: none; }

@media (max-width: 640px) {
  .app-shell { padding-bottom: var(--tabbar-h); }
  .sidebar { display: none; }
  .tabbar {
    display: flex;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--tabbar-h);
    background: var(--c-grad-side);
    border-top: 1px solid var(--c-border);
    box-shadow: 0 -3px 18px rgba(0, 0, 0, 0.06);
    backdrop-filter: blur(14px);
    z-index: 40;
  }
  [data-theme='dark'] .tabbar { box-shadow: 0 -3px 18px rgba(0, 0, 0, 0.38); }
  .tabbar button {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--c-text-3);
    font-size: 10px;
    letter-spacing: 0.2px;
    transition: color var(--dur) var(--ease);
  }
  .tabbar button span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tabbar button.active { color: var(--c-primary); font-weight: 600; }
  .tabbar button.active::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 26px;
    height: 2px;
    border-radius: 0 0 3px 3px;
    background: var(--c-grad-primary);
  }
  /* 浮层避开底部标签栏，避免被压住 */
  .import-float {
    right: 12px;
    bottom: calc(var(--tabbar-h) + 12px);
    width: min(296px, calc(100vw - 24px));
  }
  .toast { bottom: calc(var(--tabbar-h) + 14px); max-width: calc(100vw - 28px); }
  .runtime-error { width: calc(100vw - 24px); }
}
</style>
