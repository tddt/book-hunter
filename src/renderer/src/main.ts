import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/tokens.css'
import './styles/base.css'
import './styles/reader.css'
import { bootstrapTheme } from './theme'

// 首帧同步换肤：必须在 Vue 挂载（也就是页面第一次绘制）之前，
// 否则深色主题会先闪一帧浅色背景。真值稍后由 App.vue 从 settings 校准。
bootstrapTheme()

const app = createApp(App)

/**
 * 全局兜底：任何未捕获的渲染 / 异步异常都要变成「看得见的提示」，
 * 而不是静默白屏或只在 DevTools 里留一行日志。AppBoundary 负责子树恢复，
 * 这里负责通知 App.vue 顶部错误条；1.2s 限流避免错误风暴刷屏。
 */
let lastReport = 0
function report(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[书猎] ${kind}`, error)
  const now = Date.now()
  if (now - lastReport < 1200) return
  lastReport = now
  window.dispatchEvent(new CustomEvent('shulie:app-error', { detail: `${kind}：${message}` }))
}

app.config.errorHandler = (error, _instance, info) => {
  report('界面异常', `${error instanceof Error ? error.message : String(error)} (${info})`)
}
window.addEventListener('unhandledrejection', (event) => report('异步任务失败', event.reason))
window.addEventListener('error', (event) => report('脚本错误', event.error || event.message))

app.use(createPinia()).use(router).mount('#app')
