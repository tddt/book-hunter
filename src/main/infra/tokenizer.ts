/**
 * 中英混合分词（纯函数，不依赖 Electron / 文件系统）。
 * - 英文 / 数字：按 Intl.Segmenter 的词切分；
 * - 中文：按词切分后补 bigram，兼顾「精确短语」与「单字 / 漏字」召回。
 * MiniSearch 对文档与查询共用此函数，保证分词口径一致。
 */
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

export function chineseTokenize(text: string): string[] {
  const out: string[] = []
  for (const part of segmenter.segment(String(text || '').toLowerCase())) {
    const s = part.segment.trim()
    if (!s) continue
    if (/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
      out.push(s)
      continue
    }
    if (!/[\u4e00-\u9fff]/.test(s)) continue
    out.push(s)
    const han = s.replace(/[^\u4e00-\u9fff]/g, '')
    if (han.length >= 2) {
      for (let i = 0; i < han.length - 1; i += 1) out.push(han.slice(i, i + 2))
    } else {
      out.push(han)
    }
  }
  // 词与 bigram 常重合，去重以免人为放大词频、影响相关性排序
  return [...new Set(out)]
}
