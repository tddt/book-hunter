<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CH, invoke } from '../api'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import AppIcon from '../components/AppIcon.vue'
import { THEME_MODES } from '@shared/constants'
import type { AppSettings } from '@shared/types'

const settings = useSettingsStore()
const library = useLibraryStore()

onMounted(() => {
  void settings.loadInfo()
})

const rebuilding = ref(false)

async function saveBool(key: 'autoMetadata' | 'contentSearch' | 'copyOnImport', value: boolean): Promise<void> {
  await settings.save({ [key]: value } as Partial<AppSettings>)
  // 开启开关时自动为历史书补缓存，否则旧书永远搜不到正文
  if (key === 'contentSearch' && value) await rebuildContentCache()
}

async function rebuildIndex(): Promise<void> {
  await invoke(CH.searchRebuild)
  library.message = '检索索引已重建'
}

async function rebuildContentCache(): Promise<void> {
  if (rebuilding.value) return
  rebuilding.value = true
  try {
    const result = await invoke(CH.searchRebuildContent)
    library.message = `正文缓存：新建 ${result.built} 本，已有 ${result.skipped} 本，失败 ${result.failed} 本`
  } catch (cause) {
    library.message = `重建失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    rebuilding.value = false
  }
}

function openDir(path: string): void {
  if (path) void invoke(CH.shellOpen, path)
}

function toggleAssociation(): void {
  void settings.setAssociation(!settings.association.associated)
}

/** 帮助面板挂在全局壳上，这里用自定义事件请求打开指定分页 */
function openHelp(tab: 'keys' | 'diagnostics'): void {
  window.dispatchEvent(new CustomEvent('shulie:open-help', { detail: tab }))
}
</script>

<template>
  <div class="settings-view">
    <header class="hero">
      <h1>设置</h1>
      <p class="muted">导入行为、文件关联、检索索引与应用信息</p>
    </header>

    <div class="scroll">
      <section class="card panel">
        <h2>外观</h2>
        <div class="theme-grid">
          <button
            v-for="m in THEME_MODES"
            :key="m.id"
            class="theme-opt"
            :class="{ on: (settings.settings.theme || 'light') === m.id }"
            :aria-pressed="(settings.settings.theme || 'light') === m.id"
            @click="settings.setTheme(m.id)"
          >
            <span class="theme-ico"><AppIcon :name="m.icon" :size="19" :stroke-width="1.7" /></span>
            <span class="theme-copy">
              <b>{{ m.label }}</b>
              <span>{{ m.desc }}</span>
            </span>
            <span class="theme-check">
              <AppIcon v-if="(settings.settings.theme || 'light') === m.id" name="check" :size="14" :stroke-width="2.2" />
            </span>
          </button>
        </div>
        <p class="note">
          也可以点标题栏右上角的太阳 / 月亮图标一键切换。「跟随系统」会随 Windows 的深浅色设置实时变化。
          切换外观时会把阅读器的默认纸张同步为「夜读 / 素纸」；阅读器内仍可单独挑选羊皮纸、护眼、水墨等主题，手动选过的不会被覆盖。
        </p>
      </section>

      <section class="card panel">
        <h2>导入与存储</h2>
        <div class="item">
          <div class="item-text">
            <b>导入时复制到书库</b>
            <span>把 EPUB 复制到应用书库目录，原文件被移动/删除也不影响阅读；关闭后只记录原路径，不占额外磁盘。MOBI / AZW3 / PDF / TXT 因需转成 EPUB，始终会生成一份副本存入书库，原文件不动。</span>
          </div>
          <button class="switch" :class="{ on: settings.settings.copyOnImport }" role="switch" :aria-checked="settings.settings.copyOnImport" aria-label="导入时复制到书库" @click="saveBool('copyOnImport', !settings.settings.copyOnImport)"><i /></button>
        </div>
        <div class="item">
          <div class="item-text">
            <b>联网补全元数据</b>
            <span>导入后向 Open Library 补全缺失的封面、作者、简介、出版信息。本地 OPF 数据始终优先；离线时自动跳过。</span>
          </div>
          <button class="switch" :class="{ on: settings.settings.autoMetadata }" role="switch" :aria-checked="settings.settings.autoMetadata" aria-label="联网补全元数据" @click="saveBool('autoMetadata', !settings.settings.autoMetadata)"><i /></button>
        </div>
        <div class="item">
          <div class="item-text">
            <b>正文全文检索</b>
            <span>导入时缓存每章纯文本，使搜索能命中书籍正文。关闭可节省磁盘空间；已缓存的书仍可搜。</span>
          </div>
          <button class="switch" :class="{ on: settings.settings.contentSearch }" role="switch" :aria-checked="settings.settings.contentSearch" aria-label="正文全文检索" @click="saveBool('contentSearch', !settings.settings.contentSearch)"><i /></button>
        </div>
      </section>

      <section class="card panel">
        <h2>EPUB 文件关联</h2>
        <div class="assoc-line">
          <span class="state-dot" :class="{ on: settings.association.associated }" />
          <div class="assoc-text">
            <b>{{ settings.association.associated ? '已关联' : '未关联' }}</b>
            <span class="muted">{{ settings.association.detail }}</span>
          </div>
          <button class="btn" :class="settings.association.associated ? 'btn-danger' : 'btn-primary'" :disabled="settings.working" @click="toggleAssociation">
            {{ settings.association.associated ? '取消关联' : '一键关联 .epub' }}
          </button>
        </div>
        <p class="note">
          安装包（NSIS）会在安装时自动注册关联。这里的开关用于便携版 / 开发版，写入的是
          <code>HKCU\Software\Classes</code>，不需要管理员权限。注册前会自动备份原有默认值。
          这里只注册 <code>.epub</code>；MOBI / AZW3 / PDF / TXT 请用导入按钮、拖拽或文件夹导入，避免抢占其它阅读器的默认打开方式。
        </p>
        <details class="restore">
          <summary>如何手动还原注册表</summary>
          <p>取消关联会自动恢复备份（<code>association-backup.json</code>）。如需手工清理，在 CMD 执行：</p>
          <pre>reg delete "HKCU\Software\Classes\ShuLie.epub" /f
reg delete "HKCU\Software\Classes\Applications\ShuLie.exe" /f
reg delete "HKCU\Software\Classes\.epub" /ve /f</pre>
          <p>若之前 .epub 属于其他程序，把第三条换成：
            <code>reg add "HKCU\Software\Classes\.epub" /ve /d "原ProgID" /f</code>
          </p>
        </details>
      </section>

      <section class="card panel">
        <h2>检索索引</h2>
        <div class="item">
          <div class="item-text">
            <b>重建元数据索引</b>
            <span>手动修改了书库数据、或从外部批量放入书籍后，可重建索引让搜索结果恢复一致。</span>
          </div>
          <button class="btn btn-ghost" @click="rebuildIndex">重建索引</button>
        </div>
        <div class="item">
          <div class="item-text">
            <b>重建正文全文缓存</b>
            <span>为导入时未开启正文检索的旧书补建纯文本缓存；补完后「全文搜索」立刻能命中正文。开启上方开关时也会自动执行。</span>
          </div>
          <button class="btn btn-ghost" :disabled="rebuilding" @click="rebuildContentCache">
            {{ rebuilding ? '正在重建…' : '重建缓存' }}
          </button>
        </div>
      </section>

      <section class="card panel">
        <h2>关于</h2>
        <div class="kv">
          <span>应用版本</span><span>{{ settings.appInfo?.version || '1.0.0' }}</span>
          <span>运行平台</span><span>{{ settings.appInfo?.platform }} · Electron + Vue 3</span>
          <span>数据目录</span>
          <button class="link" @click="openDir(settings.appInfo?.dataDir || '')">{{ settings.appInfo?.dataDir || '-' }}</button>
          <span>书库目录</span>
          <button class="link" @click="openDir(settings.appInfo?.libraryDir || '')">{{ settings.appInfo?.libraryDir || '-' }}</button>
          <span>藏书数量</span><span>{{ library.stats.total }} 本</span>
        </div>
        <p class="note">
          架构：Electron 主进程（领域服务 / 仓储 / 索引 / EPUB 解析）→ contextBridge 强类型 IPC →
          Vue 3 渲染层（Pinia / Router / 自研 CSS 多列排版引擎）。书库与索引均为本地 JSON，无云端依赖。
        </p>
        <p class="note">
          书库目录目前为只读展示：切换目录需要一并迁移 books / covers / text，避免已导入书籍路径失效；
          如需迁移请备份后手工处理 <code>library.json</code> 中的 libraryDir。
        </p>
        <div class="about-actions">
          <button class="btn btn-ghost" @click="openHelp('keys')">
            <AppIcon name="keyboard" :size="15" /> 查看快捷键
          </button>
          <button class="btn btn-ghost" @click="openHelp('diagnostics')">
            <AppIcon name="shield" :size="15" /> 诊断信息
          </button>
          <span class="muted">也可随时按 <span class="kbd">F1</span> 打开帮助与关于</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-view { height: 100%; display: flex; flex-direction: column; padding: 20px 22px 0; }
.hero { flex: none; margin-bottom: 18px; }
.hero h1 { margin: 0 0 4px; font-size: var(--fs-xxl); font-weight: 650; }
.hero p { margin: 0; font-size: var(--fs-md); }
.scroll { flex: 1; overflow: auto; padding: 0 4px 30px 0; max-width: 860px; }
.card { padding: 18px 20px; margin-bottom: 14px; }
.card h2 { margin: 0 0 14px; font-size: 15px; font-weight: 650; }
/* 外观三选一 */
.theme-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.theme-opt {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 78px;
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-m);
  background: var(--c-surface-2);
  text-align: left;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.theme-opt:hover { background: var(--c-surface-hover); border-color: var(--c-border-strong); }
.theme-opt.on { background: var(--c-primary-weak); border-color: var(--c-primary); box-shadow: var(--sh-focus); }
.theme-ico {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  flex: none;
  border-radius: 9px;
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-2);
}
.theme-opt.on .theme-ico { color: var(--c-primary); border-color: var(--c-primary); }
.theme-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.theme-copy b { font-size: var(--fs-md); font-weight: 650; }
.theme-copy span { font-size: var(--fs-xs); color: var(--c-text-3); line-height: 1.55; }
.theme-check { width: 18px; height: 18px; display: grid; place-items: center; flex: none; color: var(--c-primary); }
.item { display: flex; align-items: center; gap: 20px; padding: 12px 0; border-top: 1px solid var(--c-border); }
.item:first-of-type { border-top: none; padding-top: 0; }
.item-text { flex: 1; display: flex; flex-direction: column; gap: 5px; }
.item-text b { font-size: var(--fs-lg); font-weight: 600; }
.item-text span { font-size: var(--fs-sm); color: var(--c-text-3); line-height: 1.7; }
.switch { width: 40px; height: 22px; border-radius: 12px; background: var(--c-border-strong); position: relative; flex: none; transition: background 0.18s; }
.switch i { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--c-switch-knob); transition: transform 0.18s var(--ease); box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.switch.on { background: var(--c-primary); }
.switch.on i { transform: translateX(18px); }
.assoc-line { display: flex; align-items: center; gap: 12px; }
.state-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c-text-3); flex: none; }
.state-dot.on { background: var(--c-success); }
.assoc-text { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.assoc-text .muted { font-size: var(--fs-sm); }
.note { margin: 12px 0 0; font-size: var(--fs-sm); color: var(--c-text-3); line-height: 1.8; }
.about-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--c-border);
  font-size: var(--fs-sm);
}
.about-actions .muted { margin-left: auto; }
code { padding: 1px 5px; border-radius: 3px; background: var(--c-surface-3); font-size: var(--fs-xs); }
.restore { margin-top: 12px; font-size: var(--fs-sm); color: var(--c-text-2); }
.restore summary { cursor: pointer; color: var(--c-primary); }
.restore p { line-height: 1.8; }
.restore pre { margin: 8px 0; padding: 12px; border-radius: var(--r-s); background: var(--c-code-bg); color: var(--c-code-fg); font-size: var(--fs-sm); line-height: 1.7; overflow: auto; user-select: text; }
.kv { display: grid; grid-template-columns: 88px 1fr; gap: 9px 14px; font-size: var(--fs-md); }
.kv > span:nth-child(odd) { color: var(--c-text-3); }
.kv .link { text-align: left; color: var(--c-primary); word-break: break-all; font-size: var(--fs-md); }

@media (max-width: 640px) {
  .settings-view { padding: 16px 12px 0; }
  .hero { margin-bottom: 14px; }
  .hero h1 { font-size: 22px; }
  .scroll { max-width: 100%; padding-right: 0; }
  .card { padding: 14px; }
  .theme-grid { grid-template-columns: 1fr; gap: 8px; }
  .theme-opt { min-height: 60px; }
  .item { gap: 12px; flex-wrap: wrap; }
  .assoc-line { flex-wrap: wrap; }
  .assoc-line .btn { width: 100%; }
  .kv { grid-template-columns: 76px 1fr; }
  .about-actions .muted { margin-left: 0; }
  .restore pre { font-size: 10px; }
}
</style>
