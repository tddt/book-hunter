/**
 * 对照翻译编排服务。
 *
 * 职责：缓存命中 -> 按首选/启用顺序选通道 -> 按通道批量能力分批 ->
 * 失败自动回退到下一个通道 -> 进度事件 -> 结果落缓存。
 * 领域层只依赖适配器接口，新增通道只需在 providers.ts 注册一次。
 */
import { EV } from '@shared/contract'
import {
  DEFAULT_TRANSLATION_SETTINGS,
  TRANSLATION_LANGUAGES
} from '@shared/constants'
import type {
  TranslateProgress,
  TranslateRequest,
  TranslateResult,
  TranslatedSegment,
  TranslationLanguage,
  TranslationProviderId,
  TranslationProviderInfo,
  TranslationSettings
} from '@shared/types'
import type { IEventBus } from '../infra/event-bus'
import { friendlyError } from '../infra/translation/http'
import { cacheKey, TranslationCache } from '../infra/translation/cache'
import {
  BUILT_IN_PROVIDERS,
  DEFAULT_DISABLED_PROVIDERS,
  providerError,
  providerInfo,
  type TranslateProvider
} from '../infra/translation/providers'
import type { LibraryService } from './library.service'

interface Health {
  healthy: boolean
  latencyMs: number
  lastError?: string
}

interface Pending {
  id: string
  text: string
  key: string
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
  return out
}

export class TranslationService {
  private readonly cache: TranslationCache
  private readonly health = new Map<TranslationProviderId, Health>()
  private readonly jobs = new Map<string, AbortController>()
  /** 「任务刚提交、控制器还没创建」时被点掉的取消请求，避免启动竞态丢信号 */
  private readonly cancelledJobs = new Map<string, number>()

  constructor(
    private readonly library: LibraryService,
    private readonly events: IEventBus,
    cachePath: string
  ) {
    this.cache = new TranslationCache(cachePath)
  }

  async initialize(): Promise<void> {
    await this.cache.init()
    const cfg = await this.config()
    this.syncEndpoint(cfg)
  }

  private async config(): Promise<TranslationSettings> {
    const settings = await this.library.getSettings()
    return {
      ...DEFAULT_TRANSLATION_SETTINGS,
      ...(settings.translation || {}),
      disabledProviders: settings.translation?.disabledProviders || [...DEFAULT_DISABLED_PROVIDERS]
    }
  }

  private syncEndpoint(cfg: TranslationSettings): void {
    const libre = BUILT_IN_PROVIDERS.find((p) => p.meta.id === 'libre')
    libre?.setEndpoint?.(cfg.customEndpoint || '')
  }

  listLanguages(): TranslationLanguage[] {
    return TRANSLATION_LANGUAGES.map((lang) => ({ ...lang }))
  }

  async listProviders(): Promise<TranslationProviderInfo[]> {
    const cfg = await this.config()
    const disabled = new Set(cfg.disabledProviders)
    return BUILT_IN_PROVIDERS.map((p) =>
      providerInfo(p, !disabled.has(p.meta.id), this.health.get(p.meta.id))
    )
  }

  /** 健康探测：只探测点名的通道；未点名时探测当前启用的通道 */
  async probe(ids?: TranslationProviderId[]): Promise<TranslationProviderInfo[]> {
    const cfg = await this.config()
    this.syncEndpoint(cfg)
    const disabled = new Set(cfg.disabledProviders)
    const targets = ids?.length
      ? BUILT_IN_PROVIDERS.filter((p) => ids.includes(p.meta.id))
      : BUILT_IN_PROVIDERS.filter((p) => !disabled.has(p.meta.id))

    await Promise.all(
      targets.map(async (provider) => {
        const start = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12000)
        try {
          await provider.probe(controller.signal)
          this.health.set(provider.meta.id, { healthy: true, latencyMs: Date.now() - start })
        } catch (error) {
          this.health.set(provider.meta.id, {
            healthy: false,
            latencyMs: Date.now() - start,
            lastError: friendlyError(error)
          })
        } finally {
          clearTimeout(timer)
        }
      })
    )
    return this.listProviders()
  }

  async toggleProvider(id: TranslationProviderId, enabled: boolean): Promise<TranslationProviderInfo[]> {
    const cfg = await this.config()
    const disabled = new Set(cfg.disabledProviders)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    cfg.disabledProviders = [...disabled]
    await this.library.saveSettings({ translation: cfg })
    return this.listProviders()
  }

  async setEndpoint(endpoint: string): Promise<TranslationProviderInfo[]> {
    const value = endpoint.trim().replace(/\/+$/, '')
    if (value && !/^https?:\/\//i.test(value)) throw new Error('端点必须以 http(s):// 开头')
    const cfg = await this.config()
    cfg.customEndpoint = value
    await this.library.saveSettings({ translation: cfg })
    this.syncEndpoint(cfg)
    this.health.delete('libre')
    return this.listProviders()
  }

  /** 用户主动取消（切章、关闭面板、点停止） */
  cancel(jobId: string): void {
    const controller = this.jobs.get(jobId)
    if (controller) controller.abort()
    else this.cancelledJobs.set(jobId, Date.now())
    this.jobs.delete(jobId)
  }

  async clearCache(targetLang?: string): Promise<{ removed: number }> {
    return { removed: await this.cache.clear(targetLang) }
  }

  private emit(progress: TranslateProgress): void {
    this.events.emit(EV.translateProgress, progress)
  }

  /** 按「首选 + 其余启用 + 支持目标语言 + 已配置端点」排好回退链 */
  private chain(cfg: TranslationSettings, targetLang: string, requested?: TranslationProviderId): TranslateProvider[] {
    const disabled = new Set(cfg.disabledProviders)
    const usable = BUILT_IN_PROVIDERS.filter(
      (p) => !disabled.has(p.meta.id) && p.supports(targetLang) && (p.meta.id !== 'libre' || Boolean(cfg.customEndpoint))
    )
    if (requested) return usable.filter((p) => p.meta.id === requested)
    const preferred = usable.find((p) => p.meta.id === cfg.preferredProvider)
    return preferred ? [preferred, ...usable.filter((p) => p !== preferred)] : usable
  }

  async run(request: TranslateRequest): Promise<TranslateResult> {
    const start = Date.now()
    const cfg = await this.config()
    this.syncEndpoint(cfg)
    const targetLang = request.targetLang || cfg.targetLang
    const sourceLang = request.sourceLang || 'auto'
    const total = request.texts.length

    // 同一 jobId 重跑时先取消上一次，避免重复消耗免费额度。
    // 不能用 cancel()：它会写入「预取消」标记，反而把这次新任务也标记掉。
    const previous = this.jobs.get(request.jobId)
    if (previous) {
      previous.abort()
      this.jobs.delete(request.jobId)
    }
    // 清理过期标记（例如用户对着一个已结束的任务点了停止）
    for (const [key, at] of this.cancelledJobs) {
      if (Date.now() - at > 30000) this.cancelledJobs.delete(key)
    }
    const controller = new AbortController()
    if (this.cancelledJobs.delete(request.jobId)) controller.abort()
    this.jobs.set(request.jobId, controller)
    const signal = controller.signal

    const results = new Map<string, TranslatedSegment>()
    const fresh: { key: string; text: string; translation: string; providerId: TranslationProviderId }[] = []
    const oversize: { id: string; message: string }[] = []
    let cached = 0
    let translated = 0
    let detected: string | undefined
    let cancelled = signal.aborted
    const usedProviders: TranslationProviderId[] = []
    const channelErrors: string[] = []

    // 1) 缓存命中直接出结果；过长的段落先挡掉，避免把免费额度浪费在必失败的请求上
    const pending: Pending[] = []
    for (const item of request.texts) {
      const text = (item.text || '').trim()
      if (!text) continue
      if (text.length > 1600) {
        oversize.push({ id: item.id, message: '段落过长（>1600 字符），请缩短选区或关闭后重试' })
        continue
      }
      const key = cacheKey(targetLang, text)
      const hit = request.force ? undefined : this.cache.get(key)
      if (hit) {
        results.set(item.id, { id: item.id, translation: hit.translation, providerId: hit.providerId, cached: true })
        cached += 1
      } else {
        pending.push({ id: item.id, text, key })
      }
    }

    this.emit({
      jobId: request.jobId,
      phase: 'translating',
      done: cached,
      total,
      message: cached ? `缓存命中 ${cached} 段` : undefined
    })

    // 2) 逐通道尝试：失败的批次整体留给下一个通道
    let remaining = pending
    const providers = this.chain(cfg, targetLang, request.providerId)
    if (request.providerId && !providers.length) {
      channelErrors.push(`指定的「${request.providerId}」通道未启用、不支持该语言或端点未配置`)
    }

    for (const provider of providers) {
      if (signal.aborted) cancelled = true
      if (!remaining.length || signal.aborted) break
      const batches = chunk(remaining, Math.max(1, provider.meta.batchSize))
      const failed: Pending[] = []
      let consecutiveFails = 0
      let used = false

      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index]
        if (signal.aborted) {
          cancelled = true
          failed.push(...batch)
          continue
        }
        if (batch.some((item) => item.text.length > provider.meta.maxChars)) {
          failed.push(...batch)
          continue
        }
        try {
          const out = await provider.translate(
            batch.map((item) => item.text),
            sourceLang,
            targetLang,
            signal
          )
          if (out.translations.length !== batch.length) throw new Error('译文段数不符')
          if (out.detected && !detected) detected = out.detected
          batch.forEach((item, i) => {
            results.set(item.id, {
              id: item.id,
              translation: out.translations[i],
              providerId: provider.meta.id,
              cached: false
            })
            fresh.push({
              key: item.key,
              text: item.text,
              translation: out.translations[i],
              providerId: provider.meta.id
            })
          })
          translated += batch.length
          used = true
          consecutiveFails = 0
          this.emit({
            jobId: request.jobId,
            phase: 'translating',
            done: cached + translated,
            total,
            providerId: provider.meta.id
          })
        } catch (error) {
          failed.push(...batch)
          consecutiveFails += 1
          const reason = `${provider.meta.name}：${providerError(error)}`
          if (!channelErrors.includes(reason)) channelErrors.push(reason)
          // 连续两批失败即判定该通道整体不可用，剩余批次直接交给下一个通道
          if (consecutiveFails >= 2) {
            for (let j = index + 1; j < batches.length; j += 1) failed.push(...batches[j])
            break
          }
        }
      }
      if (used && !usedProviders.includes(provider.meta.id)) usedProviders.push(provider.meta.id)
      remaining = failed
      // 缓存写入按通道合并，减少磁盘 IO
      if (fresh.length) {
        await this.cache.put(fresh)
        fresh.length = 0
      }
    }

    if (fresh.length) await this.cache.put(fresh)
    this.jobs.delete(request.jobId)

    const errors = [...oversize]
    const reason =
      cancelled ? '已取消' :
      channelErrors.length ? channelErrors.slice(-2).join('；') :
      '所有启用的免费翻译通道都不可用，可在「通道管理」里重新探测或启用其它通道'
    for (const item of remaining) errors.push({ id: item.id, message: reason })

    this.emit({
      jobId: request.jobId,
      phase: cancelled || errors.length ? 'error' : 'done',
      done: results.size,
      total,
      message: errors.length ? `${errors.length} 段未完成：${reason}` : undefined
    })

    return {
      jobId: request.jobId,
      chapterIndex: request.chapterIndex,
      targetLang,
      detectedLanguage: detected,
      usedProviders,
      segments: [...results.values()],
      errors,
      took: Date.now() - start,
      cached,
      translated,
      cancelled
    }
  }
}
