import type { ThemeMode } from '@shared/types'

/**
 * 渲染层外观。只负责一件事：把解析后的深浅写到 <html data-theme>，
 * tokens.css 的 :root[data-theme='dark'] 会覆盖全部 --c-* 变量。
 *
 * 首帧防闪：main.ts 在任何 Vue 代码之前同步调用 bootstrapTheme()，
 * 读取 localStorage 里的模式镜像（上次由 applyTheme 写入）。
 * 真正的偏好在 library.json 的 AppSettings.theme，settings 加载完成后由 App.vue 校准。
 */

const STORAGE_KEY = 'shulie-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function storedMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'dark' || value === 'system' ? value : 'light'
  } catch {
    return 'light'
  }
}

export function systemDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

export function isDark(mode: ThemeMode, nativeDark?: boolean): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return nativeDark ?? systemDark()
}

/** 写入 data-theme + color-scheme（原生滚动条 / 表单控件跟着变），返回当前是否深色 */
export function applyTheme(mode: ThemeMode, nativeDark?: boolean): boolean {
  const dark = isDark(mode, nativeDark)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.colorScheme = dark ? 'dark' : 'light'
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* 隐私模式 / 禁用存储时只影响下次首帧，不影响本次会话 */
  }
  return dark
}

/** 首帧同步调用，必须先于 createApp */
export function bootstrapTheme(): void {
  applyTheme(storedMode())
}

/** 系统深浅变化（含主进程 nativeTheme 转发）时回调 */
export function watchSystem(callback: (dark: boolean) => void): () => void {
  try {
    if (typeof window.matchMedia !== 'function') return () => undefined
    const query = window.matchMedia(DARK_QUERY)
    const handler = (event: MediaQueryListEvent): void => callback(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  } catch {
    return () => undefined
  }
}

/** 标题栏快捷切换：按当前实际深浅在浅色 / 深色之间来回 */
export function nextMode(dark: boolean): ThemeMode {
  return dark ? 'light' : 'dark'
}
