/**
 * 在线取书共用的 HTTP 层。
 *
 * 所有联网请求都在主进程发起（渲染层 CSP 不放行外部 connect-src），
 * 统一处理：超时、外部取消、User-Agent、响应体大小上限、下载进度、有限重试。
 * 单个书源失败绝不影响其他书源。
 */

/**
 * 保留 ShuLie 标识，但使用浏览器风格的 UA 前缀。
 * 实测 www.gutenberg.org 对纯自定义 UA 的 EPUB / 封面请求会挂起直到超时，
 * 带浏览器前缀则正常返回；请求频率仍由 30 分钟榜单缓存与 5 分钟查询缓存控制。
 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ShuLie/1.0 EPUB-Reader'
/** 单本 EPUB 的下载上限，防止误粘贴大文件 / 无限流把内存打爆 */
export const MAX_EPUB_BYTES = 80 * 1024 * 1024

export interface FetchOptions {
  timeoutMs?: number
  signal?: AbortSignal
  headers?: Record<string, string>
  maxBytes?: number
  retries?: number
  onProgress?: (received: number, total: number) => void
}

export interface BufferResult {
  data: Uint8Array
  contentType: string
  finalUrl: string
  contentLength: number
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function combineSignal(opts: FetchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 12000)
  // AbortSignal.any 在 Node 20+ / Chromium 均可用；显式判空兼容旧运行时
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500 || error.status === 429
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError' || error instanceof TypeError
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function getBuffer(url: string, opts: FetchOptions = {}): Promise<BufferResult> {
  const maxBytes = opts.maxBytes ?? MAX_EPUB_BYTES
  const retries = opts.retries ?? 0
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: combineSignal(opts),
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(opts.headers || {})
        }
      })
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, url)
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > maxBytes) {
        throw new HttpError(`文件过大（${Math.round(declared / 1048576)} MB），已跳过`, 413, url)
      }

      const chunks: Uint8Array[] = []
      let received = 0
      if (res.body) {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new HttpError('文件超过大小上限，已中止下载', 413, url)
          }
          chunks.push(value)
          opts.onProgress?.(received, declared || 0)
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer())
        received = buf.byteLength
        if (received > maxBytes) throw new HttpError('文件超过大小上限', 413, url)
        chunks.push(buf)
        opts.onProgress?.(received, declared || received)
      }
      const data = new Uint8Array(received)
      let at = 0
      for (const chunk of chunks) {
        data.set(chunk, at)
        at += chunk.byteLength
      }
      return {
        data,
        contentType: res.headers.get('content-type') || '',
        finalUrl: res.url || url,
        contentLength: declared || received
      }
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryable(error) || opts.signal?.aborted) break
      await sleep(250 * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function getText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await getBuffer(url, opts)
  return new TextDecoder('utf-8').decode(res.data)
}

export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await getText(url, opts)
  return JSON.parse(text) as T
}

/** HTML 实体 / 标签清理，用于从目录页里抠出书名与作者 */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ' '
  }
}

export function absoluteUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}
