import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 纯 Node 环境下（单元 / 冒烟测试）electron 的 app 不存在，做一次容错
export const isDev = typeof app === 'undefined' || app === null ? true : !app.isPackaged

/**
 * 路径中心。所有落盘位置只在这里定义，服务层不自行拼路径。
 * libraryDir 可由设置覆盖，便于把书库放到 D: 等非系统盘。
 */
class AppPaths {
  private customRoot?: string

  get data(): string {
    return app.getPath('userData')
  }

  /** 元数据根目录：固定不动，避免切换书库盘符后索引/快照路径漂移 */
  get library(): string {
    return join(this.data, 'library')
  }

  /** 大文件根目录：可由设置指向 D:\Books 等位置 */
  get assets(): string {
    return this.customRoot || this.library
  }

  setLibraryRoot(dir?: string): void {
    this.customRoot = dir && dir.trim() ? dir.trim() : undefined
    this.ensure()
  }

  get books(): string {
    return join(this.assets, 'books')
  }

  get covers(): string {
    return join(this.assets, 'covers')
  }

  get text(): string {
    return join(this.assets, 'text')
  }

  get snapshot(): string {
    return join(this.library, 'library.json')
  }

  get index(): string {
    return join(this.library, 'search-index.json')
  }

  /** 对照翻译的译文缓存（按 目标语言 + 原文哈希 复用，跨书生效） */
  get translationCache(): string {
    return join(this.library, 'translation-cache.json')
  }

  get windowState(): string {
    return join(this.data, 'window-state.json')
  }

  /**
   * 外观偏好镜像。真正的值在 library.json 的 AppSettings.theme 里，
   * 但启动屏 / 窗口底色必须在这份快照读出来之前就知道深浅，否则深色主题会闪一帧浅色。
   * 因此渲染层每次切换外观都同步写这个极小的文件。
   */
  get themePref(): string {
    return join(this.data, 'theme-pref.json')
  }

  bookFile(fileName: string): string {
    return join(this.books, fileName)
  }

  coverFile(fileName: string): string {
    return join(this.covers, fileName)
  }

  textFile(bookId: string): string {
    return join(this.text, `${bookId}.json`)
  }

  ensure(): void {
    for (const dir of [this.library, this.books, this.covers, this.text]) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

export const PATHS = new AppPaths()

/** 自定义协议 book://local/covers/xxx.jpg -> 本地文件 */
export const BOOK_PROTOCOL = 'book'
