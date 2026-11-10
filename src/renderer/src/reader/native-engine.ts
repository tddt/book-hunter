import { READER_THEMES } from '@shared/constants'
import type { ReaderLocator, ReaderSettings, TocItem } from '@shared/types'
import { loadReaderDocument, type ReaderDocument } from './document'
import {
  decodeLocator,
  encodeLocator,
  type EngineHooks,
  type EngineOptions,
  type IReaderEngine,
  type TranslationMode,
  type TranslationRow
} from './engine'

/**
 * 自研排版引擎（不依赖 epub.js）。
 *
 * 分页原理：把章节 HTML 放进固定高度的多列容器（column-fill:auto），
 * 浏览器按 column-width 把内容自动切成一页一「列」，用 translateX 切页。
 * 版心宽度、页边距、列间距全部由本引擎计算，不会出现 epub.js 那种
 * 注入 padding 后双页文字被裁断的问题。
 *
 * 进度：按章节字数加权，page/pages 给出章内比例，合成为真实全书百分比；
 * 不需要 epub.js locations 那种耗时预生成。
 */
interface Metrics {
  colW: number
  pad: number
  gap: number
  stride: number
  sheetW: number
  spreadCount: number
  vpad: number
}

interface Annotation {
  chapterIndex: number
  start: number
  end: number
  color: string
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const el = (tag: string, cls: string): HTMLDivElement => {
  const node = document.createElement(tag) as HTMLDivElement
  node.className = cls
  return node
}

export class NativeReaderEngine implements IReaderEngine {
  private root!: HTMLElement
  private stage!: HTMLDivElement
  private sheet!: HTMLDivElement
  private flow!: HTMLDivElement
  private article!: HTMLElement
  private zonePrev!: HTMLDivElement
  private zoneNext!: HTMLDivElement

  private doc: ReaderDocument | null = null
  private settings!: ReaderSettings
  private hooks!: EngineHooks
  private ready = false

  private chapterIndex = 0
  private page = 0
  private pages = 1
  private weights: number[] = []
  private before: number[] = [0]
  private totalChars = 1
  private metrics: Metrics = { colW: 640, pad: 36, gap: 96, stride: 736, sheetW: 712, spreadCount: 1, vpad: 28 }
  /** 实测的每列起点（相对 flow 左边缘），用于精确对齐，避免步长累积误差 */
  private columnOffsets: { k: number; left: number }[] = []
  private maxRight = 0
  private lastSize = { w: 0, h: 0 }

  private annotations = new Map<string, Annotation>()
  private findTerm = ''
  /** 正文内嵌对照译文（2.1）：不参与任何基于字符偏移的定位计算 */
  private translations: TranslationRow[] = []
  private translationMode: TranslationMode = 'bilingual'
  private translationChapter = -1
  private primaryLabel = '译文'
  private secondaryLabel = ''
  private wheelLock = false
  private layoutTimer = 0
  private disposers: Array<() => void> = []

  async init(options: EngineOptions): Promise<void> {
    this.root = options.container
    this.settings = options.settings
    this.hooks = options.hooks
    this.buildDom()
    this.applyCssVars()
    this.bindEvents()

    this.doc = await loadReaderDocument(options.buffer)
    this.weights = this.doc.chapters.map((c) => Math.max(1, c.text.length))
    this.before = [0]
    for (const w of this.weights) this.before.push(this.before[this.before.length - 1] + w)
    this.totalChars = Math.max(1, this.before[this.before.length - 1])

    if (options.initial) {
      await this.renderChapter(options.initial.chapterIndex, options.initial.percent, options.initial.page)
    } else if (options.fallbackPercentage > 0) {
      await this.goTo(options.fallbackPercentage)
    } else {
      await this.renderChapter(0, 0, 0)
    }
    this.ready = true
    // 首屏容器尺寸 / Web 字体可能尚未稳定，稳定后按当前阅读位置再精排一次
    requestAnimationFrame(() => {
      if (this.ready) this.layout(true)
    })
    void document.fonts?.ready.then(() => {
      if (this.ready) this.layout(true)
    })
  }

  // ---------------------------------------------------------------- DOM

  private buildDom(): void {
    this.root.innerHTML = ''
    this.root.classList.add('nr-root')
    this.stage = el('div', 'nr-stage')
    this.zonePrev = el('div', 'nr-zone nr-prev')
    this.zoneNext = el('div', 'nr-zone nr-next')
    this.zonePrev.title = '上一页'
    this.zoneNext.title = '下一页'
    this.sheet = el('div', 'nr-sheet')
    this.flow = el('div', 'nr-flow')
    this.article = document.createElement('article')
    this.article.className = 'nr-article'
    this.flow.appendChild(this.article)
    this.sheet.appendChild(this.flow)
    this.stage.append(this.zonePrev, this.sheet, this.zoneNext)
    this.root.appendChild(this.stage)
  }

  private applyCssVars(): void {
    const s = this.settings
    const theme = READER_THEMES.find((t) => t.id === s.theme) || READER_THEMES[0]
    const r = this.root
    r.dataset.theme = s.theme
    r.style.setProperty('--nr-bg', theme.bg)
    r.style.setProperty('--nr-fg', theme.fg)
    r.style.setProperty('--nr-muted', theme.muted)
    r.style.setProperty('--nr-link', theme.link)
    r.style.setProperty('--nr-font', s.fontFamily)
    r.style.setProperty('--nr-font-size', `${s.fontSize}px`)
    r.style.setProperty('--nr-line-height', String(s.lineHeight))
    r.style.setProperty('--nr-para', `${s.paragraphSpacing}em`)
    r.classList.toggle('nr-indent', s.textIndent)
    r.classList.toggle('nr-justify', s.justify)
    r.classList.toggle('nr-scrolled', s.pageMode === 'scrolled')
    r.dataset.animation = s.animation
  }

  private bindEvents(): void {
    const onWheel = (event: WheelEvent): void => {
      if (this.settings.pageMode === 'scrolled') return
      event.preventDefault()
      if (this.wheelLock || Math.abs(event.deltaY) < 4) return
      this.wheelLock = true
      window.setTimeout(() => (this.wheelLock = false), 320)
      if (event.deltaY > 0) void this.next()
      else void this.prev()
    }
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const link = target.closest('.nr-internal') as HTMLElement | null
      if (link) {
        event.preventDefault()
        void this.goToChapter(Number(link.dataset.chapter || 0), link.dataset.anchor)
        return
      }
      if (target.closest('.nr-prev')) void this.prev()
      else if (target.closest('.nr-next')) void this.next()
    }
    const onSelectEnd = (event: Event): void => {
      // 监听 document：在正文起选、松手落在版心外时也能拿到选区。
      // 只有落在阅读区内才允许「清空工具条」，否则点击划词工具条按钮时
      // 选区已被 mousedown 清掉，会把工具条连带移除，导致按钮点不中。
      const target = event.target as Node | null
      const inStage = !!target && (target === this.root || this.root.contains(target))
      window.setTimeout(() => this.captureSelection(inStage), 0)
    }
    const onScroll = (): void => {
      if (this.settings.pageMode === 'scrolled' && this.ready) this.emitRelocated()
    }
    const onKey = (event: KeyboardEvent): void => this.hooks.onKey?.(event.key)

    this.root.addEventListener('wheel', onWheel, { passive: false })
    this.root.addEventListener('click', onClick)
    document.addEventListener('mouseup', onSelectEnd)
    document.addEventListener('keyup', onSelectEnd)
    this.flow.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)

    this.disposers.push(
      () => this.root.removeEventListener('wheel', onWheel),
      () => this.root.removeEventListener('click', onClick),
      () => document.removeEventListener('mouseup', onSelectEnd),
      () => document.removeEventListener('keyup', onSelectEnd),
      () => this.flow.removeEventListener('scroll', onScroll),
      () => window.removeEventListener('keydown', onKey)
    )
  }

  // ---------------------------------------------------------------- 布局

  /**
   * 版心几何求解。
   *
   * 恒等式：sheetW = n*colW + 2*n*pad + (n-1)*gutter，其中 n = spreadCount。
   * 只要 colW 由「可用宽度」反算得出（而不是取固定下限），sheetW 就一定 ≤ 视口宽度，
   * 不存在版心撑破可视区的可能。空间不足时优先收缩页边距，其次才收窄列宽。
   */
  private fitGeometry(W: number): Omit<Metrics, 'vpad'> {
    const s = this.settings
    const scrolled = s.pageMode === 'scrolled'
    let spreadCount = !scrolled && s.spread === 'auto' && W >= 1320 ? 2 : 1
    const sideMargin = clamp(W * 0.035, 12, 72)
    const maxSheet = Math.max(200, W - sideMargin * 2)
    let pad = clamp(s.pageMargin, 12, 96)

    const calc = (p: number, count: number): Omit<Metrics, 'vpad'> => {
      const gutter = clamp(Math.round(p * 0.66), 12, 28)
      const gap = 2 * p + gutter
      const avail = Math.floor((maxSheet - 2 * count * p - (count - 1) * gutter) / count)
      const colW = Math.min(s.lineWidth, avail)
      const sheetW = count * colW + 2 * count * p + (count - 1) * gutter
      return { colW, pad: p, gap, stride: colW + gap, sheetW, spreadCount: count }
    }

    let g = calc(pad, spreadCount)
    // 宽度不够撑起两页时自动退回单页，避免窄双页
    if (spreadCount === 2 && g.colW < 380) {
      spreadCount = 1
      g = calc(pad, 1)
    }
    while (g.colW < 300 && pad > 12) {
      pad = Math.max(12, pad - 4)
      g = calc(pad, spreadCount)
    }
    if (g.colW < 160) g = calc(12, 1)
    if (g.sheetW > W) {
      const cut = Math.ceil((g.sheetW - W) / g.spreadCount)
      const colW = Math.max(120, g.colW - cut)
      g = { ...g, colW, stride: colW + g.gap, sheetW: g.sheetW - (g.colW - colW) * g.spreadCount }
    }
    return g
  }

  /**
   * 重算版心与列数；keep=true 时按章内比例恢复到同一阅读位置。
   * apply=false 供跨章渲染使用：只测量、不落位，由调用方在「无过渡」状态下统一收尾，
   * 避免把「上一章末尾的大负位移 → 0」当成一次翻页动画播放。
   */
  private layout(keep: boolean, presetRatio?: number | null, apply = true): void {
    if (!this.doc) return
    const W = this.root.clientWidth
    const H = this.root.clientHeight
    if (!W || !H) return
    const s = this.settings
    const scrolled = s.pageMode === 'scrolled'
    // presetRatio 供 applySettings 在「切换模式前」抓取旧模式的比例
    const ratio = keep ? (presetRatio ?? this.chapterPercent()) : null

    const geom = this.fitGeometry(W)
    const vpad = clamp(H * 0.045, 12, 46)
    const { colW, pad, gap, stride, sheetW, spreadCount } = geom
    this.metrics = { ...geom, vpad }
    this.lastSize = { w: W, h: H }

    this.stage.style.setProperty('--nr-vpad', `${vpad}px`)
    this.sheet.style.width = `${sheetW}px`
    const zoneW = Math.max(0, (W - sheetW) / 2)
    this.zonePrev.style.width = `${zoneW}px`
    this.zoneNext.style.width = `${zoneW}px`

    const f = this.flow.style
    // 重排期间禁用过渡，避免测量拿到动画中间态
    f.transition = 'none'
    f.height = '100%'
    f.boxSizing = 'border-box'
    f.paddingLeft = `${pad}px`

    if (scrolled) {
      f.width = '100%'
      f.paddingRight = `${pad}px`
      // 滚动模式必须是普通块流：column-count:1 + column-fill:auto 会让填满的内容
      // 横向生成「溢出列」而不是纵向滚动，造成内容跑到可视区之外。
      f.columnWidth = 'auto'
      f.columnCount = 'auto'
      f.columnGap = 'normal'
      f.columnFill = 'balance'
      f.overflowY = 'auto'
      f.overflowX = 'hidden'
      f.transform = 'none'
      this.article.style.maxWidth = `${colW}px`
      this.article.style.margin = '0 auto'
      this.columnOffsets = []
      this.maxRight = 0
    } else {
      /*
       * 关键：column-width 只是建议值，浏览器会把列宽拉伸填满容器。
       * 令 contentW = N*stride - gap，浏览器算出列数 N 后，
       * 「实际列宽」= (contentW - (N-1)*gap)/N = colW，恰好不被拉伸，
       * 于是实际列步长严格等于 stride。内容超出 N 列时生成的溢出列沿用同一列宽。
       */
      // 内嵌译文会让正文显著变长：列数上限必须按「实际 DOM 文本量」估算，
      // 否则 contentW 不够，溢出列超出 flow 宽度后翻不到后面的页。
      const chapterLen = Math.max(
        this.doc.chapters[this.chapterIndex]?.text.length || 0,
        this.article.textContent?.length || 0,
        1200
      )
      const flowH = Math.max(120, H - 2 * vpad)
      const charsPerLine = Math.max(10, colW / (s.fontSize * 0.95))
      const linesPerPage = Math.max(5, flowH / (s.fontSize * s.lineHeight))
      const estimate = Math.ceil(chapterLen / (charsPerLine * linesPerPage)) + spreadCount + 2
      const N = clamp(estimate, 2, 64)
      const contentW = N * stride - gap
      f.width = `${contentW + pad}px` // border-box：content + padding-left
      f.paddingRight = '0px'
      f.columnWidth = `${colW}px`
      f.columnCount = 'auto'
      f.columnGap = `${gap}px`
      f.columnFill = 'auto'
      f.overflowY = 'visible'
      f.overflowX = 'visible'
      this.article.style.maxWidth = 'none'
      this.article.style.margin = '0'
    }

    // 强制同步 reflow 后再测量列位置
    void this.flow.offsetWidth
    if (scrolled) {
      this.pages = 0
    } else {
      this.scanColumns()
      this.pages = this.measurePages()
    }

    if (keep && ratio !== null) {
      if (scrolled) {
        const max = this.flow.scrollHeight - this.flow.clientHeight
        this.flow.scrollTop = ratio * Math.max(0, max)
      } else {
        const raw = Math.round(ratio * Math.max(0, this.pages - 1))
        this.page = spreadCount * Math.floor(raw / spreadCount)
      }
    } else if (!scrolled) {
      this.page = spreadCount * Math.floor(clamp(this.page, 0, Math.max(0, this.pages - 1)) / spreadCount)
    }
    void this.flow.offsetWidth
    if (apply) {
      // 顺序是修复「切章反向滑动」的关键：先在无过渡状态下把 transform 落到
      // 最终位置并强制提交，再恢复 CSS 过渡。若先恢复过渡再改 transform，
      // 浏览器会把「上一章末尾的大负位移 → 新章 0」播放成一次向右的倒滑。
      this.applyPosition()
      void this.flow.offsetWidth
      f.transition = ''
    }
    if (keep) this.emitRelocated()
  }

  /**
   * 实测所有列的起点。用 Range 取每行文本的 rect，按理论步长分桶，
   * 每桶最左值即该列起点；再用相邻列的实测间距校正 stride（吸收亚像素取整）。
   * 所有坐标都取「相对 flow 左边缘」的偏移，因此不受当前 translateX 影响。
   */
  private scanColumns(): void {
    const flowLeft = this.flow.getBoundingClientRect().left
    const { pad, stride, colW } = this.metrics
    const points: number[] = []
    let maxRight = pad + colW
    // article 自身的 rect 可能是跨列的合并盒，只用来补列起点，不参与右边界推算
    const collect = (rects: DOMRectList | DOMRect[], withRight: boolean): void => {
      for (const r of Array.from(rects)) {
        if (r.width <= 0.5) continue
        points.push(r.left - flowLeft)
        if (withRight && r.right - flowLeft > maxRight) maxRight = r.right - flowLeft
      }
    }
    collect(this.article.getClientRects(), false)
    const range = document.createRange()
    range.selectNodeContents(this.article)
    collect(range.getClientRects(), true)
    range.detach?.()

    const buckets = new Map<number, number>()
    for (const x of points) {
      // floor 而非 round：列内靠右的文本行不能被误判成下一列（否则 pages 恒多 1）
      const k = Math.floor((x - pad + 4) / stride)
      if (k < 0 || k > 4000) continue
      const old = buckets.get(k)
      if (old === undefined || x < old) buckets.set(k, x)
    }
    this.columnOffsets = Array.from(buckets.keys())
      .sort((a, b) => a - b)
      .map((k) => ({ k, left: buckets.get(k) as number }))
    // 只做「 pages 」测量，不据此改写 stride：几何求解已保证步长精确，
    // 用带噪的文本 rect 反推步长反而会让翻页位置漂移。
    void colW
    this.maxRight = maxRight
  }

  /** 列数取「实测最大列号」与「内容最右边缘推算」的较大值 */
  private measurePages(): number {
    const { pad, stride, colW } = this.metrics
    const last = this.columnOffsets[this.columnOffsets.length - 1]
    const byOffsets = last ? last.k + 1 : 0
    // 内容右边缘最多到「最后一列起点 + colW」。用 floor 保守推算，
    // 跨列合并盒带来的 < stride 污染不会把页数推高、制造空白末页。
    const byRight = Math.max(1, Math.floor((this.maxRight - pad - colW + 1) / stride) + 1)
    return clamp(Math.max(byOffsets, byRight, 1), 1, 4000)
  }

  /** 第 k 列的理论起点；纯几何驱动，不依赖文本 rect，避免插图页/居中标题干扰 */
  private columnLeft(k: number): number {
    return this.metrics.pad + k * this.metrics.stride
  }

  private applyPosition(): void {
    const { spreadCount, stride } = this.metrics
    if (this.settings.pageMode === 'scrolled') return
    const group = Math.floor(this.page / spreadCount)
    // contentW 已保证 used column width === colW，故步长严格为 stride，
    // 直接用 group*spreadCount*stride 平移，任何一页都不会产生累积误差。
    this.flow.style.transform = `translateX(${-group * spreadCount * stride}px)`
    if (this.settings.animation === 'fade') {
      this.flow.classList.remove('nr-fade')
      void this.flow.offsetWidth
      this.flow.classList.add('nr-fade')
    }
  }

  private chapterPercent(): number {
    if (this.settings.pageMode === 'scrolled') {
      const max = this.flow.scrollHeight - this.flow.clientHeight
      return max > 0 ? clamp(this.flow.scrollTop / max, 0, 1) : 1
    }
    return this.pages > 1 ? clamp(this.page / (this.pages - 1), 0, 1) : 1
  }

  private emitRelocated(): void {
    if (!this.doc) return
    const chapter = this.doc.chapters[this.chapterIndex]
    const chapterPercent = this.chapterPercent()
    const percentage = clamp(
      (this.before[this.chapterIndex] + chapterPercent * this.weights[this.chapterIndex]) / this.totalChars,
      0,
      1
    )
    const locator: ReaderLocator = {
      chapterIndex: this.chapterIndex,
      page: this.page,
      percent: chapterPercent
    }
    this.hooks.onRelocated({
      cfi: encodeLocator(locator),
      locator,
      percentage,
      chapterIndex: this.chapterIndex,
      chapterTitle: chapter?.title || `第 ${this.chapterIndex + 1} 节`,
      page: this.page,
      pages: this.pages,
      chapterPercent
    })
  }

  // ---------------------------------------------------------------- 章节 / 导航

  private async renderChapter(
    index: number,
    percent: number,
    fixedPage?: number,
    direction = 0
  ): Promise<void> {
    if (!this.doc) return
    const safe = clamp(Math.round(index), 0, this.doc.chapters.length - 1)
    const f = this.flow.style
    // 跨章前先把 flow 归零并强制提交：新章节永远从第 0 列开始，绝不沿用
    // 上一章末尾的 translateX；整个渲染期间保持无过渡，杜绝反向位移被动画化。
    f.transition = 'none'
    f.transform = 'translateX(0px)'
    void this.flow.offsetWidth

    this.chapterIndex = safe
    this.article.innerHTML = this.doc.chapters[safe].html
    // 译文必须在 layout 之前注入：分页几何要按「含译文」的真实内容测量，
    // 否则会出现译文被裁在可视区外、或翻页页数不对。
    this.injectTranslations()
    this.applyAnnotations()
    this.applyFindTerm()
    this.bindImageLoads()

    // 只测量、不落位：page 要等本章页数算出来后才能确定
    this.layout(false, null, false)
    if (this.settings.pageMode === 'scrolled') {
      this.flow.scrollTop = 0
      const max = this.flow.scrollHeight - this.flow.clientHeight
      if (max > 0) this.flow.scrollTop = clamp(percent, 0, 1) * max
    } else {
      const target = fixedPage !== undefined ? fixedPage : Math.round(clamp(percent, 0, 1) * (this.pages - 1))
      const { spreadCount } = this.metrics
      this.page = spreadCount * Math.floor(clamp(target, 0, Math.max(0, this.pages - 1)) / spreadCount)
    }
    this.applyPosition()
    void this.flow.offsetWidth
    f.transition = ''
    this.emitRelocated()
    this.hooks.onRendered?.(safe)
    // 用版心容器做一次「方向正确」的短距离入场，补回切章的翻页手感：
    // next 从右侧滑入（内容左移），prev 从左侧滑入（内容右移），与页内翻页一致。
    if (direction !== 0 && this.settings.animation !== 'none') this.playChapterEnter(direction)
  }

  private playChapterEnter(direction: number): void {
    if (typeof this.sheet.animate !== 'function') return
    const offset = direction > 0 ? 26 : -26
    try {
      this.sheet.animate(
        [
          { transform: `translateX(calc(-50% + ${offset}px))`, opacity: 0.45 },
          { transform: 'translateX(-50%)', opacity: 1 }
        ],
        { duration: 220, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' }
      )
    } catch {
      /* 浏览器不支持 WAAPI 时静默跳过，不影响阅读 */
    }
  }

  private bindImageLoads(): void {
    for (const img of Array.from(this.article.querySelectorAll('img'))) {
      if (img.complete) continue
      img.addEventListener('load', () => this.scheduleRelayout(), { once: true })
      img.addEventListener('error', () => this.scheduleRelayout(), { once: true })
    }
  }

  private scheduleRelayout(): void {
    if (this.layoutTimer) return
    this.layoutTimer = window.setTimeout(() => {
      this.layoutTimer = 0
      if (this.ready) this.layout(true)
    }, 120)
  }

  async display(locator: ReaderLocator | null): Promise<void> {
    if (!locator) return
    await this.renderChapter(locator.chapterIndex, locator.percent, locator.page)
  }

  async next(): Promise<void> {
    if (!this.doc) return
    if (this.settings.pageMode === 'scrolled') {
      const max = this.flow.scrollHeight - this.flow.clientHeight
      if (this.flow.scrollTop < max - 4) {
        this.flow.scrollBy({ top: this.flow.clientHeight * 0.86, behavior: 'smooth' })
        return
      }
    } else {
      const step = this.metrics.spreadCount
      if (this.page + step < this.pages) {
        this.page += step
        this.applyPosition()
        this.emitRelocated()
        return
      }
    }
    if (this.chapterIndex + 1 < this.doc.chapters.length) {
      await this.renderChapter(this.chapterIndex + 1, 0, 0, 1)
    }
  }

  async prev(): Promise<void> {
    if (!this.doc) return
    if (this.settings.pageMode === 'scrolled') {
      if (this.flow.scrollTop > 4) {
        this.flow.scrollBy({ top: -this.flow.clientHeight * 0.86, behavior: 'smooth' })
        return
      }
    } else {
      const step = this.metrics.spreadCount
      if (this.page - step >= 0) {
        this.page -= step
        this.applyPosition()
        this.emitRelocated()
        return
      }
    }
    if (this.chapterIndex > 0) {
      // 回到上一章末页
      await this.renderChapter(this.chapterIndex - 1, 1, undefined, -1)
    }
  }

  async goTo(percentage: number): Promise<void> {
    if (!this.doc) return
    const target = clamp(percentage, 0, 1) * this.totalChars
    let index = 0
    while (index < this.weights.length - 1 && this.before[index + 1] < target) index += 1
    const ratio = clamp((target - this.before[index]) / this.weights[index], 0, 1)
    await this.renderChapter(index, ratio)
  }

  async goToChapter(index: number, anchor?: string): Promise<void> {
    if (!this.doc) return
    await this.renderChapter(index, 0, 0)
    if (anchor) this.jumpToAnchor(anchor)
  }

  /** 由「相对 flow 左边缘的 x 坐标」反推应显示的页序（已按双页对齐） */
  private pageAtLeft(left: number): number {
    const { spreadCount } = this.metrics
    const lastK = this.columnOffsets.length ? this.columnOffsets[this.columnOffsets.length - 1].k + 1 : 0
    const count = Math.max(this.pages, lastK, 1)
    let column = 0
    for (let k = 0; k < count; k += 1) {
      if (this.columnLeft(k) <= left + 1) column = k
      else break
    }
    return spreadCount * Math.floor(column / spreadCount)
  }

  private jumpToAnchor(anchor: string): void {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(anchor) : anchor
    const target =
      this.article.querySelector(`#${escaped}`) ||
      this.article.querySelector(`[name="${escaped}"]`) ||
      this.article.querySelector(`[id="${escaped}"]`)
    if (!target) return
    if (this.settings.pageMode === 'scrolled') {
      target.scrollIntoView({ block: 'start' })
      return
    }
    const flowLeft = this.flow.getBoundingClientRect().left
    const left = target.getBoundingClientRect().left - flowLeft
    this.page = this.pageAtLeft(left)
    this.applyPosition()
    this.emitRelocated()
  }

  /**
   * 全文搜索命中跳转：切到目标章节 → 高亮关键词 → 翻到命中所在的那一页。
   * 只跳到章节开头等于没搜到，这里必须按命中位置定位。
   */
  async goToMatch(chapterIndex: number, offset: number, term: string): Promise<void> {
    if (!this.doc) return
    await this.renderChapter(chapterIndex, 0, 0)
    this.highlightTerm(term)
    const marks = Array.from(this.article.querySelectorAll('mark.nr-find')) as HTMLElement[]
    let target: HTMLElement | undefined = marks[0]
    // 一章内多处命中时，选与搜索结果字符偏移最接近的那一处
    if (offset >= 0 && marks.length > 1) {
      let best = Number.POSITIVE_INFINITY
      for (const mark of marks) {
        const node = mark.firstChild
        if (!node) continue
        const delta = Math.abs(this.textOffsetOf(node, 0) - offset)
        if (delta < best) {
          best = delta
          target = mark
        }
      }
    }
    if (!target) return
    if (this.settings.pageMode === 'scrolled') {
      const flowRect = this.flow.getBoundingClientRect()
      this.flow.scrollTop +=
        target.getBoundingClientRect().top - flowRect.top - this.flow.clientHeight * 0.28
    } else {
      const flowLeft = this.flow.getBoundingClientRect().left
      this.page = this.pageAtLeft(target.getBoundingClientRect().left - flowLeft)
      this.applyPosition()
      this.emitRelocated()
    }
  }

  /**
   * 对照翻译「点击段落 → 回到原文」：按章内字符偏移定位到所在页。
   * 用 Range.getBoundingClientRect() 取坐标，不插入任何 DOM 节点，
   * 因此不会改变文本宽度或前面修好的多列分页几何。
   */
  async goToOffset(chapterIndex: number, offset: number): Promise<void> {
    if (!this.doc || offset < 0) return
    await this.renderChapter(chapterIndex, 0, 0)
    const walker = this.textWalker()
    let total = 0
    let target: Text | null = null
    let intra = 0
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const length = node.nodeValue?.length || 0
      if (total + length >= offset) {
        target = node
        intra = Math.min(length, Math.max(0, offset - total))
        break
      }
      total += length
    }
    if (!target) return
    const range = document.createRange()
    try {
      range.setStart(target, intra)
      range.collapse(true)
    } catch {
      return
    }
    const rect = range.getBoundingClientRect()
    if (this.settings.pageMode === 'scrolled') {
      const flowRect = this.flow.getBoundingClientRect()
      this.flow.scrollTop += rect.top - flowRect.top - this.flow.clientHeight * 0.28
    } else {
      const flowLeft = this.flow.getBoundingClientRect().left
      this.page = this.pageAtLeft(rect.left - flowLeft)
      this.applyPosition()
      this.emitRelocated()
    }
  }

  // ---------------------------------------------------------------- 选区 / 标注

  /** 译文节点是后来插入的 DOM，不属于章节原始纯文本；所有字符偏移计算必须跳过 */
  private isTranslationNode(node: Node): boolean {
    const host = node instanceof Element ? node : node.parentElement
    return Boolean(host?.closest('[data-nr-tr]'))
  }

  private textWalker(): TreeWalker {
    return document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        this.isTranslationNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    })
  }

  /** 文本节点所在的最近「叶子块级元素」，用于把译文挂到对应原文段落后 */
  private leafBlockOf(node: Node): HTMLElement | null {
    let cur = node instanceof Element ? node : node.parentElement
    while (cur && cur !== this.article) {
      if (/^(?:P|H[1-6]|LI|BLOCKQUOTE|DIV|SECTION|PRE|ARTICLE)$/.test(cur.tagName)) {
        return cur as HTMLElement
      }
      cur = cur.parentElement
    }
    return null
  }

  private textOffsetOf(node: Node, offset: number): number {
    const walker = this.textWalker()
    let total = 0
    while (walker.nextNode()) {
      const current = walker.currentNode
      if (current === node) return total + offset
      total += current.nodeValue?.length || 0
    }
    return total
  }

  private captureSelection(allowClear = true): void {
    const clear = (): void => {
      if (allowClear) this.hooks.onSelectionCleared?.()
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.doc) return clear()
    const text = sel.toString().trim()
    if (!text || text.length > 2000) return clear()
    const range = sel.getRangeAt(0)
    if (!this.article.contains(range.startContainer) || !this.article.contains(range.endContainer)) return clear()
    // 译文可以正常选中复制，但不能作为划线 / 笔记的锚点（偏移不属于原文）
    if (this.isTranslationNode(range.startContainer) || this.isTranslationNode(range.endContainer)) return clear()
    const start = this.textOffsetOf(range.startContainer, range.startOffset)
    const end = this.textOffsetOf(range.endContainer, range.endOffset)
    if (end <= start) return clear()
    const locator: ReaderLocator = {
      chapterIndex: this.chapterIndex,
      page: this.page,
      percent: this.chapterPercent(),
      range: { start, end }
    }
    this.hooks.onSelected({ cfiRange: encodeLocator(locator), text, locator })
  }

  private wrapRange(start: number, end: number, className: string, color: string, key: string): void {
    const walker = this.textWalker()
    const targets: { node: Text; from: number; to: number }[] = []
    let pos = 0
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const len = node.nodeValue?.length || 0
      const from = Math.max(start, pos)
      const to = Math.min(end, pos + len)
      if (from < to) targets.push({ node, from: from - pos, to: to - pos })
      pos += len
      if (pos >= end) break
    }
    for (const target of targets.reverse()) {
      const range = document.createRange()
      try {
        range.setStart(target.node, target.from)
        range.setEnd(target.node, target.to)
        const mark = document.createElement('mark')
        mark.className = className
        if (key) mark.dataset.key = key
        if (color) mark.style.setProperty('--hl-color', color)
        range.surroundContents(mark)
      } catch {
        /* 选区跨节点边界，跳过该片段 */
      }
    }
  }

  private applyAnnotations(): void {
    for (const [key, anno] of this.annotations) {
      if (anno.chapterIndex !== this.chapterIndex) continue
      this.wrapRange(anno.start, anno.end, 'nr-hl', anno.color, key)
    }
  }

  highlight(key: string, color: string): void {
    const loc = decodeLocator(key)
    if (!loc?.range) return
    this.annotations.set(key, {
      chapterIndex: loc.chapterIndex,
      start: loc.range.start,
      end: loc.range.end,
      color
    })
    this.unwrapMarks(`mark.nr-hl[data-key="${cssEscape(key)}"]`)
    if (loc.chapterIndex === this.chapterIndex) {
      this.wrapRange(loc.range.start, loc.range.end, 'nr-hl', color, key)
    }
  }

  unhighlight(key: string): void {
    this.annotations.delete(key)
    this.unwrapMarks(`mark.nr-hl[data-key="${cssEscape(key)}"]`)
  }

  private unwrapMarks(selector: string): void {
    for (const mark of Array.from(this.article.querySelectorAll(selector))) {
      const parent = mark.parentNode
      if (!parent) continue
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
      parent.removeChild(mark)
    }
    this.article.normalize()
  }

  highlightTerm(term: string): void {
    this.findTerm = term.trim()
    this.unwrapMarks('mark.nr-find')
    const needle = this.findTerm.toLowerCase()
    if (!needle) return
    const walker = this.textWalker()
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    for (const node of nodes.reverse()) {
      const value = node.nodeValue || ''
      const lower = value.toLowerCase()
      const positions: number[] = []
      let i = 0
      while ((i = lower.indexOf(needle, i)) >= 0) {
        positions.push(i)
        i += needle.length
      }
      for (const at of positions.reverse()) {
        try {
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + needle.length)
          const mark = document.createElement('mark')
          mark.className = 'nr-find'
          range.surroundContents(mark)
        } catch {
          /* 忽略边界异常 */
        }
      }
    }
  }

  private applyFindTerm(): void {
    const term = this.findTerm
    this.findTerm = ''
    if (term) this.highlightTerm(term)
  }

  clearSelection(): void {
    window.getSelection()?.removeAllRanges()
  }

  // ---------------------------------------------------------------- 正文内嵌对照译文

  private removeTranslationNodes(): void {
    for (const node of Array.from(this.article.querySelectorAll('[data-nr-tr]'))) node.remove()
    for (const node of Array.from(this.article.querySelectorAll('[data-nr-hidden]'))) {
      node.removeAttribute('data-nr-hidden')
    }
  }

  /**
   * 正文里的叶子块级元素 + 字符区间 + 归一化文本。
   *
   * 偏移必须走 textWalker 的文本节点流：document.ts 生成 chapter.text 时做过
   * `replace(/\s+/g,' ').trim()`，而 DOM 里保留原始换行/缩进，用 Range.toString()
   * 直接量会把译文整体挂错一段。这里同时返回归一化文本，注入时优先按内容匹配。
   */
  private paragraphSpans(): { el: HTMLElement; text: string; start: number; end: number }[] {
    const all = Array.from(
      this.article.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, pre')
    )
    const leaves = all.filter((node) => !all.some((other) => other !== node && node.contains(other)))
    const acc = new Map<HTMLElement, { start: number; end: number }>()
    let cursor = 0
    const walker = this.textWalker()
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const len = node.nodeValue?.length || 0
      const host = this.leafBlockOf(node)
      if (host) {
        const existing = acc.get(host)
        if (existing) existing.end = cursor + len
        else acc.set(host, { start: cursor, end: cursor + len })
      }
      cursor += len
    }
    return leaves
      .filter((node) => acc.has(node))
      .map((node) => ({
        el: node,
        text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
        ...acc.get(node)!
      }))
  }

  /**
   * 把译文插到对应原文段落之后。译文节点带 data-nr-tr，不参与任何字符偏移计算，
   * 但作为普通块级元素进入同一 nr-flow，因此版心 / 字体 / 主题 / 翻页 / 进度全复用。
   */
  private injectTranslations(): void {
    this.removeTranslationNodes()
    this.root.classList.toggle('nr-tr-only', this.translationMode === 'translation')
    if (!this.doc || !this.translations.length) return
    if (this.translationMode === 'original') return
    if (this.translationChapter !== this.chapterIndex) return

    const spans = this.paragraphSpans()
    if (!spans.length) return
    const srcLen = this.doc.chapters[this.chapterIndex]?.text.length || 0
    const domLen = spans.reduce((max, s) => Math.max(max, s.end), 0)
    type Group = { primary: string[]; secondary: string[] }
    const groups = new Map<HTMLElement, Group>()
    let cursor = 0
    for (const row of this.translations) {
      const primary = row.translation || (row.error ? `（翻译失败：${row.error}）` : '')
      const secondary = row.secondary || ''
      if (!primary && !secondary) continue

      // 1) 内容优先：用段落原文前缀在归一化块文本里顺序匹配，不受空白压缩影响
      const probe = (row.text || '').replace(/\s+/g, ' ').trim().slice(0, 16)
      let index = -1
      if (probe.length >= 4) {
        for (let i = cursor; i < spans.length; i += 1) {
          if (spans[i].text.includes(probe)) {
            index = i
            break
          }
        }
      }
      // 2) 章节文本做了空白归一化，绝对 offset 会漂移；按比例映射到 DOM 文本流
      if (index < 0 && row.offset >= 0 && srcLen > 0 && domLen > 0) {
        const mapped = Math.round((row.offset / srcLen) * domLen)
        index = spans.findIndex((s) => mapped >= s.start && mapped < s.end)
      }
      // 3) 顺序兜底，保证任何情况下译文都能落到正文里
      if (index < 0) index = Math.min(cursor, spans.length - 1)
      index = Math.max(0, Math.min(index, spans.length - 1))
      const host = spans[index].el
      // 同一段被切成多个 segment 时游标不前进，译文会合并到同一个块
      cursor = index

      const group = groups.get(host) || { primary: [], secondary: [] }
      if (primary) group.primary.push(primary)
      if (secondary) group.secondary.push(secondary)
      groups.set(host, group)
    }

    const make = (lines: string[], second: boolean, label: string): HTMLElement => {
      const p = document.createElement('p')
      p.className = second ? 'nr-tr nr-tr-second' : 'nr-tr'
      p.setAttribute('data-nr-tr', '1')
      if (label) p.setAttribute('data-nr-tr-label', label)
      p.textContent = lines.join('\n')
      return p
    }
    for (const [host, group] of groups) {
      let anchor: Element = host
      if (group.primary.length) {
        const node = make(group.primary, false, this.primaryLabel)
        anchor.insertAdjacentElement('afterend', node)
        anchor = node
      }
      if (group.secondary.length) {
        const node = make(group.secondary, true, this.secondaryLabel)
        anchor.insertAdjacentElement('afterend', node)
      }
    }
    // 仅译文模式：所有原文块都隐藏（包括没有译文的标题 / 短句），
    // 译文以正文样式独占版心。groups 为空时不隐藏，避免翻译未完成就白屏。
    if (this.translationMode === 'translation' && groups.size) {
      for (const span of spans) span.el.setAttribute('data-nr-hidden', '1')
    }
  }

  setTranslations(
    rows: TranslationRow[],
    mode: TranslationMode,
    chapterIndex: number,
    primaryLabel = '译文',
    secondaryLabel = ''
  ): void {
    const ratio = this.ready ? this.chapterPercent() : null
    this.translations = rows.map((row) => ({ ...row }))
    this.translationMode = mode
    this.translationChapter = chapterIndex
    this.primaryLabel = primaryLabel || '译文'
    this.secondaryLabel = secondaryLabel || ''
    if (!this.doc) return
    this.injectTranslations()
    // 内容长度变了必须重排页数，同时尽量保持当前阅读比例
    if (this.ready) this.layout(true, ratio)
  }

  clearTranslations(): void {
    const ratio = this.ready ? this.chapterPercent() : null
    this.translations = []
    this.translationChapter = -1
    this.translationMode = 'bilingual'
    if (!this.doc) return
    this.injectTranslations()
    if (this.ready) this.layout(true, ratio)
  }

  // ---------------------------------------------------------------- 设置 / 生命周期

  applySettings(settings: ReaderSettings): void {
    // 比例必须在替换 settings 之前读取（chapterPercent 依赖旧 pageMode）
    const ratio = this.ready ? this.chapterPercent() : null
    this.settings = settings
    this.applyCssVars()
    if (this.ready) this.layout(true, ratio)
  }

  resize(): void {
    if (!this.ready) return
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    if (!w || !h || (w === this.lastSize.w && h === this.lastSize.h)) return
    this.layout(true)
  }

  navigation(): TocItem[] {
    return this.doc?.toc || []
  }

  chapterCount(): number {
    return this.doc?.chapters.length || 0
  }

  chapterTexts(): { index: number; title: string; text: string }[] {
    return (this.doc?.chapters || []).map((c) => ({ index: c.index, title: c.title, text: c.text }))
  }

  chapterHrefs(): string[] {
    return (this.doc?.chapters || []).map((c) => c.href)
  }

  /** 供对照翻译使用：按真实段落（叶子块级元素）切分，而非整章纯文本 */
  chapterParagraphs(index: number): string[] {
    return this.doc?.chapters[index]?.paragraphs || []
  }

  destroy(): void {
    this.ready = false
    if (this.layoutTimer) window.clearTimeout(this.layoutTimer)
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.doc?.revoke()
    this.doc = null
    this.annotations.clear()
    this.translations = []
    this.translationChapter = -1
    this.columnOffsets = []
    this.lastSize = { w: 0, h: 0 }
    this.root.innerHTML = ''
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}
