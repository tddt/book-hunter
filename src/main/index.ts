import { app, Menu, nativeTheme, protocol, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { BOOK_PROTOCOL, isDev, PATHS } from './env'
import { createMainWindow } from './window'
import { createContainer, type Container } from './container'
import { registerIpc } from './ipc'
import { collectBookArgs, getAssociationState } from './file-association'
import { showSplash } from './splash'
import { initTheme } from './theme'
import { EV } from '@shared/contract'
import type { AppInfo } from '@shared/types'

// 必须在 app ready 之前注册自定义 scheme
protocol.registerSchemesAsPrivileged([
  {
    scheme: BOOK_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let container: Container | null = null
let mainWindow: BrowserWindow | null = null
let bootDark = false
const pendingFiles: string[] = []

function takePendingFiles(): string[] {
  return pendingFiles.splice(0, pendingFiles.length)
}

function deliverFiles(paths: string[]): void {
  if (!paths.length) return
  if (container && mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isLoading() === false) {
    container.events.emit(EV.openFiles, { paths })
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else {
    pendingFiles.push(...paths)
  }
}

async function getAppInfo(): Promise<AppInfo> {
  const association = await getAssociationState()
  return {
    version: app.getVersion(),
    platform: process.platform,
    isDev,
    dataDir: PATHS.data,
    libraryDir: PATHS.assets,
    associated: association.associated
  }
}

/** book://local/covers/xxx.jpg -> 书库目录下的真实文件，只放行三个子目录 */
function registerBookProtocol(): void {
  protocol.registerFileProtocol(BOOK_PROTOCOL, (request, callback) => {
    try {
      const url = new URL(request.url)
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!/^(covers|books|text)\//.test(relative)) {
        callback({ error: -6 })
        return
      }
      callback({ path: join(PATHS.assets, relative) })
    } catch {
      callback({ error: -6 })
    }
  })
}

async function bootstrap(): Promise<void> {
  // 外观必须在任何窗口创建前恢复：启动屏 / 窗口底色要按上次偏好着色，
  // 否则深色主题下会先闪一帧浅色启动屏再切过去。
  bootDark = initTheme()
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(EV.nativeThemeChanged, { dark: nativeTheme.shouldUseDarkColors })
    }
  })

  // 启动屏必须先于任何耗时初始化创建。它是纯展示窗口，失败也不影响主流程。
  const splash = showSplash(bootDark)
  try {
    Menu.setApplicationMenu(null)
    registerBookProtocol()
    pendingFiles.push(...collectBookArgs(process.argv))
    splash?.setPhase('正在启动书猎…', 6)

    container = await createContainer((label, percent) => splash?.setPhase(label, percent))

    // 必须在创建窗口 / 加载页面之前注册 IPC：
    // createMainWindow() 会 await loadFile/loadURL，等它返回时 renderer 早已挂载并调用 app:ready。
    // 若把注册放在后面，启动首屏必然收到 "No handler registered"，书库与事件订阅全部加载失败。
    // getWindow 是惰性的，此时为 null 不影响注册。
    registerIpc(container, {
      getWindow: () => mainWindow,
      takePendingFiles,
      getAppInfo
    })

    splash?.setPhase('正在准备主窗口…', 86)
    mainWindow = await createMainWindow({
      dark: bootDark,
      onReadyToShow: () => {
        splash?.setPhase('即将就绪', 100)
        splash?.finish()
      }
    })
    container.events.attach(mainWindow)

    // 冷启动携带的电子书（含 EPUB / MOBI / AZW3 / PDF / TXT）只由 renderer 调用 app:ready 取走，
    // 避免与 did-finish-load 抢同一份 pending 导致路径丢失。
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('启动失败', error)
    splash?.fail(message)
    // 留出时间让用户看清失败原因，再退出；否则窗口一闪而过，比没有提示更糟。
    setTimeout(() => app.quit(), 1700)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    deliverFiles(collectBookArgs(argv))
  })

  // macOS：Finder 双击电子书（关联范围内）
  app.on('open-file', (event, path) => {
    event.preventDefault()
    deliverFiles(collectBookArgs([path]))
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createMainWindow({ dark: bootDark }).then((win) => {
        mainWindow = win
        container?.events.attach(win)
      })
    }
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('启动失败', error)
    app.quit()
  })
}
