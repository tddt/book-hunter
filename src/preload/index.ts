import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CH, EV, type Api } from '@shared/contract'

/**
 * 安全边界：contextIsolation 打开，渲染进程拿不到 ipcRenderer 本体，
 * 只能走白名单里的通道。通道清单直接来自 shared/contract，
 * 主进程与渲染进程共用同一份定义，杜绝手写字符串漂移。
 */
const invokeChannels = new Set<string>(Object.values(CH) as string[])
const eventChannels = new Set<string>(Object.values(EV) as string[])

const api: Api = {
  invoke: ((channel: string, ...args: unknown[]) => {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`未授权的 IPC 通道：${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  }) as Api['invoke'],

  on: ((channel: string, listener: (payload: unknown) => void) => {
    if (!eventChannels.has(channel)) return () => undefined
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }) as Api['on'],

  getFilePath: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
