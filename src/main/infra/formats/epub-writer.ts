import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import type { NormalizedBook, NormalizedTocItem } from './normalized'
import { escapeXml, flattenToc } from './normalized'

/**
 * 标准 EPUB 生成器（2.0 的核心）。
 *
 * 生成物必须同时被两套既有解析器正确读取，因此这里严格对齐它们的约定：
 * - 主进程 `epub-parser.ts`：container.xml -> OPF(dc:*) -> NAV/NCX -> spine XHTML；
 *   封面优先认 `properties="cover-image"`，章节标题优先认 `<h1>`。
 * - 渲染层 `reader/document.ts`：DOMParser 解析 OPF/NAV/NCX，按 spine 取 body.innerHTML，
 *   zip 内图片重写成 blob: URL，目录 href 用「章节文件相对路径」匹配。
 *
 * 产物是 EPUB3（带 nav.xhtml）且保留 EPUB2 的 toc.ncx，双解析器都能命中。
 */
const OEBPS = 'OEBPS'
const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  css: 'text/css', xhtml: 'application/xhtml+xml', ncx: 'application/x-dtbncx+xml'
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return MIME[ext] || 'application/octet-stream'
}

export function chapterFile(index: number): string {
  return `chapter-${String(index + 1).padStart(4, '0')}.xhtml`
}

function chapterXhtml(title: string, bodyHtml: string, lang: string): string {
  const safeTitle = escapeXml(title || '正文')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head><meta charset="utf-8" /><title>${safeTitle}</title></head>
<body>
<h1>${safeTitle}</h1>
${bodyHtml}
</body>
</html>`
}

/** NAV 用嵌套 <ol> 表达层级；两级解析器都按 <ol> 深度算 level */
function navList(items: NormalizedTocItem[], hrefOf: (index: number) => string): string {
  if (!items.length) return '<ol><li><span>正文</span></li></ol>'
  const rows = items.map((item) => {
    const href = escapeXml(hrefOf(item.chapterIndex))
    const nested = item.children.length ? `\n${navList(item.children, hrefOf)}` : ''
    return `<li><a href="${href}">${escapeXml(item.label || '未命名章节')}</a>${nested}</li>`
  })
  return `<ol>\n${rows.join('\n')}\n</ol>`
}

function navXhtml(book: NormalizedBook, hrefOf: (index: number) => string, lang: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head><meta charset="utf-8" /><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc" role="doc-toc"><h1>目录</h1>
${navList(book.toc, hrefOf)}
</nav>
</body>
</html>`
}

function ncxXhtml(book: NormalizedBook, hrefOf: (index: number) => string, uid: string): string {
  let playOrder = 0
  const points = (items: NormalizedTocItem[]): string =>
    items
      .map((item) => {
        playOrder += 1
        const children = item.children.length ? points(item.children) : ''
        return `<navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">` +
          `<navLabel><text>${escapeXml(item.label || '未命名章节')}</text></navLabel>` +
          `<content src="${escapeXml(hrefOf(item.chapterIndex))}"/>${children}</navPoint>`
      })
      .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(uid)}" /></head>
<docTitle><text>${escapeXml(book.title)}</text></docTitle>
<navMap>
${points(book.toc)}
</navMap>
</ncx>`
}

function opfXhtml(
  book: NormalizedBook,
  chapterCount: number,
  resources: string[],
  coverName: string | null,
  uid: string
): string {
  const lang = escapeXml(book.language || 'zh-CN')
  const metadata: string[] = [
    `<dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>`,
    `<dc:title>${escapeXml(book.title || '未命名')}</dc:title>`
  ]
  for (const author of book.authors) metadata.push(`<dc:creator>${escapeXml(author)}</dc:creator>`)
  metadata.push(`<dc:language>${lang}</dc:language>`)
  if (book.publisher) metadata.push(`<dc:publisher>${escapeXml(book.publisher)}</dc:publisher>`)
  if (book.published) metadata.push(`<dc:date>${escapeXml(book.published)}</dc:date>`)
  if (book.description) metadata.push(`<dc:description>${escapeXml(book.description.slice(0, 4000))}</dc:description>`)
  for (const subject of book.subjects.slice(0, 20)) {
    metadata.push(`<dc:subject>${escapeXml(subject)}</dc:subject>`)
  }
  if (coverName) metadata.push('<meta name="cover" content="cover-image" />')
  metadata.push(`<meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta>`)

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />'
  ]
  if (coverName) {
    manifest.push(
      `<item id="cover-image" href="${escapeXml(coverName)}" media-type="${mimeOf(coverName)}" properties="cover-image" />`
    )
  }
  for (let i = 0; i < chapterCount; i += 1) {
    const file = chapterFile(i)
    manifest.push(`<item id="chap-${i + 1}" href="${file}" media-type="application/xhtml+xml" />`)
  }
  resources.forEach((path, i) => {
    if (path === coverName) return
    manifest.push(`<item id="res-${i + 1}" href="${escapeXml(path)}" media-type="${mimeOf(path)}" />`)
  })

  const spine = Array.from({ length: chapterCount }, (_, i) => `<itemref idref="chap-${i + 1}" />`)
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${metadata.map((line) => `    ${line}`).join('\n')}
  </metadata>
  <manifest>
${manifest.map((line) => `    ${line}`).join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.map((line) => `    ${line}`).join('\n')}
  </spine>
</package>`
}

/** 把统一中间表示写成合规 EPUB 字节；调用方可直接落盘，也可再交回 ZipEpubParser 自校验 */
export async function buildEpub(book: NormalizedBook): Promise<Uint8Array> {
  if (!book.chapters.length) {
    throw new Error('没有可写入的章节内容')
  }
  // 确定性 uid：同一本书重复转换得到同样的字节，便于去重与回归测试
  const uid = `urn:sha1:${createHash('sha1')
    .update(`${book.title}\u0000${book.authors.join(',')}\u0000${book.chapters.length}`)
    .digest('hex')}`
  const lang = book.language || 'zh-CN'
  const hrefOf = (index: number): string => chapterFile(Math.max(0, Math.min(book.chapters.length - 1, index)))

  // 目录项可能指向越界章节（解析异常时），统一夹取，保证 NAV/NCX 的 href 一定存在
  const toc = book.toc.length
    ? book.toc.map((item) => ({ ...item, chapterIndex: Math.max(0, Math.min(book.chapters.length - 1, item.chapterIndex)) }))
    : book.chapters.map((chapter, index) => ({
        label: chapter.title || `第 ${index + 1} 节`,
        chapterIndex: index,
        level: 0,
        children: []
      }))
  const normalized: NormalizedBook = { ...book, toc }
  void flattenToc(toc)

  const zip = new JSZip()
  // EPUB 规范：mimetype 必须是第一个条目、不压缩、无额外字段
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', CONTAINER_XML)

  const resources: string[] = []
  for (const [relative, data] of Object.entries(book.resources || {})) {
    const clean = relative.replace(/^\/+/, '').replace(/\\/g, '/')
    if (!clean || clean.startsWith('..')) continue
    zip.file(`${OEBPS}/${clean}`, data)
    resources.push(clean)
  }

  let coverName: string | null = null
  if (book.cover?.data?.length) {
    const ext = (book.cover.ext || '.jpg').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    coverName = `images/cover.${ext}`
    if (!resources.includes(coverName)) {
      zip.file(`${OEBPS}/${coverName}`, book.cover.data)
      resources.push(coverName)
    }
  }

  book.chapters.forEach((chapter, index) => {
    zip.file(
      `${OEBPS}/${chapterFile(index)}`,
      chapterXhtml(chapter.title || `第 ${index + 1} 节`, chapter.html || '<p></p>', lang)
    )
  })
  zip.file(`${OEBPS}/nav.xhtml`, navXhtml(normalized, hrefOf, lang))
  zip.file(`${OEBPS}/toc.ncx`, ncxXhtml(normalized, hrefOf, uid))
  zip.file(`${OEBPS}/content.opf`, opfXhtml(normalized, book.chapters.length, resources, coverName, uid))

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
}
