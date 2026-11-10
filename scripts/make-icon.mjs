#!/usr/bin/env node
/**
 * 生成应用图标 assets/icon.ico，纯 Node 实现，零第三方依赖。
 *
 * 图形：靛蓝对角渐变圆角底 + 展开的书 + 放大镜（呼应「书猎」的检索意象）。
 * 用 SDF（有符号距离场）逐像素绘制并按尺寸独立重绘，天然抗锯齿。
 *
 *   node scripts/make-icon.mjs
 *
 * 【为什么放在 assets/ 而不是 build/】
 * electron-builder.yml 的 buildResources 指向 build/。只要该目录里出现
 * icon.ico，electron-builder 就会自动把它当作 win.icon 并调用 rcedit
 * 改写 exe 资源，即使配置里完全没有 win.icon 这一项。本机 rcedit 对该操作
 * 会概率性报 "Fatal error: Unable to commit changes"，重试 4 次仍可能失败；
 * 被改写过的 exe 还会让 NSIS 打包中间卸载器时报
 * "File: failed opening file __uninstaller..."。
 * 因此图标只作为 extraResources 随包分发，由 window.ts 在运行时设置窗口 /
 * 任务栏图标，绝不进入 buildResources。
 *
 * 还原：删除 assets/icon.ico，并移除 electron-builder.yml 的 extraResources
 * 与 window.ts 里的 appIconPath() 即可。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'assets', 'icon.ico')
// electron-builder 要求 ico 至少 256×256（仅在显式配置 win.icon 时）；
// 256px 的 32bpp 未压缩 BMP 会让 ico 膨胀到 370 KB，因此小尺寸用 BMP、
// 256px 用 PNG 压缩块（Vista+ 资源编译器均支持），整包约 114 KB。
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const mix = (base, color, a) =>
  a <= 0 ? base : [0, 1, 2].map((i) => base[i] + (color[i] - base[i]) * clamp(a, 0, 1))
const smooth = (d, px) => clamp(0.5 - d / px, 0, 1)

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

function sdSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = x - ax
  const wy = y - ay
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1)
  return Math.hypot(wx - t * vx, wy - t * vy)
}

/** 返回 [r, g, b, a]（0-255），坐标为 0..1 归一化 */
function shade(x, y, px) {
  // 背景：对角渐变 + 圆角
  const dBg = sdRoundRect(x, y, 0.5, 0.5, 0.455, 0.455, 0.215)
  const bgA = smooth(dBg, px)
  if (bgA <= 0) return [0, 0, 0, 0]

  const t = clamp((x + y) / 2, 0, 1)
  let rgb = [107 + (61 - 107) * t, 140 + (99 - 140) * t, 245 + (210 - 245) * t]
  // 顶部柔光：线性渐隐，避免出现明显的高光贴片边界
  rgb = mix(rgb, [255, 255, 255], clamp((0.38 - y) / 0.38, 0, 1) * 0.11)

  // 展开的书：左右两页
  const dLeft = sdRoundRect(x, y, 0.325, 0.45, 0.165, 0.2, 0.016)
  const dRight = sdRoundRect(x, y, 0.675, 0.45, 0.165, 0.2, 0.016)
  const aLeft = smooth(dLeft, px)
  const aRight = smooth(dRight, px)
  rgb = mix(rgb, [255, 255, 255], aLeft * 0.96)
  rgb = mix(rgb, [255, 255, 255], aRight * 0.9)

  // 中缝
  const inBook = Math.max(aLeft, aRight)
  rgb = mix(rgb, [82, 112, 205], smooth(Math.abs(x - 0.5) - 0.007, px) * 0.5 * inBook)

  // 页上的文字线
  for (const ly of [0.37, 0.45, 0.53]) {
    const l1 = sdSegment(x, y, 0.205, ly, 0.44, ly - 0.012) - 0.008
    const l2 = sdSegment(x, y, 0.56, ly - 0.012, 0.795, ly) - 0.008
    rgb = mix(
      rgb,
      [96, 128, 218],
      Math.max(smooth(l1, px) * aLeft, smooth(l2, px) * aRight) * 0.34
    )
  }

  // 放大镜：镜面淡色 + 白色圆环 + 手柄
  const cx = 0.7
  const cy = 0.675
  rgb = mix(rgb, [255, 255, 255], smooth(sdCircle(x, y, cx, cy, 0.12), px) * 0.12)
  const ring = Math.abs(sdCircle(x, y, cx, cy, 0.135)) - 0.028
  rgb = mix(rgb, [255, 255, 255], smooth(ring, px))
  const handle = sdSegment(x, y, 0.79, 0.765, 0.875, 0.85) - 0.03
  rgb = mix(rgb, [255, 255, 255], Math.max(smooth(handle, px), smooth(sdCircle(x, y, 0.875, 0.85, 0.03), px)))

  return [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0, (bgA * 255) | 0]
}

/** 单个尺寸 → 标准 BMP ICO 图像块（BITMAPINFOHEADER + 自下而上 BGRA + AND 掩码） */
function renderBmp(size) {
  const px = 1 / size
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = []
    for (let x = 0; x < size; x += 1) {
      row.push(shade((x + 0.5) / size, (y + 0.5) / size, px))
    }
    rows.push(row)
  }

  const xorBytes = Buffer.alloc(size * size * 4)
  let p = 0
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = rows[y][x]
      xorBytes[p++] = b
      xorBytes[p++] = g
      xorBytes[p++] = r
      xorBytes[p++] = a
    }
  }
  // AND 掩码：每行按 4 字节对齐，全 0（alpha 由 32bpp 数据决定）
  const maskRowBytes = Math.ceil(size / 32) * 4
  const andMask = Buffer.alloc(maskRowBytes * size)

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight（XOR + AND）
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(xorBytes.length + andMask.length, 20)
  return Buffer.concat([header, xorBytes, andMask])
}

// ---------- PNG（仅用于 256px，压缩后约几十 KB） ----------
const CRC_TABLE = []
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(tag, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function renderPng(size) {
  const px = 1 / size
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = shade((x + 0.5) / size, (y + 0.5) / size, px)
      const d = y * stride + 1 + x * 4
      raw[d] = r
      raw[d + 1] = g
      raw[d + 2] = b
      raw[d + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const images = SIZES.map((size) => ({
  size,
  data: size >= 256 ? renderPng(size) : renderBmp(size)
}))
const dir = Buffer.alloc(6)
dir.writeUInt16LE(0, 0) // reserved
dir.writeUInt16LE(1, 2) // type = icon
dir.writeUInt16LE(images.length, 4)

let offset = 6 + 16 * images.length
const entries = []
for (const { size, data } of images) {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0)
  entry.writeUInt8(size >= 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // color count
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bit count
  entry.writeUInt32LE(data.length, 8)
  entry.writeUInt32LE(offset, 12)
  entries.push(entry)
  offset += data.length
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]))
console.log(`[make-icon] ${outFile}  ${SIZES.join('/')} px`)
console.log('[make-icon] 注意：请勿把此文件放进 build/（buildResources），否则会触发 rcedit 改写 exe')
