/**
 * 对照翻译共用的 HTTP 层。
 *
 * 所有翻译请求都在主进程发起（渲染层 CSP 不放行外部 connect-src），
 * 统一处理：超时、取消、User-Agent、响应体上限、可重试错误与友好错误信息。
 * 与在线取书分开，是因为翻译是高频短请求，且各通道需要 form / JSON 两种编码。
 */

export const TRANSLATE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0 ShuLie/1.0 EPUB-Reader'

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
  headers?: Record<string, string>
  maxBytes?: number
}

export class TranslateHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string
  ) {
    super(message)
    this.name = 'TranslateHttpError'
  }
}

function combinedSignal(opts: RequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 12000)
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
}

/** 把底层网络错误翻译成用户能看懂的中文；上游适配器只管抛 */
export function friendlyError(error: unknown): string {
  if (error instanceof Error) {
    const name = (error as { name?: string }).name
    if (name === 'AbortError') return '已取消'
    if (name === 'TimeoutError') return '连接超时'
    const code = (error as { cause?: { code?: string } }).cause?.code
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败'
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时（该通道在当前网络不可达）'
    if (code === 'ECONNRESET') return '连接被重置'
    return error.message
  }
  return String(error)
}

export async function requestText(
  url: string,
  init: { method?: string; body?: string; contentType?: string } = {},
  opts: RequestOptions = {}
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  const res = await fetch(url, {
    method: init.method || 'GET',
    body: init.body,
    signal: combinedSignal(opts),
    redirect: 'follow',
    headers: {
      'User-Agent': TRANSLATE_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
      ...(opts.headers || {})
    }
  })
  if (!res.ok) throw new TranslateHttpError(`HTTP ${res.status}`, res.status, url)
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
        throw new TranslateHttpError('翻译响应过大，已中止', 413, url)
      }
      chunks.push(value)
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer())
    chunks.push(buf)
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const chunk of chunks) {
    merged.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

export async function requestJson<T>(
  url: string,
  init: { method?: string; body?: string; contentType?: string } = {},
  opts: RequestOptions = {}
): Promise<T> {
  const text = await requestText(url, init, opts)
  if (!text.trim()) throw new TranslateHttpError('通道返回空响应', 502, url)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new TranslateHttpError(`通道返回了非 JSON 内容：${text.slice(0, 60)}`, 502, url)
  }
}

export function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString()
}
