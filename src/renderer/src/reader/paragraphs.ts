/**
 * 对照翻译的段落切分。
 *
 * 章节纯文本是 `body.textContent` 压平后的一整行，无法按换行分段；
 * 这里以 document.ts 抽出的「叶子块级元素」为段落边界，再按句子把过长段落
 * 切到各免费通道的字符上限内，并记录每段在章节纯文本中的偏移，
 * 供「点击对照段落 → 翻到原文所在页」定位。
 */

export interface ParagraphSegment {
  /** `${chapterIndex}:${seq}:${hash}`，同一章同内容时稳定 */
  id: string
  text: string
  /** 在 chapterText 中的起始字符偏移；-1 表示无法精确定位 */
  offset: number
}

const MAX_CHARS = 420
const MAX_SEGMENTS = 140
const SENTENCE = /[^。！？；.!?]+[。！？；.!?]?\s*/gu

function hashText(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 7)
}

/** 按句子边界把超长段落切开，尽量不把一句话拦腰截断 */
function splitLong(text: string, max: number): string[] {
  const sentences = text.match(SENTENCE) || [text]
  const out: string[] = []
  let buffer = ''
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (buffer.trim()) out.push(buffer.trim())
      buffer = ''
      for (let i = 0; i < sentence.length; i += max) {
        const piece = sentence.slice(i, i + max).trim()
        if (piece) out.push(piece)
      }
    } else if ((buffer + sentence).length > max) {
      if (buffer.trim()) out.push(buffer.trim())
      buffer = sentence
    } else {
      buffer += sentence
    }
  }
  if (buffer.trim()) out.push(buffer.trim())
  return out.filter(Boolean)
}

export function buildSegments(
  chapterText: string,
  paragraphs: string[],
  chapterIndex: number
): ParagraphSegment[] {
  const source = paragraphs.length ? paragraphs : [chapterText]
  const pieces: string[] = []
  for (const raw of source) {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text.length < 2) continue
    // 纯页码 / 分隔符不值得消耗免费额度
    if (!/[\p{L}\p{N}]/u.test(text)) continue
    if (text.length > MAX_CHARS) pieces.push(...splitLong(text, MAX_CHARS))
    else pieces.push(text)
    if (pieces.length >= MAX_SEGMENTS) break
  }

  const out: ParagraphSegment[] = []
  let cursor = 0
  for (const text of pieces.slice(0, MAX_SEGMENTS)) {
    let offset = chapterText.indexOf(text, cursor)
    // EPUB 常见「段落里插了脚注标记 / 软连字符」导致整段不是严格子串，
    // 逐级退化为前缀匹配，尽量仍能定位到原文所在页
    if (offset < 0) offset = chapterText.indexOf(text.slice(0, 24), cursor)
    if (offset < 0) offset = chapterText.indexOf(text.slice(0, 12), cursor)
    if (offset < 0) offset = -1
    else cursor = offset + text.length
    out.push({ id: `${chapterIndex}:${out.length}:${hashText(text)}`, text, offset })
  }
  return out
}
