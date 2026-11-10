/**
 * 跨 contextBridge 的入参必须是可结构化克隆的纯值。
 *
 * Vue 的 ref([]).value / reactive({}) 是 Proxy，Electron 在进入 preload 之前就会
 * 尝试克隆参数并抛 "An object could not be cloned"（全文搜索的 tagIds 就踩了这个坑）。
 * 因此所有 IPC 参数在渲染层先递归展开成普通对象；ArrayBuffer / TypedArray / Date /
 * File / Blob 等本来就可克隆的类型原样保留，避免误伤二进制与拖拽导入。
 *
 * 单独成模块：不依赖 window / Electron，可在纯 Node 中直接做回归测试。
 */
export function toPlain<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || typeof value !== 'object') return value
  if (
    value instanceof Date ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof File !== 'undefined' && value instanceof File)
  ) {
    return value
  }
  const cached = seen.get(value)
  if (cached !== undefined) return cached as T
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(toPlain(item, seen))
    return out as T
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>()
    seen.set(value, out)
    for (const [k, v] of value) out.set(toPlain(k, seen), toPlain(v, seen))
    return out as T
  }
  if (value instanceof Set) {
    const out = new Set<unknown>()
    seen.set(value, out)
    for (const item of value) out.add(toPlain(item, seen))
    return out as T
  }
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value)) {
    // 函数 / Symbol 不可克隆，契约里也不允许，直接丢弃而不是让整次调用失败
    if (typeof item === 'function' || typeof item === 'symbol') continue
    out[key] = toPlain(item, seen)
  }
  return out as T
}
