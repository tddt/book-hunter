import { defineStore } from 'pinia'
import { ref } from 'vue'
import { CH, invoke } from '../api'
import { applyTheme } from '../theme'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppInfo, AppSettings, ReaderSettings, ThemeMode } from '@shared/types'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS))
  const appInfo = ref<AppInfo | null>(null)
  const association = ref({ associated: false, detail: '检测中…' })
  const working = ref(false)
  /** 当前实际深浅（已解析 system）；供标题栏图标与阅读器联动使用 */
  const dark = ref(false)
  let nativeDark: boolean | undefined = undefined

  function mode(): ThemeMode {
    return settings.value.theme || 'light'
  }

  /** 设置加载完成 / 系统深浅变化后，把 data-theme 与快照对齐 */
  async function syncTheme(native?: boolean): Promise<void> {
    if (native !== undefined) nativeDark = native
    dark.value = applyTheme(mode(), nativeDark)
    try {
      const result = await invoke(CH.themeSet, mode())
      nativeDark = result.dark
    } catch (error) {
      console.warn('[settings] 主进程外观同步失败（界面仍可用）', error)
    }
  }

  /** 用户主动切换外观：先即时换肤，再持久化，最后同步主进程 nativeTheme */
  async function setTheme(next: ThemeMode): Promise<void> {
    const targetDark = applyTheme(next, nativeDark)
    dark.value = targetDark
    const patch: Partial<AppSettings> = { theme: next }
    // 阅读器有独立的 5 套纸张主题。用户主动切外观时，把「默认纸 / 夜读」同步到
    // 对应深浅，避免深色界面里仍是一张白纸；手动选过羊皮纸/护眼/水墨的则保持不变。
    const readerTheme = settings.value.reader.theme
    if (readerTheme === 'paper' || readerTheme === 'night') {
      patch.reader = { ...settings.value.reader, theme: targetDark ? 'night' : 'paper' }
    }
    settings.value = await invoke(CH.settingsSave, patch)
    try {
      const result = await invoke(CH.themeSet, next)
      nativeDark = result.dark
      dark.value = applyTheme(mode(), nativeDark)
    } catch (error) {
      console.warn('[settings] 外观已生效，但主进程同步失败', error)
    }
  }

  /** 系统深浅变化：仅「跟随系统」模式需要重新解析 */
  function onNativeTheme(value: boolean): void {
    nativeDark = value
    if (mode() === 'system') dark.value = applyTheme('system', value)
  }

  async function load(): Promise<void> {
    settings.value = await invoke(CH.settingsGet)
  }

  async function loadInfo(): Promise<void> {
    ;[appInfo.value, association.value] = await Promise.all([
      invoke(CH.appInfo),
      invoke(CH.associationGet)
    ])
  }

  async function save(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await invoke(CH.settingsSave, patch)
  }

  async function saveReader(patch: Partial<ReaderSettings>): Promise<void> {
    await save({ reader: { ...settings.value.reader, ...patch } })
  }

  async function setAssociation(enable: boolean): Promise<void> {
    working.value = true
    try {
      association.value = await invoke(CH.associationSet, enable)
      appInfo.value = await invoke(CH.appInfo)
    } finally {
      working.value = false
    }
  }

  return {
    settings, appInfo, association, working, dark,
    load, loadInfo, save, saveReader, setAssociation,
    syncTheme, setTheme, onNativeTheme
  }
})
