import type { BrowserWindow } from 'electron'
import type { EventChannel, EventPayload } from '@shared/contract'

/** 领域服务只依赖这个抽象，不直接持有 BrowserWindow */
export interface IEventBus {
  attach(win: BrowserWindow): void
  emit<C extends EventChannel>(channel: C, payload: EventPayload<C>): void
}

export class WindowEventBus implements IEventBus {
  private win?: BrowserWindow

  attach(win: BrowserWindow): void {
    this.win = win
  }

  emit<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
    try {
      if (this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
        this.win.webContents.send(channel, payload)
      }
    } catch {
      // 窗口正在关闭，丢弃即可，不影响主流程
    }
  }
}
