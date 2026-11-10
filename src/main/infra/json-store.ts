import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 原子 JSON 存储：
 * 1) 内存中只保留一份快照，所有写操作串行排队，避免并发覆盖；
 * 2) 先写同目录 .tmp，再 rename，杜绝断电/崩溃导致半截 JSON；
 * 3) 文件损坏时回退到初始值并重建，不让整个应用起不来。
 */
export class AtomicJsonStore<T extends object> {
  private queue: Promise<unknown> = Promise.resolve()
  private cache?: T

  constructor(
    private readonly filePath: string,
    private readonly fallback: () => T
  ) {}

  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.cache = JSON.parse(raw) as T
    } catch {
      this.cache = this.fallback()
      await this.flush(this.cache)
    }
    return this.cache as T
  }

  /** 读-改-写的唯一入口，返回内部快照引用（调用方不要长期持有） */
  async mutate<R>(fn: (draft: T) => R | Promise<R>): Promise<{ result: R; data: T }> {
    const run = this.queue.then(async () => {
      const draft = await this.read()
      const result = await fn(draft)
      await this.flush(draft)
      return { result, data: draft }
    })
    // 队列不因单次失败而中断
    this.queue = run.catch(() => undefined)
    return run
  }

  async replace(data: T): Promise<void> {
    this.cache = data
    await this.flush(data)
  }

  async flush(data: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(data), 'utf8')
    await rename(tmp, this.filePath)
  }
}
