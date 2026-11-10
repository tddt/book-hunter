<script setup lang="ts">
/**
 * 帮助与关于：正式产品的「可发现性」入口。
 * 版本、数据位置、支持格式、快捷键、诊断信息集中一处，F1 / ? 随时可达。
 */
import { computed, ref, watch } from 'vue'
import { CH, invoke } from '../api'
import { FORMAT_HINT } from '@shared/formats'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{ open: boolean; initialTab?: 'about' | 'keys' | 'diagnostics' }>(),
  { initialTab: 'about' }
)
const emit = defineEmits<{ close: [] }>()

const settings = useSettingsStore()
const library = useLibraryStore()
const tab = ref<'about' | 'keys' | 'diagnostics'>('about')
const copied = ref(false)

const SHORTCUTS: { group: string; items: { keys: string[]; label: string }[] }[] = [
  {
    group: '阅读器',
    items: [
      { keys: ['→', 'PageDown', '空格'], label: '下一页 / 下一组版心' },
      { keys: ['←', 'PageUp'], label: '上一页 / 上一组版心' },
      { keys: ['T'], label: '打开 / 关闭目录' },
      { keys: ['V'], label: '开启对照翻译（译文直接排进正文）' },
      { keys: ['B'], label: '添加书签' },
      { keys: ['F'], label: '切换全屏沉浸阅读' },
      { keys: ['Esc'], label: '关闭面板；无面板时返回书架' }
    ]
  },
  {
    group: '全局',
    items: [
      { keys: ['F1', '?'], label: '打开帮助与关于' },
      { keys: ['Esc'], label: '关闭弹窗 / 取消选区' },
      { keys: ['双击卡片'], label: '打开书籍开始阅读' },
      { keys: ['拖拽文件'], label: '把电子书拖进窗口即可导入' }
    ]
  }
]

const diagnostic = computed(() => {
  const info = settings.appInfo
  return [
    `书猎 ${info?.version || '未知版本'}`,
    `平台: ${info?.platform || '-'} ${info?.isDev ? '(开发态)' : '(安装包 / 绿色版)'}`,
    `运行时: ${navigator.userAgent}`,
    `数据目录: ${info?.dataDir || '-'}`,
    `书库目录: ${info?.libraryDir || '-'}`,
    `藏书: ${library.stats.total} 本`,
    `支持格式: ${FORMAT_HINT}`,
    `文件关联: ${info?.associated ? '已注册 .epub' : '未注册'}`
  ].join('\n')
})

watch(
  () => props.open,
  (value) => {
    if (!value) return
    tab.value = props.initialTab
    copied.value = false
    void settings.loadInfo().catch(() => undefined)
  }
)

function openDir(path: string): void {
  if (path) void invoke(CH.shellOpen, path)
}

async function copyDiagnostic(): Promise<void> {
  try {
    await navigator.clipboard.writeText(diagnostic.value)
    copied.value = true
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <transition name="fade">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog panel" role="dialog" aria-modal="true" aria-label="帮助与关于">
        <header class="dialog-head">
          <div class="dlg-logo"><AppIcon name="logo" :size="21" :stroke-width="1.7" /></div>
          <div class="dlg-title">
            <b>书猎</b>
            <span class="muted">BOOK HUNTER · {{ settings.appInfo?.version || '2.3' }}</span>
          </div>
          <div class="spacer" />
          <button class="close" title="关闭 (Esc)" aria-label="关闭" @click="emit('close')">
            <AppIcon name="close" :size="15" />
          </button>
        </header>

        <nav class="tabs" aria-label="帮助分类">
          <button :class="{ on: tab === 'about' }" @click="tab = 'about'">
            <AppIcon name="info" :size="15" /> 关于
          </button>
          <button :class="{ on: tab === 'keys' }" @click="tab = 'keys'">
            <AppIcon name="keyboard" :size="15" /> 快捷键
          </button>
          <button :class="{ on: tab === 'diagnostics' }" @click="tab = 'diagnostics'">
            <AppIcon name="shield" :size="15" /> 诊断信息
          </button>
        </nav>

        <div class="dialog-body">
          <template v-if="tab === 'about'">
            <p class="lead">本地优先的电子书管理与沉浸式阅读器。书库、索引、笔记全部保存在本机，不上传任何阅读数据。</p>
            <div class="format-line">
              <span class="eyebrow">支持格式</span>
              <div class="formats">
                <span v-for="f in ['EPUB', 'MOBI', 'AZW3', 'PDF', 'TXT']" :key="f" class="pill">{{ f }}</span>
              </div>
              <p class="hint">非 EPUB 格式在导入时统一转成标准 EPUB 入库，因此排版、目录、进度、全文检索与对照翻译体验完全一致。扫描版 PDF（无文字层）与带 DRM / KFX 的 MOBI 不支持。</p>
            </div>
            <div class="kv">
              <span>应用版本</span><b>{{ settings.appInfo?.version || '-' }}</b>
              <span>运行平台</span><b>{{ settings.appInfo?.platform || '-' }} · Electron + Vue 3</b>
              <span>藏书数量</span><b>{{ library.stats.total }} 本</b>
              <span>数据目录</span>
              <button class="link" title="打开数据目录" @click="openDir(settings.appInfo?.dataDir || '')">
                {{ settings.appInfo?.dataDir || '-' }} <AppIcon name="external" :size="12" />
              </button>
              <span>书库目录</span>
              <button class="link" title="打开书库目录" @click="openDir(settings.appInfo?.libraryDir || '')">
                {{ settings.appInfo?.libraryDir || '-' }} <AppIcon name="external" :size="12" />
              </button>
            </div>
            <p class="foot-note">按 <span class="kbd">F1</span> 或 <span class="kbd">?</span> 随时打开本面板 · MIT License</p>
          </template>

          <template v-else-if="tab === 'keys'">
            <div v-for="group in SHORTCUTS" :key="group.group" class="key-group">
              <div class="eyebrow">{{ group.group }}</div>
              <div v-for="item in group.items" :key="item.label" class="key-row">
                <span>{{ item.label }}</span>
                <div class="keys">
                  <span v-for="k in item.keys" :key="k" class="kbd">{{ k }}</span>
                </div>
              </div>
            </div>
            <p class="foot-note">输入框获得焦点时快捷键自动让位，避免影响搜索与笔记输入。</p>
          </template>

          <template v-else>
            <p class="lead">反馈问题时可把下面这段信息一并附上，便于定位环境与版本。</p>
            <pre class="diag">{{ diagnostic }}</pre>
            <div class="diag-actions">
              <button class="btn btn-primary" @click="copyDiagnostic">
                <AppIcon :name="copied ? 'check' : 'copy'" :size="15" /> {{ copied ? '已复制' : '复制诊断信息' }}
              </button>
              <button class="btn btn-ghost" @click="openDir(settings.appInfo?.dataDir || '')">
                <AppIcon name="folder" :size="15" /> 打开数据目录
              </button>
            </div>
            <p class="foot-note">诊断信息只包含本机路径与版本号，不含书目标题、笔记内容或翻译记录。</p>
          </template>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(20, 28, 48, 0.34);
  backdrop-filter: blur(4px);
}
.dialog {
  width: min(600px, 92vw);
  max-height: min(660px, 88vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--r-l);
  box-shadow: var(--sh-3);
}
.dialog-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--c-border-soft);
}
.dlg-logo {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: #fff;
  background: var(--c-grad-primary);
  box-shadow: var(--sh-primary), var(--sh-inset);
  flex: none;
}
.dlg-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dlg-title b { font-size: 17px; letter-spacing: 2px; }
.dlg-title span { font-size: var(--fs-xs); letter-spacing: 1.2px; }
.close {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--r-s);
  color: var(--c-text-3);
}
.close:hover { background: var(--c-surface-3); color: var(--c-text); }
.tabs { display: flex; gap: 4px; padding: 10px 16px 0; }
.tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 13px;
  border-radius: var(--r-s) var(--r-s) 0 0;
  font-size: var(--fs-md);
  color: var(--c-text-3);
  border-bottom: 2px solid transparent;
}
.tabs button:hover { color: var(--c-text); background: var(--c-surface-hover); }
.tabs button.on { color: var(--c-primary); font-weight: 600; border-bottom-color: var(--c-primary); }
.dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 22px 22px; }
.lead { margin: 0 0 16px; font-size: var(--fs-md); line-height: 1.8; color: var(--c-text-2); }
.format-line { display: flex; flex-direction: column; gap: 9px; margin-bottom: 18px; }
.formats { display: flex; flex-wrap: wrap; gap: 6px; }
.formats .pill { background: var(--c-primary-weak); color: var(--c-primary); }
.hint { margin: 0; font-size: var(--fs-sm); line-height: 1.75; color: var(--c-text-3); }
.kv {
  display: grid;
  grid-template-columns: 92px 1fr;
  align-items: center;
  gap: 11px 14px;
  padding: 15px 16px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-m);
  background: var(--c-surface-2);
  font-size: var(--fs-sm);
}
.kv > span { color: var(--c-text-3); }
.kv > b { font-weight: 600; overflow-wrap: anywhere; }
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--c-primary);
  text-align: left;
  overflow-wrap: anywhere;
}
.link:hover { text-decoration: underline; }
.foot-note { margin: 16px 0 0; font-size: var(--fs-xs); line-height: 1.8; color: var(--c-text-3); }
.key-group { margin-bottom: 18px; }
.key-group .eyebrow { margin-bottom: 7px; }
.key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 40px;
  padding: 7px 2px;
  border-bottom: 1px dashed var(--c-border);
  font-size: var(--fs-md);
  color: var(--c-text-2);
}
.key-row:last-child { border-bottom: none; }
.keys { display: flex; gap: 5px; flex: none; }
.diag {
  margin: 0 0 14px;
  padding: 14px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-m);
  background: var(--c-surface-2);
  font-size: var(--fs-xs);
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.diag-actions { display: flex; gap: 9px; }

@media (max-width: 640px) {
  /* 手机上做成整屏页面，避免小对话框里再套一层滚动 */
  .overlay { padding: 0; }
  .dialog {
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
  .dialog-head { padding: 14px 14px 12px; }
  .tabs { padding: 8px 10px 0; overflow-x: auto; }
  .tabs button { padding: 0 10px; white-space: nowrap; }
  .dialog-body { padding: 14px; }
  .kv { grid-template-columns: 76px 1fr; padding: 12px; }
  .diag-actions { flex-wrap: wrap; }
}
</style>
