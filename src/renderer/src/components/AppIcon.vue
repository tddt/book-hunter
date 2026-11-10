<script setup lang="ts">
/**
 * 统一线性图标库（24×24 stroke）。
 * 用 SVG 替换原先的 ▤ ⌕ ⇩ ⚙ ▦ ☰ 等字符图标：
 * 字符图标依赖系统字体回退，在不同机器上粗细/基线不一致，是界面显廉价的主因。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number | string
    strokeWidth?: number
  }>(),
  { size: 18, strokeWidth: 1.7 }
)

const ICONS: Record<string, string[]> = {
  // 品牌：翻开的书 + 放大镜
  logo: [
    'M4 5.2A2.2 2.2 0 0 1 6.2 3H19v15.5H6.2A2.2 2.2 0 0 0 4 20.7z',
    'M4 20.7A2.2 2.2 0 0 1 6.2 18.5H19',
    'M11.4 9.2a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8z',
    'M13.5 13.3 15.6 15.4'
  ],
  library: ['M4 4.5h4v15.5H4z', 'M10 6.5h4v13.5h-4z', 'M16 9.5h4v10.5h-4z', 'M3 20.5h18'],
  search: ['M10.8 3.2a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2z', 'M16.3 16.3 21 21'],
  download: [
    'M12 3.5v11.5',
    'M7.5 10.5 12 15l4.5-4.5',
    'M4 17.5v2a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-2'
  ],
  settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 5v4', 'M9 15v4'],
  star: ['M12 3.2l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2-4.6-4.4 6.3-.9z'],
  circle: ['M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z'],
  clock: ['M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z', 'M12 7.2v5.2l3.4 2'],
  check: ['M4.5 12.5 9.5 17.5 19.5 6.5'],
  dots: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  bookmark: ['M6 3.5h12v17l-6-4-6 4z'],
  edit: ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z', 'M14.5 6.5l3 3'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  list: ['M4 6.5h1.5', 'M9 6.5h11', 'M4 12h1.5', 'M9 12h11', 'M4 17.5h1.5', 'M9 17.5h11'],
  folder: ['M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  plus: ['M12 5v14', 'M5 12h14'],
  book: [
    'M12 6.5C10 5 7.2 4.3 4 4.5v14c3.2-.2 6 .5 8 2 2-1.5 4.8-2.2 8-2v-14c-3.2-.2-6 .5-8 2z',
    'M12 6.5v14'
  ],
  upload: ['M12 15.5V4', 'M7.5 8.5 12 4l4.5 4.5', 'M4 17v2a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2'],
  sparkle: [
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    'M18.4 16.4l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z'
  ],
  globe: [
    'M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z',
    'M3.4 12h17.2',
    'M12 3.2c2.3 2.4 3.5 5.4 3.5 8.8s-1.2 6.4-3.5 8.8c-2.3-2.4-3.5-5.4-3.5-8.8S9.7 5.6 12 3.2z'
  ],
  // 格式转换：两条反向箭头
  convert: [
    'M4 8.5h13',
    'M14 5.5l3 3-3 3',
    'M20 15.5H7',
    'M10 12.5l-3 3 3 3'
  ],
  translate: [
    'M3.5 5.5h9',
    'M8 3.5v2',
    'M10.5 5.5c-.5 4-3 7-7 8.5',
    'M5.5 9.5c1.5 2.5 3.8 4 6.5 4.5',
    'M13 20l4.5-11 4.5 11',
    'M14.5 16.5h6'
  ],
  // 空状态插画：书架 + 散落的书
  bookshelf: [
    'M3 20.5h18',
    'M5 20.5V9h4v11.5',
    'M10.5 20.5V5h4v15.5',
    'M16 20.5v-8h3v8',
    'M5 12.5h4',
    'M10.5 8.5h4',
    'M16 16h3',
    'M2.5 4.5h3.2l2.8 3H5.3z'
  ],
  help: ['M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z', 'M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.1.9-1.1 1.8', 'M12 17.1h.01'],
  alert: ['M12 3.6 2.6 20h18.8z', 'M12 9.5v5', 'M12 17.4h.01'],
  info: ['M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z', 'M12 11v6', 'M12 7.5h.01'],
  keyboard: ['M3 6.5h18v11H3z', 'M6.5 10h.01', 'M10 10h.01', 'M13.5 10h.01', 'M17 10h.01', 'M6.5 13h.01', 'M10 13h.01', 'M13.5 13h.01', 'M17 13h.01', 'M8 16h8'],
  shield: ['M12 3 4.5 6v5.5c0 4.5 3 7.8 7.5 9.5 4.5-1.7 7.5-5 7.5-9.5V6z', 'M9 12l2 2 4-4'],
  copy: ['M8 8h11v12H8z', 'M5 16H4V4h11v1'],
  external: ['M13 4h7v7', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  close: ['M5.5 5.5l13 13', 'M18.5 5.5l-13 13'],
  chevron: ['M6 9l6 6 6-6'],
  // 外观三态
  sun: ['M12 4.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6z', 'M12 1.8v2', 'M12 20.2v2', 'M4.8 4.8l1.4 1.4', 'M17.8 17.8l1.4 1.4', 'M1.8 12h2', 'M20.2 12h2', 'M4.8 19.2l1.4-1.4', 'M17.8 6.2l1.4-1.4'],
  moon: ['M20 14.4A8.4 8.4 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4z'],
  monitor: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4', 'M6.5 8.5h5']
}

const paths = computed(() => ICONS[props.name] || ICONS.circle)
const dimension = computed(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size
)
</script>

<template>
  <svg
    class="app-icon"
    :width="dimension"
    :height="dimension"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
