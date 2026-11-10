<script setup lang="ts">
/**
 * 渲染层错误边界。
 * Vue 的 app.config.errorHandler 只能「记录」，组件树仍会被卸载成白屏；
 * 这里用 onErrorCaptured 把子树错误拦在当前层，展示可恢复的占位界面，
 * 「重试」会换 key 强制重新挂载整棵路由视图。
 */
import { computed, onErrorCaptured, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const failure = ref<string | null>(null)
const detail = ref('')
const attempt = ref(0)
const errorText = computed(() => `${failure.value || ''}\n${detail.value || ''}`.trim())

onErrorCaptured((error, _instance, info) => {
  failure.value = error instanceof Error ? error.message : String(error)
  detail.value = info
  console.error('[书猎] 界面渲染失败', info, error)
  return false // 阻止继续冒泡到 window.onerror，避免重复提示
})

function retry(): void {
  failure.value = null
  detail.value = ''
  attempt.value += 1
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(errorText.value)
  } catch {
    /* 剪贴板不可用时用户仍可手动选中文字 */
  }
}
</script>

<template>
  <div v-if="failure" class="boundary-wrap">
    <div class="boundary panel">
      <div class="boundary-icon"><AppIcon name="alert" :size="26" :stroke-width="1.5" /></div>
      <h2>这个页面没能正常显示</h2>
      <p>书库数据没有受到影响，可以重试或切换到其它页面。</p>
      <pre>{{ errorText }}</pre>
      <div class="boundary-actions">
        <button class="btn btn-ghost" @click="copy"><AppIcon name="copy" :size="15" /> 复制详情</button>
        <button class="btn btn-primary" @click="retry">重新加载页面</button>
      </div>
    </div>
  </div>
  <div v-else :key="attempt" class="boundary-host"><slot /></div>
</template>

<style scoped>
.boundary-wrap,
.boundary-host { width: 100%; height: 100%; }
.boundary-wrap { display: grid; place-items: center; padding: 24px; }
.boundary { width: min(480px, 90%); padding: 28px 30px; text-align: center; }
.boundary-icon {
  width: 54px;
  height: 54px;
  margin: 0 auto 14px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-danger-weak);
  color: var(--c-danger);
}
.boundary h2 { margin: 0 0 6px; font-size: 17px; font-weight: 650; }
.boundary p { margin: 0 0 14px; font-size: var(--fs-md); color: var(--c-text-3); line-height: 1.7; }
.boundary pre {
  margin: 0 0 18px;
  padding: 11px 13px;
  max-height: 130px;
  overflow: auto;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: var(--r-s);
  background: var(--c-surface-3);
  color: var(--c-text-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
  user-select: text;
}
.boundary-actions { display: flex; justify-content: center; gap: 10px; }
</style>
