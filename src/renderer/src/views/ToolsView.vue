<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { CH, getFilePath, invoke } from '../api'
import { useLibraryStore } from '../stores/library'
import { useToolsStore } from '../stores/tools'
import type { TxtToEpubStage } from '@shared/types'
import AppIcon from '../components/AppIcon.vue'

const tools = useToolsStore()
const library = useLibraryStore()
const dragging = ref(false)
const resultEl = ref<HTMLElement | null>(null)

const STAGE_LABEL: Record<TxtToEpubStage, string> = {
  scan: '查找文件', read: '读取文件', parse: '解析正文', build: '生成 EPUB',
  verify: '校验 EPUB', write: '写入磁盘', merge: '合并章节'
}

const canConvert = computed(
  () => tools.paths.length > 0 && !!tools.outputDir && !tools.busy
)
const outputCount = computed(() => tools.result?.outputs.length || 0)
const failedCount = computed(() => tools.result?.failed.length || 0)

const modeOptions = [
  {
    id: 'merge' as const,
    label: '合并成一本',
    desc: '所有 TXT 合成一卷本，每个文件是「卷」，文件内章节是二级目录'
  },
  {
    id: 'separate' as const,
    label: '每本单独生成',
    desc: '一个 TXT 对应一个 EPUB，书名取自文件名，互不干扰'
  }
]

const encodingOptions = [
  { value: 'auto', label: '自动识别（推荐）' },
  { value: 'utf8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030 / GBK' },
  { value: 'utf16le', label: 'UTF-16 LE' }
]

function baseName(path: string): string {
  return path.replace(/[\\/]/g, '/').split('/').pop() || path
}

function dirName(path: string): string {
  const normalized = path.replace(/[\\/]/g, '/')
  return normalized.slice(0, normalized.lastIndexOf('/')) || ''
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const picked: string[] = []
  for (const file of Array.from(event.dataTransfer?.files || [])) {
    try {
      picked.push(getFilePath(file))
    } catch {
      /* 非本地文件，忽略 */
    }
  }
  const added = tools.addPaths(picked)
  library.message = added
    ? `已加入 ${added} 个 TXT 文件`
    : '没有新增 TXT 文件（可能已添加或格式不支持）'
}

async function convert(): Promise<void> {
  if (!canConvert.value) return
  const ok = await tools.convert()
  if (ok) {
    const parts = [`生成 ${outputCount.value} 本 EPUB`]
    if (failedCount.value) parts.push(`${failedCount.value} 项失败：${tools.result?.failed[0]?.reason || ''}`)
    library.message = parts.join(' · ')
  } else {
    // 失败原因必须出现在全局提示里，避免用户只看到「转换失败」四个字
    library.message = `转换失败：${tools.error || tools.result?.message || '未知原因'}`
  }
  // 结果区在页面下方，转换完自动滚过去，用户一定能看到具体是哪一步、哪个文件出错
  await nextTick()
  resultEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

async function copyFailures(): Promise<void> {
  const rows = tools.result?.failed || []
  const lines = [
    tools.result?.message || tools.error || 'TXT 转 EPUB 诊断',
    ...rows.map((r) => `[${r.stage ? STAGE_LABEL[r.stage] : '未知阶段'}] ${r.path}\n  ${r.reason}`)
  ]
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    library.message = '已复制失败详情'
  } catch {
    library.message = '复制失败，可手动选中下方文字'
  }
}

function openOutputDir(): void {
  if (tools.outputDir) void invoke(CH.shellOpen, tools.outputDir)
}

function importOutputs(): void {
  const paths = tools.result?.outputs.map((o) => o.path) || []
  if (!paths.length) return
  void library.importPaths(paths)
}
</script>

<template>
  <div class="tools-view">
    <header class="hero">
      <div class="hero-copy">
        <h1>格式工具</h1>
        <p class="muted">把多个 TXT 转成标准 EPUB。产物可直接导入书架，排版、目录、进度与原生 EPUB 完全一致。</p>
      </div>
      <div class="hero-art"><AppIcon name="convert" :size="30" :stroke-width="1.4" /></div>
    </header>

    <div class="scroll">
      <div class="cols">
        <!-- 1. 选文件 -->
        <section class="card panel">
          <h2><span class="step">1</span> 选择 TXT 文件</h2>
          <p class="hint">可多选，也可直接把文件拖到下方虚线框内。顺序即合并后的卷序。</p>

          <div class="row-actions">
            <button class="btn btn-primary" @click="tools.pickTxt()">
              <AppIcon name="plus" :size="15" :stroke-width="2" /> 添加 TXT
            </button>
            <button class="btn btn-ghost" :disabled="!tools.paths.length" @click="tools.clearPaths()">
              清空列表
            </button>
            <div class="spacer" />
            <span class="muted count">已选 {{ tools.paths.length }} 个</span>
          </div>

          <div
            class="drop-zone"
            :class="{ on: dragging }"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <template v-if="tools.paths.length">
              <div v-for="(path, index) in tools.paths" :key="path" class="file-row">
                <span class="file-index">{{ String(index + 1).padStart(2, '0') }}</span>
                <div class="file-meta">
                  <b class="ellipsis">{{ baseName(path) }}</b>
                  <span class="ellipsis muted">{{ dirName(path) }}</span>
                </div>
                <button class="file-del" title="移除" @click="tools.removePath(path)">×</button>
              </div>
            </template>
            <div v-else class="drop-empty">
              <AppIcon name="upload" :size="24" :stroke-width="1.4" />
              <span>把 .txt 文件拖到这里</span>
            </div>
          </div>
        </section>

        <!-- 2. 设置 -->
        <section class="card panel">
          <h2><span class="step">2</span> 转换设置</h2>

          <div class="field">
            <label>输出目录</label>
            <div class="dir-row">
              <input v-model="tools.outputDir" class="input" placeholder="选择一个用于保存 EPUB 的文件夹" readonly />
              <button class="btn btn-soft" @click="tools.pickOutput()">
                <AppIcon name="folder" :size="15" /> 选择
              </button>
            </div>
          </div>

          <div class="field">
            <label>生成方式</label>
            <div class="mode-grid">
              <button
                v-for="option in modeOptions"
                :key="option.id"
                class="mode-card"
                :class="{ on: tools.mode === option.id }"
                @click="tools.mode = option.id"
              >
                <b>{{ option.label }}</b>
                <span>{{ option.desc }}</span>
              </button>
            </div>
          </div>

          <div class="field inline-field">
            <div class="grow">
              <label>文本编码</label>
              <select v-model="tools.encoding" class="input">
                <option v-for="option in encodingOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div class="switch-field">
              <label>识别章节标题</label>
              <button
                class="switch"
                :class="{ on: tools.detectChapters }"
                @click="tools.detectChapters = !tools.detectChapters"
              ><i /></button>
            </div>
          </div>

          <div v-if="tools.mode === 'merge'" class="field two-col">
            <div>
              <label>合集书名 <span class="muted">（留空自动命名）</span></label>
              <input v-model="tools.title" class="input" placeholder="例如：某某全集" />
            </div>
            <div>
              <label>作者</label>
              <input v-model="tools.author" class="input" placeholder="可选" />
            </div>
          </div>
        </section>
      </div>

      <!-- 3. 执行 -->
      <section class="card panel action-bar">
        <div class="action-copy">
          <b>准备就绪</b>
          <span class="muted">
            {{ tools.paths.length ? `${tools.paths.length} 个 TXT · ${tools.mode === 'merge' ? '合并为 1 本' : `生成 ${tools.paths.length} 本`}` : '请先添加 TXT 文件' }}
            {{ tools.outputDir ? '' : ' · 还需选择输出目录' }}
          </span>
        </div>
        <div class="spacer" />
        <button class="btn btn-primary action-btn" :disabled="!canConvert" @click="convert()">
          <AppIcon name="convert" :size="16" />
          {{ tools.busy ? '正在转换…' : '开始转换' }}
        </button>
      </section>

      <!-- 4. 结果 -->
      <section v-if="tools.result || tools.error" ref="resultEl" class="card panel result">
        <h2><span class="step">3</span> 转换结果</h2>
        <p v-if="tools.result?.message" class="result-message" :class="{ bad: !outputCount }">
          {{ tools.result.message }}
        </p>
        <p v-if="tools.error" class="error-line">{{ tools.error }}</p>

        <template v-if="tools.result">
          <div class="result-summary">
            <span class="pill ok">成功 {{ outputCount }}</span>
            <span v-if="failedCount" class="pill bad">失败 {{ failedCount }}</span>
            <div class="spacer" />
            <button v-if="failedCount" class="btn btn-ghost" @click="copyFailures()">复制错误详情</button>
            <button class="btn btn-ghost" @click="openOutputDir()">
              <AppIcon name="folder" :size="15" /> 打开输出目录
            </button>
            <button class="btn btn-primary" :disabled="!outputCount" @click="importOutputs()">
              <AppIcon name="plus" :size="15" :stroke-width="2" /> 导入到书架
            </button>
          </div>

          <div v-if="failedCount" class="fail-head">
            失败明细 <span class="muted">（按文件 / 阶段列出，可据此调整编码或输出目录后重试）</span>
          </div>
          <div v-for="(item, i) in tools.result.failed" :key="`${item.path}-${i}`" class="out-row failed">
            <span class="out-icon"><AppIcon name="circle" :size="18" /></span>
            <div class="out-meta">
              <b class="ellipsis">
                {{ baseName(item.path) }}
                <em v-if="item.stage" class="stage-chip">{{ STAGE_LABEL[item.stage] }}</em>
              </b>
              <span class="fail-reason">{{ item.reason }}</span>
              <span class="ellipsis muted">{{ item.path }}</span>
            </div>
          </div>

          <div v-if="outputCount" class="fail-head">生成的 EPUB</div>
          <div v-for="item in tools.result.outputs" :key="item.path" class="out-row">
            <span class="out-icon"><AppIcon name="book" :size="18" /></span>
            <div class="out-meta">
              <b class="ellipsis">{{ item.title }}.epub</b>
              <span class="ellipsis muted">{{ item.path }}</span>
              <span v-if="item.warnings.length" class="warn-line">提示：{{ item.warnings.join('；') }}</span>
            </div>
            <span class="out-stat">{{ item.chapters }} 章 · {{ sizeLabel(item.bytes) }}</span>
          </div>
        </template>
      </section>

      <section class="notes">
        <div class="note-item">
          <AppIcon name="sparkle" :size="16" />
          <span><b>编码自动识别</b>：优先 BOM（UTF-8 / UTF-16 LE/BE），再严格校验 UTF-8，最后回退 GB18030，覆盖绝大多数中文 TXT。</span>
        </div>
        <div class="note-item">
          <AppIcon name="list" :size="16" />
          <span><b>章节切分</b>：识别「第 X 章 / 卷 / 回 / 节」等标题生成目录；关闭时按字数均匀分节，超长段落会自动断句以便翻页与对照翻译。</span>
        </div>
        <div class="note-item">
          <AppIcon name="check" :size="16" />
          <span><b>不会覆盖</b>：同名 EPUB 已存在时自动追加 _2、_3。每个产物都会回喂现有解析器做结构自校验，确保能被书猎正常打开。</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tools-view { height: 100%; display: flex; flex-direction: column; }
.hero {
  flex: none;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px 26px 20px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-glass);
  backdrop-filter: blur(12px);
}
.hero-copy { min-width: 0; }
.hero h1 { margin: 0 0 6px; font-size: var(--fs-xl); font-weight: 680; letter-spacing: 0.4px; }
.hero p { margin: 0; font-size: var(--fs-md); line-height: 1.6; }
.hero-art {
  margin-left: auto;
  width: 58px;
  height: 58px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 18px;
  color: var(--c-primary);
  background: var(--c-grad-soft);
  box-shadow: var(--sh-1);
}
.scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 26px 30px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.card { padding: 18px 20px; }
.card h2 {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 4px;
  font-size: var(--fs-lg);
  font-weight: 650;
}
.step {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: var(--c-primary-weak);
  color: var(--c-primary);
  font-size: var(--fs-xs);
  font-weight: 700;
}
.hint { margin: 0 0 14px 31px; font-size: var(--fs-sm); color: var(--c-text-3); line-height: 1.6; }
.row-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.count { font-size: var(--fs-xs); white-space: nowrap; }
.drop-zone {
  min-height: 168px;
  max-height: 292px;
  overflow: auto;
  padding: 8px;
  border: 1.5px dashed var(--c-border);
  border-radius: var(--r-m);
  background: var(--c-surface-2);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.drop-zone.on { border-color: var(--c-primary); background: var(--c-primary-weak); }
.drop-empty {
  height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: var(--c-text-3);
  font-size: var(--fs-sm);
}
.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 46px;
  padding: 0 8px;
  border-radius: var(--r-s);
  transition: background var(--dur) var(--ease);
}
.file-row:hover { background: var(--c-surface); }
.file-index { font-size: var(--fs-xs); font-weight: 700; color: var(--c-text-3); flex: none; }
.file-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; line-height: 1.35; }
.file-meta b { font-size: var(--fs-sm); font-weight: 600; }
.file-meta span { font-size: 11px; }
.file-del { margin-left: auto; flex: none; width: 24px; height: 24px; border-radius: var(--r-xs); color: var(--c-text-3); font-size: 16px; }
.file-del:hover { color: var(--c-danger); background: var(--c-surface-3); }

.field { margin-top: 16px; }
.field label { display: block; margin-bottom: 7px; font-size: var(--fs-sm); font-weight: 600; color: var(--c-text-2); }
.field label .muted { font-weight: 400; }
.dir-row { display: flex; gap: 8px; }
.dir-row .input { flex: 1; min-width: 0; cursor: default; }
.dir-row .btn { flex: none; }
.mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.mode-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 82px;
  padding: 12px;
  text-align: left;
  border: 1px solid var(--c-border);
  border-radius: var(--r-m);
  background: var(--c-surface);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.mode-card:hover { border-color: var(--c-primary); }
.mode-card.on { border-color: var(--c-primary); background: var(--c-grad-soft); box-shadow: var(--sh-1); }
.mode-card b { font-size: var(--fs-md); font-weight: 650; }
.mode-card.on b { color: var(--c-primary); }
.mode-card span { font-size: var(--fs-xs); line-height: 1.55; color: var(--c-text-3); }
.inline-field { display: flex; align-items: flex-end; gap: 14px; }
.grow { flex: 1; min-width: 0; }
.grow .input { width: 100%; }
.switch-field { flex: none; display: flex; flex-direction: column; gap: 10px; align-items: center; }
.switch-field label { margin: 0; white-space: nowrap; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.two-col .input { width: 100%; }
.switch {
  position: relative;
  width: 38px;
  height: 21px;
  border-radius: 999px;
  background: var(--c-surface-3);
  border: 1px solid var(--c-border);
  transition: background var(--dur) var(--ease);
}
.switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--c-switch-knob);
  box-shadow: var(--sh-1);
  transition: transform var(--dur) var(--ease);
}
.switch.on { background: var(--c-primary); border-color: var(--c-primary); }
.switch.on i { transform: translateX(17px); }

.action-bar { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
.action-copy { display: flex; flex-direction: column; gap: 3px; }
.action-copy b { font-size: var(--fs-md); }
.action-copy span { font-size: var(--fs-sm); }
.action-btn { min-width: 132px; height: 38px; }
.result { margin-top: 18px; }
.result-message {
  margin: 10px 0 0 31px; padding: 9px 12px; border-radius: var(--r-s);
  font-size: var(--fs-sm); line-height: 1.6; word-break: break-word;
  background: rgba(72, 166, 112, 0.1); color: #2f8a5b;
}
.result-message.bad { background: rgba(224, 92, 92, 0.1); color: var(--c-danger); }
.error-line {
  margin: 10px 0 0 31px; padding: 9px 12px; border-radius: var(--r-s);
  font-size: var(--fs-sm); line-height: 1.65; word-break: break-word;
  background: rgba(224, 92, 92, 0.1); color: var(--c-danger);
}
.result-summary { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px 31px; }
.fail-head { margin: 16px 0 8px 31px; font-size: var(--fs-sm); font-weight: 620; color: var(--c-text-2); }
.fail-head .muted { font-weight: 400; font-size: var(--fs-xs); }
.stage-chip {
  display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: var(--r-pill);
  font-size: 10px; font-style: normal; font-weight: 600;
  background: rgba(224, 92, 92, 0.13); color: var(--c-danger);
}
.fail-reason { font-size: 11px; line-height: 1.65; color: var(--c-danger); white-space: pre-wrap; word-break: break-word; }
.pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.pill.ok { background: var(--c-success-weak); color: var(--c-success); }
.pill.bad { background: rgba(224, 92, 92, 0.12); color: var(--c-danger); }
.out-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-s);
  background: var(--c-surface-2);
  margin-bottom: 8px;
}
.out-row.failed { border-color: rgba(224, 92, 92, 0.35); }
.out-icon {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--r-xs);
  background: var(--c-primary-weak);
  color: var(--c-primary);
}
.out-row.failed .out-icon { background: rgba(224, 92, 92, 0.1); color: var(--c-danger); }
.out-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; line-height: 1.4; }
.out-meta b { font-size: var(--fs-sm); font-weight: 600; }
.out-meta span { font-size: 11px; }
.warn-line { color: var(--c-warn); }
.out-stat { margin-left: auto; flex: none; font-size: var(--fs-xs); color: var(--c-text-3); }
.notes { display: grid; gap: 9px; margin-top: 18px; }
.note-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--c-text-2);
}
.note-item :deep(.app-icon) { color: var(--c-primary); margin-top: 2px; }
.note-item b { color: var(--c-text); }
@media (max-width: 1040px) {
  .cols { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .hero { gap: 10px; padding: 14px 12px 12px; }
  .hero h1 { font-size: 18px; }
  .hero-art { width: 42px; height: 42px; border-radius: 13px; }
  .scroll { padding: 12px 12px 24px; }
  .cols { gap: 12px; }
  .card { padding: 14px; }
  .hint { margin-left: 0; }
  .result-summary { flex-wrap: wrap; }
  .action-btn { min-width: 0; width: 100%; }
}
</style>
