import { nativeTheme } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PATHS } from './env'
import type { ThemeMode } from '@shared/types'

/**
 * 主进程侧的外观真值。
 *
 * 渲染层负责把 `data-theme` 写到 <html>，主进程负责：
 *  1) nativeTheme.themeSource —— 让 Chromium 的 prefers-color-scheme、系统右键菜单、
 *     原生对话框与「跟随系统」判定保持一致；
 *  2) theme-pref.json —— 启动屏与 BrowserWindow.backgroundColor 在这一帧就要知道深浅，
 *     那时 library.json 还没读、IPC 还没注册，只能靠这份同步可读的小文件；
 *  3) nativeTheme 'updated' 事件 —— 由 index.ts 转发给渲染层。
 *
 * 任何文件 / API 异常都静默降级为「浅色」，绝不让外观问题阻塞启动。
 */

function readMode(): ThemeMode {
  try {
    if (!existsSync(PATHS.themePref)) return 'light'
    const raw = JSON.parse(readFileSync(PATHS.themePref, 'utf8')) as { mode?: unknown }
    return raw?.mode === 'dark' || raw?.mode === 'system' ? raw.mode : 'light'
  } catch {
    return 'light'
  }
}

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  try {
    return nativeTheme.shouldUseDarkColors
  } catch {
    return false
  }
}

/** bootstrap 最开头调用：恢复上次偏好，返回首帧该用的深浅 */
export function initTheme(): boolean {
  const mode = readMode()
  try {
    nativeTheme.themeSource = mode
  } catch {
    /* 非 Electron 环境（离线验证）忽略 */
  }
  return resolveDark(mode)
}

/** 渲染层切换外观时调用；返回当前是否深色，供调用方即时刷新 UI */
export function setThemeMode(mode: ThemeMode): boolean {
  try {
    writeFileSync(PATHS.themePref, JSON.stringify({ mode }), 'utf8')
  } catch {
    /* 只读用户目录时不影响本次会话生效 */
  }
  try {
    nativeTheme.themeSource = mode
  } catch {
    /* 同上 */
  }
  return resolveDark(mode)
}

export function getThemeMode(): ThemeMode {
  return readMode()
}
