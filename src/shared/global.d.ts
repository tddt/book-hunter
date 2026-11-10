import type { Api } from './contract'

declare global {
  interface Window {
    /** preload 通过 contextBridge 注入的唯一入口 */
    api: Api
  }
}

export {}
