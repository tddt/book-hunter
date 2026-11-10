/**
 * 免费翻译通道适配器。
 *
 * 合规边界：只接入各厂商面向公众免费开放、无需 API Key 的网页/公共接口，
 * 仅用于个人阅读的低频翻译；不伪造付费凭证、不绕过鉴权、不接需要逆向签名的接口
 * （有道 / 百度 / 搜狗的网页签名版实测已失效，故不纳入）。
 *
 * 全部经本机实测（2026-11-09）：
 * - tencent  TranSmart /api/imt：免 key、批量、自动检测源语言、~0.2s；国内稳定
 * - bing     cn.bing.com/ttranslatev3：需从翻译页解析 IG/IID/key/token；www. 域名返回空 body
 * - mymemory api.mymemory.translated.net：免 key，但单请求 500 字符上限
 * - google   translate.googleapis.com/translate_a/single：海外可用，国内超时，默认关闭
 * - libre    用户自建 LibreTranslate 兼容端点（需自行配置地址）
 */
import type { TranslationProviderId, TranslationProviderInfo } from '@shared/types'
import {
  formBody,
  requestJson,
  requestText,
  TranslateHttpError,
  type RequestOptions
} from './http'

export interface ProviderMeta {
  id: TranslationProviderId
  name: string
  description: string
  homepage: string
  license: string
  builtIn: boolean
  /** 单段文本字符上限，超出由服务层先切分 */
  maxChars: number
  /** 一次批量请求最多几段 */
  batchSize: number
}

export interface TranslateBatch {
  translations: string[]
  /** 服务端返回的检测语种（若有） */
  detected?: string
}

export interface TranslateProvider {
  readonly meta: ProviderMeta
  /** 健康探测：发一句短文本，失败即抛错 */
  probe(signal?: AbortSignal): Promise<void>
  /** 翻译一批文本，返回与输入等长的译文；任一段失败即抛错，由服务层回退 */
  translate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal
  ): Promise<TranslateBatch>
  supports(lang: string): boolean
  setEndpoint?(endpoint: string): void
}

/** TranSmart 实测支持的目标语种 */
const TENCENT_LANGS = new Set([
  'zh', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'it', 'pt', 'ar', 'th', 'vi', 'tr'
])

/**
 * 轻量语种识别：MyMemory / LibreTranslate 不接受 `auto`，
 * 需要显式源语言。TranSmart / Bing / Google 自带自动检测，不用这个结果。
 */
export function detectSourceLanguage(text: string): string {
  const sample = text.slice(0, 400)
  if (/[\u3040-\u30ff]/u.test(sample)) return 'ja'
  if (/[\uac00-\ud7af]/u.test(sample)) return 'ko'
  if (/[\u0400-\u04ff]/u.test(sample)) return 'ru'
  if (/[\u0600-\u06ff]/u.test(sample)) return 'ar'
  if (/[\u0e00-\u0e7f]/u.test(sample)) return 'th'
  const han = (sample.match(/[\u4e00-\u9fff]/gu) || []).length
  const letters = sample.replace(/\s/g, '').length || 1
  if (han / letters > 0.25) return 'zh-CN'
  return 'en'
}

const tencentLang = (lang: string): string => (lang === 'zh-CN' ? 'zh' : lang)
const bingLang = (lang: string): string =>
  lang === 'zh-CN' ? 'zh-Hans' : lang === 'zh-TW' ? 'zh-Hant' : lang
const myMemoryLang = (lang: string): string => (lang === 'zh' ? 'zh-CN' : lang)

function clientKey(): string {
  return `browser-chrome-126.0-Windows_10-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 并发执行，且保留输入顺序；任一项抛错则整体失败（交给服务层回退） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

function assertTranslations(list: string[] | undefined, expected: number): string[] {
  if (!Array.isArray(list) || list.length !== expected) {
    throw new Error(`通道返回的译文段数不符（期望 ${expected}，实际 ${list?.length ?? 0}）`)
  }
  const cleaned = list.map((x) => (typeof x === 'string' ? x.trim() : ''))
  if (cleaned.some((x) => !x)) throw new Error('通道返回了空译文')
  return cleaned
}

// ---------------------------------------------------------------- 腾讯 TranSmart

interface TranSmartResponse {
  header?: { ret_code?: string }
  auto_translation?: string[]
  src_lang?: string
}

class TencentProvider implements TranslateProvider {
  readonly meta: ProviderMeta = {
    id: 'tencent',
    name: '腾讯交互翻译 TranSmart',
    description: '免注册、免 API Key；支持一次请求批量翻译多段，自动识别原文语种，国内响应最快。',
    homepage: 'https://transmart.qq.com/',
    license: '面向公众免费开放的网页翻译服务 · 请低频合理使用',
    builtIn: true,
    maxChars: 480,
    batchSize: 20
  }

  supports(lang: string): boolean {
    return TENCENT_LANGS.has(tencentLang(lang))
  }

  private async call(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    opts: RequestOptions
  ): Promise<TranslateBatch> {
    const body = {
      header: { fn: 'auto_translation', client_key: clientKey(), session: '', user: '' },
      type: 'plain',
      model_category: 'normal',
      text_domain: 'general',
      // 实测：自动检测必须传 null，传 "auto" 会被端点拒绝
      source: { lang: sourceLang === 'auto' ? null : tencentLang(sourceLang), text_list: texts },
      target: { lang: tencentLang(targetLang) }
    }
    const data = await requestJson<TranSmartResponse>(
      'https://transmart.qq.com/api/imt',
      { method: 'POST', body: JSON.stringify(body), contentType: 'application/json' },
      {
        ...opts,
        timeoutMs: opts.timeoutMs ?? 15000,
        headers: { Origin: 'https://transmart.qq.com', Referer: 'https://transmart.qq.com/' }
      }
    )
    if (data.header?.ret_code && data.header.ret_code !== 'succ') {
      throw new Error(`TranSmart：${data.header.ret_code}`)
    }
    return {
      translations: assertTranslations(data.auto_translation, texts.length),
      detected: data.src_lang
    }
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await this.call(['Hello world'], 'auto', 'zh-CN', { signal, timeoutMs: 9000 })
  }

  async translate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal
  ): Promise<TranslateBatch> {
    return this.call(texts, sourceLang, targetLang, { signal })
  }
}

// ---------------------------------------------------------------- 微软 Bing 网页翻译

interface BingAuth {
  ig: string
  iid: string
  key: string
  token: string
  at: number
}

type BingResponse = { translations?: { text?: string }[] }[] | Record<string, unknown>

class BingProvider implements TranslateProvider {
  readonly meta: ProviderMeta = {
    id: 'bing',
    name: '微软 Bing 翻译',
    description: 'Bing 翻译网页版公开通道，译文质量高并附带音译；需从翻译页实时取用页面公开参数。',
    homepage: 'https://www.bing.com/translator',
    license: '面向公众免费开放的网页翻译服务 · 请低频合理使用',
    builtIn: true,
    maxChars: 900,
    batchSize: 6
  }

  private auth?: BingAuth
  /** 解析失败时允许强制刷新一次，避免页面改版后一直用旧参数 */
  private async getAuth(force: boolean, signal?: AbortSignal): Promise<BingAuth> {
    if (!force && this.auth && Date.now() - this.auth.at < 25 * 60 * 1000) return this.auth
    const html = await requestText(
      'https://www.bing.com/translator',
      {},
      { signal, timeoutMs: 12000, maxBytes: 3 * 1024 * 1024 }
    )
    const abuse = html.match(
      /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/
    )
    const ig = html.match(/IG\s*:\s*"([A-Fa-f0-9]+)"/)?.[1]
    const matches = Array.from(html.matchAll(/data-iid\s*=\s*"([^"]+)"/g))
    const iid = matches[matches.length - 1]?.[1]
    if (!ig || !iid || !abuse) throw new Error('Bing 翻译页参数解析失败（页面结构可能已改版）')
    this.auth = { ig, iid, key: abuse[1], token: abuse[2], at: Date.now() }
    return this.auth
  }

  supports(): boolean {
    return true
  }

  private async one(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal, force = false): Promise<string> {
    const auth = await this.getAuth(force, signal)
    const url = `https://cn.bing.com/ttranslatev3?isVertical=1&IG=${auth.ig}&IID=${encodeURIComponent(auth.iid)}`
    const body = formBody({
      fromLang: sourceLang === 'auto' ? 'auto-detect' : bingLang(sourceLang),
      to: bingLang(targetLang),
      text,
      token: auth.token,
      key: auth.key
    })
    // 注意：www.bing.com 的 ttranslatev3 在本机返回 200 空 body，必须走 cn. 域名
    const data = await requestJson<BingResponse>(
      url,
      { method: 'POST', body, contentType: 'application/x-www-form-urlencoded' },
      {
        signal,
        timeoutMs: 12000,
        headers: { Referer: 'https://cn.bing.com/translator', Origin: 'https://cn.bing.com' }
      }
    )
    const translated = Array.isArray(data) ? data[0]?.translations?.[0]?.text : undefined
    if (!translated) {
      if (!force) return this.one(text, sourceLang, targetLang, signal, true)
      throw new Error('Bing 返回空译文')
    }
    return translated.trim()
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const text = await this.one('Hello world', 'auto', 'zh-CN', signal)
    if (!text) throw new Error('Bing 探测返回空译文')
  }

  async translate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal
  ): Promise<TranslateBatch> {
    const translations = await mapLimit(texts, 3, (text) => this.one(text, sourceLang, targetLang, signal))
    return { translations: assertTranslations(translations, texts.length) }
  }
}

// ---------------------------------------------------------------- MyMemory

interface MyMemoryResponse {
  responseData?: { translatedText?: string }
  responseStatus?: number
  responseDetails?: string
  quotaFinished?: boolean
}

class MyMemoryProvider implements TranslateProvider {
  readonly meta: ProviderMeta = {
    id: 'mymemory',
    name: 'MyMemory 翻译记忆',
    description: '国际公共翻译记忆 API，免 API Key；单请求 500 字符上限，匿名额度有限，作为备份通道。',
    homepage: 'https://mymemory.translated.net/',
    license: '免费匿名额度（500 字符/请求）· 超额会被服务端拒绝',
    builtIn: true,
    maxChars: 470,
    batchSize: 4
  }

  supports(): boolean {
    return true
  }

  private async one(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<string> {
    const from = myMemoryLang(sourceLang === 'auto' ? detectSourceLanguage(text) : sourceLang)
    const to = myMemoryLang(targetLang)
    const url =
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
      `&langpair=${encodeURIComponent(`${from}|${to}`)}&mt=1`
    const data = await requestJson<MyMemoryResponse>(url, {}, { signal, timeoutMs: 12000 })
    const details = (data.responseDetails || '').toUpperCase()
    if (data.responseStatus !== 200 || /INVALID|LIMIT EXCEEDED|QUOTA/i.test(details)) {
      throw new Error(`MyMemory：${data.responseDetails || `HTTP ${data.responseStatus}`}`)
    }
    const translated = data.responseData?.translatedText?.trim()
    if (!translated) throw new Error('MyMemory 返回空译文')
    return translated
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await this.one('Hello world', 'en', 'zh-CN', signal)
  }

  async translate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal
  ): Promise<TranslateBatch> {
    // 匿名额度有限：并发 2，批间留一点间隔，避免触发 429
    const translations = await mapLimit(texts, 2, async (text, index) => {
      if (index > 0 && index % 2 === 0) await sleep(120)
      return this.one(text, sourceLang, targetLang, signal)
    })
    return { translations: assertTranslations(translations, texts.length) }
  }
}

// ---------------------------------------------------------------- Google gtx

type GoogleResponse = [Array<[string, ...unknown[]]> | null, unknown, string?] | null

class GoogleProvider implements TranslateProvider {
  readonly meta: ProviderMeta = {
    id: 'google',
    name: 'Google 翻译（gtx）',
    description: '海外网络下可用的公共端点，无需 API Key；国内通常不可达，默认关闭。',
    homepage: 'https://translate.google.com/',
    license: 'Google 面向公众的免费网页翻译端点 · 非官方 API，请低频使用',
    builtIn: true,
    maxChars: 900,
    batchSize: 4
  }

  supports(): boolean {
    return true
  }

  private async one(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<string> {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx` +
      `&sl=${encodeURIComponent(sourceLang === 'auto' ? 'auto' : sourceLang)}` +
      `&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`
    const data = await requestJson<GoogleResponse>(url, {}, { signal, timeoutMs: 8000 })
    const parts = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : []
    const translated = parts.map((row) => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : '')).join('')
    if (!translated.trim()) throw new Error('Google 返回空译文')
    return translated.trim()
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await this.one('Hello world', 'auto', 'zh-CN', signal)
  }

  async translate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal
  ): Promise<TranslateBatch> {
    const translations = await mapLimit(texts, 3, (text) => this.one(text, sourceLang, targetLang, signal))
    return { translations: assertTranslations(translations, texts.length) }
  }
}

// ---------------------------------------------------------------- 自建 LibreTranslate

interface LibreResponse {
  translatedText?: string | string[]
}

class LibreProvider implements TranslateProvider {
  readonly meta: ProviderMeta = {
    id: 'libre',
    name: '自建 LibreTranslate',
    description: '填写自己部署或信任的 LibreTranslate 兼容端点；未配置地址时不参与翻译。',
    homepage: 'https://github.com/LibreTranslate/LibreTranslate',
    license: '自建/第三方实例 · 由用户自行确认服务条款与额度',
    builtIn: false,
    maxChars: 1500,
    batchSize: 8
  }

  private endpoint = ''

  supports(): boolean {
    return true
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint.trim().replace(/\/+$/, '')
  }

  private get url(): string {
    if (!this.endpoint) throw new Error('未配置 LibreTranslate 端点')
    if (!/^https?:\/\//i.test(this.endpoint)) throw new Error('端点必须以 http(s):// 开头')
    return this.endpoint.endsWith('/translate') ? this.endpoint : `${this.endpoint}/translate`
  }

  private async call(texts: string[], sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<TranslateBatch> {
    const body = {
      q: texts.length === 1 ? texts[0] : texts,
      source: sourceLang === 'auto' ? detectSourceLanguage(texts[0] || '') : sourceLang,
      target: targetLang,
      format: 'text',
      api_key: ''
    }
    const data = await requestJson<LibreResponse>(
      this.url,
      { method: 'POST', body: JSON.stringify(body), contentType: 'application/json' },
      { signal, timeoutMs: 15000 }
    )
    const list = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText || '']
    return { translations: assertTranslations(list, texts.length) }
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await this.call(['Hello world'], 'auto', 'zh-CN', signal)
  }

  async translate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal
  ): Promise<TranslateBatch> {
    return this.call(texts, sourceLang, targetLang, signal)
  }
}

// ---------------------------------------------------------------- 注册表

export const BUILT_IN_PROVIDERS: TranslateProvider[] = [
  new TencentProvider(),
  new BingProvider(),
  new MyMemoryProvider(),
  new GoogleProvider(),
  new LibreProvider()
]

export const DEFAULT_DISABLED_PROVIDERS: TranslationProviderId[] = ['google']

export function providerInfo(
  provider: TranslateProvider,
  enabled: boolean,
  health?: { healthy: boolean; latencyMs: number; lastError?: string }
): TranslationProviderInfo {
  return {
    ...provider.meta,
    enabled,
    healthy: health?.healthy,
    latencyMs: health?.latencyMs,
    lastError: health?.lastError
  }
}

/** 把底层错误统一成「可读原因 + 是否可重试」；服务层据此决定是否换通道 */
export function providerError(error: unknown): string {
  if (error instanceof TranslateHttpError) {
    if (error.status === 429) return '触发频率限制（429）'
    if (error.status >= 500) return `服务端错误（${error.status}）`
  }
  if (error instanceof Error) return error.message
  return String(error)
}
