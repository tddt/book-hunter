import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { isDev, PATHS } from './env'
import { isBookPath } from '@shared/formats'

/**
 * 电子书文件关联 / 命令行收书（2.0）。
 *
 * 两条路径：
 *  1) 安装包：electron-builder.yml 的 fileAssociations，NSIS 安装时写注册表；
 *  2) 运行时：本模块写 HKCU\Software\Classes（免管理员），供便携版 / 开发版一键关联。
 *
 * 重要：注册表默认打开方式**仍然只注册 .epub**，不擅自接管用户的 PDF / TXT，
 * 避免影响其它阅读器。但命令行 / 拖拽 / 文件对话框传入的 MOBI / AZW3 / PDF / TXT
 * 一律照单收下，交给导入服务统一转码——用户手动指定书猎打开时是明确意图。
 *
 * 注册前备份 .epub 原有的默认值到 association-backup.json，
 * 取消关联时精确恢复，绝不粗暴删键把别人的关联一起弄坏。
 */
const exec = promisify(execFile)
const PROG_ID = 'ShuLie.epub'
const APP_CLASS = 'Applications\\ShuLie.exe'
const CLASS_ROOT = 'HKCU\\Software\\Classes'

function backupFile(): string {
  return join(PATHS.data, 'association-backup.json')
}

/** 1.0 语义保留：只判断 .epub，供注册表关联状态相关逻辑使用 */
export function isEpubPath(value: string): boolean {
  return typeof value === 'string' && /\.epub$/i.test(value.trim()) && !value.trim().startsWith('-')
}

/** 2.0：所有受支持格式的路径判断（EPUB / MOBI / AZW3 / PDF / TXT 及别名） */
export function isBookFilePath(value: string): boolean {
  return isBookPath(value)
}

/** 从进程命令行参数里挑出「可导入的电子书」路径（Windows 双击 / 命令行传入 / macOS open-file） */
export function collectBookArgs(argv: string[]): string[] {
  return [...new Set(argv.filter(isBookPath).map((p) => p.trim()))]
}

/** 兼容旧调用名：现在实际接收全部受支持格式 */
export function collectEpubArgs(argv: string[]): string[] {
  return collectBookArgs(argv)
}

async function regQueryDefault(key: string): Promise<string> {
  try {
    const { stdout } = await exec('reg.exe', ['query', key, '/ve'], { windowsHide: true })
    const match = stdout.match(/REG_SZ\s+(.+)/)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

async function regSetDefault(key: string, value: string): Promise<void> {
  await exec('reg.exe', ['add', key, '/ve', '/d', value, '/f'], { windowsHide: true })
}

async function regDelete(key: string, valueOnly = false): Promise<void> {
  const args = ['delete', key]
  if (valueOnly) args.push('/ve')
  args.push('/f')
  await exec('reg.exe', args, { windowsHide: true }).catch(() => undefined)
}

function openCommand(): string {
  const exe = app.getPath('exe')
  // 开发模式 electron.exe 需要额外带上应用目录参数，否则双击只会开一个空白 Electron
  const devArg = isDev ? ` "${process.cwd()}"` : ''
  return `"${exe}"${devArg} "%1"`
}

export async function getAssociationState(): Promise<{ associated: boolean; detail: string }> {
  if (process.platform !== 'win32') {
    return { associated: false, detail: '非 Windows 平台由系统安装包负责文件关联' }
  }
  const current = await regQueryDefault(`${CLASS_ROOT}\\.epub`)
  return {
    associated: current === PROG_ID,
    detail: current ? `当前 .epub 默认打开方式：${current}` : '当前 .epub 未设置默认打开方式'
  }
}

export async function setAssociation(enable: boolean): Promise<{ associated: boolean; detail: string }> {
  if (process.platform !== 'win32') {
    return { associated: false, detail: '运行时关联仅支持 Windows，macOS / Linux 请使用安装包' }
  }
  if (!enable) {
    await regDelete(`${CLASS_ROOT}\\${PROG_ID}`)
    await regDelete(`${CLASS_ROOT}\\${APP_CLASS}`)
    try {
      const backup = JSON.parse(await readFile(backupFile(), 'utf8')) as { previous?: string }
      if (backup.previous) await regSetDefault(`${CLASS_ROOT}\\.epub`, backup.previous)
      else await regDelete(`${CLASS_ROOT}\\.epub`, true)
    } catch {
      await regDelete(`${CLASS_ROOT}\\.epub`, true)
    }
    return getAssociationState()
  }

  const previous = await regQueryDefault(`${CLASS_ROOT}\\.epub`)
  try {
    await writeFile(backupFile(), JSON.stringify({ previous, at: Date.now() }), 'utf8')
  } catch {
    /* 备份失败不阻断注册，取消时会走安全删除默认值的分支 */
  }

  const command = openCommand()
  await regSetDefault(`${CLASS_ROOT}\\.epub`, PROG_ID)
  await regSetDefault(`${CLASS_ROOT}\\${PROG_ID}`, 'EPUB 电子书 (书猎)')
  await regSetDefault(`${CLASS_ROOT}\\${PROG_ID}\\DefaultIcon`, `"${app.getPath('exe')}",0`)
  await regSetDefault(`${CLASS_ROOT}\\${PROG_ID}\\shell\\open\\command`, command)
  await regSetDefault(`${CLASS_ROOT}\\${APP_CLASS}\\shell\\open\\command`, command)
  return getAssociationState()
}
