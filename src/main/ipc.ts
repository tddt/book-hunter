import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { CH, type IpcArgs, type IpcChannel, type IpcResult } from '@shared/contract'
import type { AppInfo } from '@shared/types'
import type { Container } from './container'
import { getAssociationState, setAssociation } from './file-association'
import { setThemeMode } from './theme'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  takePendingFiles: () => string[]
  getAppInfo: () => Promise<AppInfo>
}

/** 统一的 handle 包装：集中做错误日志与白名单，业务侧只写纯逻辑 */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const run = fn as (...a: unknown[]) => IpcResult<C> | Promise<IpcResult<C>>
      return await run(...args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[IPC ${channel}] ${message}`, error)
      throw new Error(message)
    }
  })
}

export function registerIpc(c: Container, deps: IpcDeps): void {
  handle(CH.appReady, async () => ({
    pendingFiles: deps.takePendingFiles(),
    info: await deps.getAppInfo()
  }))
  handle(CH.appInfo, () => deps.getAppInfo())

  handle(CH.libraryList, () => c.library.snapshot())
  handle(CH.libraryGet, (id) => c.library.get(id))
  handle(CH.libraryUpdate, (id, patch) => c.library.update(id, patch))
  handle(CH.libraryRemove, (ids, deleteFile) => c.library.remove(ids, deleteFile))
  handle(CH.libraryReveal, (id) => c.library.reveal(id))
  handle(CH.categorySave, (category) => c.library.saveCategory(category))
  handle(CH.categoryRemove, (id) => c.library.removeCategory(id))
  handle(CH.tagSave, (tag) => c.library.saveTag(tag))
  handle(CH.tagRemove, (id) => c.library.removeTag(id))

  handle(CH.importPick, () => c.importer.pickFiles())
  handle(CH.importPickFolder, () => c.importer.pickFolder())
  handle(CH.importPaths, (options) => c.importer.import(options))

  handle(CH.toolsPickTxt, () => c.tools.pickTxtFiles())
  handle(CH.toolsPickOutput, () => c.tools.pickOutputDir())
  handle(CH.toolsTxtToEpub, (options) => c.tools.convertTxtToEpub(options))

  handle(CH.search, (query) => c.search.query(query))
  handle(CH.searchRebuild, () => c.search.rebuild())
  handle(CH.searchRebuildContent, () => c.search.rebuildContent())

  handle(CH.onlineSources, () => c.online.listSources())
  handle(CH.onlineProbe, (ids) => c.online.probe(ids))
  handle(CH.onlineFeatured, (query) => c.online.featured(query || {}))
  handle(CH.onlineSearch, (query) => c.online.search(query))
  handle(CH.onlineDownload, (request) => c.online.download(request))
  handle(CH.onlineCancel, (jobId) => c.online.cancel(jobId))
  handle(CH.onlineSourceToggle, (id, enabled) => c.online.toggleSource(id, enabled))
  handle(CH.onlineOpdsSave, (source) => c.online.saveOpds(source))
  handle(CH.onlineOpdsRemove, (id) => c.online.removeOpds(id))

  handle(CH.translateLanguages, () => c.translation.listLanguages())
  handle(CH.translateProviders, () => c.translation.listProviders())
  handle(CH.translateProbe, (ids) => c.translation.probe(ids))
  handle(CH.translateProviderToggle, (id, enabled) => c.translation.toggleProvider(id, enabled))
  handle(CH.translateSetEndpoint, (endpoint) => c.translation.setEndpoint(endpoint))
  handle(CH.translateRun, (request) => c.translation.run(request))
  handle(CH.translateCancel, (jobId) => c.translation.cancel(jobId))
  handle(CH.translateCacheClear, (targetLang) => c.translation.clearCache(targetLang))

  handle(CH.readerLoad, (id) => c.reader.load(id))
  handle(CH.readerContent, (id) => c.reader.content(id))
  handle(CH.progressGet, (id) => c.reader.progressGet(id))
  handle(CH.progressSave, (progress) => c.reader.progressSave(progress))
  handle(CH.bookmarkList, (id) => c.reader.bookmarkList(id))
  handle(CH.bookmarkAdd, (bookmark) => c.reader.bookmarkAdd(bookmark))
  handle(CH.bookmarkRemove, (id) => c.reader.bookmarkRemove(id))
  handle(CH.noteList, (id) => c.reader.noteList(id))
  handle(CH.noteAdd, (note) => c.reader.noteAdd(note))
  handle(CH.noteUpdate, (id, patch) => c.reader.noteUpdate(id, patch))
  handle(CH.noteRemove, (id) => c.reader.noteRemove(id))

  handle(CH.settingsGet, () => c.library.getSettings())
  handle(CH.settingsSave, (patch) => c.library.saveSettings(patch))
  handle(CH.themeSet, (mode) => ({ dark: setThemeMode(mode) }))
  handle(CH.metadataRefresh, (id) => c.metadata.refresh(id))

  handle(CH.associationGet, () => getAssociationState())
  handle(CH.associationSet, (enable) => setAssociation(enable))
  handle(CH.systemPickDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择书库存放目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] || null
  })

  handle(CH.windowAction, (action) => {
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) return false
    switch (action) {
      case 'minimize':
        win.minimize()
        return false
      case 'maximize':
        win.maximize()
        return true
      case 'unmaximize':
        win.unmaximize()
        return false
      case 'close':
        win.close()
        return false
      case 'fullscreen':
        win.setFullScreen(!win.isFullScreen())
        return win.isFullScreen()
      case 'is-maximized':
        return win.isMaximized()
      default:
        return false
    }
  })

  handle(CH.shellOpen, (target) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    else void shell.openPath(target)
  })
}
