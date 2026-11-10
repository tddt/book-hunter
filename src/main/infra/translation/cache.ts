/**
 * 译文缓存：按「目标语言 + 原文」哈希持久化，跨书、跨章节复用。
 *
 * 免费通道都有额度/频率限制，重复翻同一段纯属浪费；缓存命中后
 * 阅读器切章、换主题、重开应用都能离线显示译文。
 * 存储沿用 AtomicJsonStore（先写 .tmp 再 rename），写入按批合并，避免高频 IO。
 */
import { createHash } from 'node:crypto'
import type { TranslationProviderId } from '@shared/types'
import { AtomicJsonStore } from '../json-store'

export interface CacheEntry {
  text: string
  translation: string
  providerId?: TranslationProviderId
  at: number
}

interface CacheFile {
  version: number
  entries: Record<string, CacheEntry>
}

/** 上限约 2 万段（按 480 字符估算约 10 MB JSON），超出按时间淘汰最旧的 25% */
const MAX_ENTRIES = 20000

export function cacheKey(targetLang: string, text: string): string {
  return createHash('sha1').update(`${targetLang}\u0000${text}`).digest('hex')
}

export class TranslationCache {
  private readonly store: AtomicJsonStore<CacheFile>
  private readonly memory = new Map<string, CacheEntry>()

  constructor(filePath: string) {
    this.store = new AtomicJsonStore<CacheFile>(filePath, () => ({ version: 1, entries: {} }))
  }

  async init(): Promise<void> {
    const data = await this.store.read()
    if (!data.entries || typeof data.entries !== 'object') {
      await this.store.replace({ version: 1, entries: {} })
      return
    }
    for (const [key, entry] of Object.entries(data.entries)) {
      if (entry && typeof entry.translation === 'string') this.memory.set(key, entry)
    }
  }

  get(key: string): CacheEntry | undefined {
    return this.memory.get(key)
  }

  get size(): number {
    return this.memory.size
  }

  /** 一批一次落盘；只写新译文，命中缓存的段不会重复写 */
  async put(items: { key: string; text: string; translation: string; providerId: TranslationProviderId }[]): Promise<void> {
    if (!items.length) return
    const now = Date.now()
    await this.store.mutate((draft) => {
      if (!draft.entries || typeof draft.entries !== 'object') draft.entries = {}
      for (const item of items) {
        const entry: CacheEntry = {
          text: item.text,
          translation: item.translation,
          providerId: item.providerId,
          at: now
        }
        this.memory.set(item.key, entry)
        draft.entries[item.key] = entry
      }
      const keys = Object.keys(draft.entries)
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (draft.entries[a]?.at || 0) - (draft.entries[b]?.at || 0))
        const drop = keys.slice(0, Math.ceil(MAX_ENTRIES * 0.25))
        for (const key of drop) {
          delete draft.entries[key]
          this.memory.delete(key)
        }
      }
    })
  }

  /** 清空全部，或只清某个目标语言（用 text 前缀无法区分，故按原存 key 无法过滤 -> 用 text 重建 key 反查） */
  async clear(targetLang?: string): Promise<number> {
    let removed = 0
    await this.store.mutate((draft) => {
      if (!draft.entries) draft.entries = {}
      if (!targetLang) {
        removed = Object.keys(draft.entries).length
        draft.entries = {}
        this.memory.clear()
        return
      }
      for (const [key, entry] of Object.entries(draft.entries)) {
        if (cacheKey(targetLang, entry.text) === key) {
          delete draft.entries[key]
          this.memory.delete(key)
          removed += 1
        }
      }
    })
    return removed
  }
}
