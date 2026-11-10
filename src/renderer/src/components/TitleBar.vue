<script setup lang="ts">
import { CH, invoke } from '../api'
import AppIcon from './AppIcon.vue'

defineProps<{ maximized?: boolean; dark?: boolean }>()
const emit = defineEmits<{ help: []; theme: [] }>()

function action(name: 'minimize' | 'maximize' | 'unmaximize' | 'close'): void {
  void invoke(CH.windowAction, name)
}
</script>

<template>
  <div class="titlebar">
    <div class="titlebar-text">
      <span class="tb-logo"><AppIcon name="logo" :size="15" :stroke-width="1.8" /></span>
      <span class="mark">书猎</span>
      <span class="tb-sep" />
      <span class="sub">多格式电子书 · 本地优先</span>
    </div>
    <div class="titlebar-drag" />
    <div class="titlebar-actions no-drag">
      <button class="tb-help" title="帮助与关于 (F1)" aria-label="帮助与关于" @click="emit('help')">
        <AppIcon name="help" :size="14" :stroke-width="1.8" />
      </button>
      <button class="tb-theme" :title="dark ? '切换到浅色外观' : '切换到深色外观'" :aria-label="dark ? '切换到浅色外观' : '切换到深色外观'" @click="emit('theme')">
        <AppIcon :name="dark ? 'sun' : 'moon'" :size="15" :stroke-width="1.8" />
      </button>
      <span class="tb-divider" />
      <button class="tb-window" title="最小化" aria-label="最小化" @click="action('minimize')">
        <svg viewBox="0 0 12 12"><path d="M2 6h8" /></svg>
      </button>
      <button class="tb-window" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @click="action(maximized ? 'unmaximize' : 'maximize')">
        <svg v-if="!maximized" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" /></svg>
        <svg v-else viewBox="0 0 12 12">
          <rect x="1.5" y="3.5" width="6" height="6" />
          <path d="M4 3.5V1.5h6.5v6.5H8.5" />
        </svg>
      </button>
      <button class="is-close" title="关闭" aria-label="关闭" @click="action('close')">
        <svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  background: var(--c-grad-side);
  border-bottom: 1px solid var(--c-border);
  flex: none;
  z-index: 3;
}
/* 顶部 1px 高光，让无边框窗口不显死板 */
.titlebar::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, rgba(107, 140, 245, 0.35), transparent 42%);
  pointer-events: none;
}
.titlebar-text {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 14px 0 17px;
  white-space: nowrap;
}
.tb-logo {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: #fff;
  background: var(--c-grad-primary);
  box-shadow: 0 2px 6px rgba(63, 104, 216, 0.28);
  flex: none;
}
.mark {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1.6px;
  color: var(--c-primary);
}
.tb-sep {
  width: 1px;
  height: 12px;
  background: var(--c-border-strong);
}
.sub {
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}
.titlebar-drag {
  flex: 1;
  height: 100%;
  -webkit-app-region: drag;
}
.titlebar-actions {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}
.titlebar-actions button {
  width: 46px;
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--c-text-2);
  transition: background 0.15s var(--ease), color 0.15s var(--ease);
}
.titlebar-actions button:hover {
  background: var(--c-surface-3);
  color: var(--c-text);
}
.titlebar-actions button.is-close:hover {
  background: #e25c5e;
  color: #fff;
}
.titlebar-actions button.tb-help {
  width: 38px;
  color: var(--c-text-3);
}
.titlebar-actions button.tb-help:hover {
  color: var(--c-primary);
  background: var(--c-primary-weak);
}
.tb-divider {
  align-self: center;
  width: 1px;
  height: 15px;
  margin: 0 3px;
  background: var(--c-border-strong);
}
.titlebar-actions button.tb-theme {
  width: 38px;
  color: var(--c-text-3);
}
.titlebar-actions button.tb-theme:hover {
  color: var(--c-primary);
  background: var(--c-primary-weak);
}
svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.15;
}

/* ≤640px：只留品牌、帮助、外观、关闭；最小化/最大化在触屏上没有意义 */
@media (max-width: 640px) {
  .titlebar-text { padding: 0 8px 0 12px; gap: 7px; }
  .titlebar-text .sub,
  .titlebar-text .tb-sep,
  .titlebar-actions button.tb-window,
  .tb-divider { display: none; }
  .titlebar-actions button { width: 40px; }
  .titlebar-actions button.tb-help,
  .titlebar-actions button.tb-theme { width: 38px; }
}
</style>
