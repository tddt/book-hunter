import { BrowserWindow, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDev, PATHS } from './env'
import { EV } from '@shared/contract'

interface WindowState {
  bounds: { x?: number; y?: number; width: number; height: number }
  maximized: boolean
}

function readState(): WindowState | null {
  try {
    if (!existsSync(PATHS.windowState)) return null
    return JSON.parse(readFileSync(PATHS.windowState, 'utf8')) as WindowState
  } catch {
    return null
  }
}

function saveState(win: BrowserWindow): void {
  try {
    const state: WindowState = {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized()
    }
    writeFileSync(PATHS.windowState, JSON.stringify(state), 'utf8')
  } catch {
    /* 窗口状态不是关键数据 */
  }
}

/**
 * 运行时窗口/任务栏图标。不写进 exe 资源：
 * 只要图标出现在 buildResources（build/）里，electron-builder 就会自动用
 * rcedit 改写 exe，本机概率性报 "Unable to commit changes" 并连累 NSIS。
 * 图标实际放在 assets/，开发态读项目目录，打包态读 extraResources。
 */
function appIconPath(): string | undefined {
  const candidates = isDev
    ? [join(process.cwd(), 'assets/icon.ico'), join(__dirname, '../../assets/icon.ico')]
    : [join(process.resourcesPath, 'icon.ico')]
  return candidates.find((p) => existsSync(p))
}

export interface MainWindowHooks {
  /** 主窗口首帧已显示。启动屏在这一刻才开始淡出，避免中间露出桌面。 */
  onReadyToShow?: () => void
  /** 首帧底色深浅，与启动屏保持一致，深色主题不闪白 */
  dark?: boolean
}

export async function createMainWindow(hooks: MainWindowHooks = {}): Promise<BrowserWindow> {
  const state = readState()
  const icon = appIconPath()
  const win = new BrowserWindow({
    ...(icon ? { icon } : {}),
    width: state?.bounds.width || 1320,
    height: state?.bounds.height || 860,
    x: state?.bounds.x,
    y: state?.bounds.y,
    // 2.3：允许把窗口收窄到手机宽度（≤640px 自动切底部标签栏布局）。
    // 桌面宽度下的行为完全不变，这里只是放开下限。
    minWidth: 360,
    minHeight: 520,
    show: false,
    frame: false, // 自绘标题栏：阅读器可全屏沉浸、管理页也没有系统标题栏割裂感
    backgroundColor: hooks.dark ? '#14171e' : '#f5f7fc',
    title: '书猎',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  if (state?.maximized) win.maximize()
  win.once('ready-to-show', () => {
    win.show()
    hooks.onReadyToShow?.()
  })
  win.on('close', () => saveState(win))
  win.on('maximize', () => notifyState(win))
  win.on('unmaximize', () => notifyState(win))
  win.on('enter-full-screen', () => notifyState(win))
  win.on('leave-full-screen', () => notifyState(win))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

export function windowStateOf(win: BrowserWindow): { maximized: boolean; fullScreen: boolean } {
  return { maximized: win.isMaximized(), fullScreen: win.isFullScreen() }
}

function notifyState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send(EV.windowState, windowStateOf(win))
}
