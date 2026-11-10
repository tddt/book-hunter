/**
 * electron-builder 25.1.8 在 Windows 上生成 NSIS 卸载器时的环境变量补丁。
 *
 * 根因链路（均已在本机源码中核实）：
 *   app-builder-lib/out/targets/nsis/NsisTarget.js:347
 *     → execWine(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } })
 *   app-builder-lib/out/wine.js:13
 *     → builder-util.exec(file, args, options)
 *   builder-util/out/util.js:133-136
 *     → child_process.execFile(..., { env: getProcessEnv(options.env) })
 *   builder-util/out/util.js:95-98（Windows 分支）
 *     → getProcessEnv(env) 直接 `return env`，不与 process.env 合并
 *
 * 于是那个 NSIS stub 启动时只带一个 __COMPAT_LAYER，完全没有 TEMP / TMP /
 * USERPROFILE / SystemRoot。NSIS 取 GetTempPath() 只能退到 C:\Windows，
 * 概率性报 "NSIS Error: Error writing temporary file"，卸载器 exe 就写不出来；
 * 主安装器随即报 "File: failed opening file \"__uninstaller-nsis-*.exe\""。
 *
 * 本补丁做三件事：
 * 1) 当 execFile 收到显式 env 且其中没有 TEMP 时，合并父进程环境；
 * 2) 对 NSIS 相关子进程，启动前等待并确认中间卸载器 exe 已可独占打开，
 *    避让安全软件对新 exe 的瞬时独占扫描；
 * 3) 可选诊断输出：仅当 SHULIE_BUILD_DEBUG=1 时打印（默认静默，避免
 *    console.error 被 electron-builder 日志加 ⨯ 前缀、制造误导性红字）。
 *
 * 不改 node_modules，pnpm install 不会覆盖；由 build-win.mjs 通过
 * node --require 注入，仅对构建进程生效。
 * 还原：删除本文件并移除 build-win.mjs 里的 --require 参数。
 */
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const distDir = path.join(process.cwd(), 'dist')
const originalExecFile = childProcess.execFile
const originalSpawn = childProcess.spawn

function sleepSync(ms) {
  // 同步等待但不忙等 CPU；Node 主线程允许 Atomics.wait
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function uninstallerState() {
  try {
    const names = fs.readdirSync(distDir).filter((n) => /^__uninstaller-.*\.exe$/.test(n))
    if (!names.length) return 'ABSENT'
    const file = path.join(distDir, names[0])
    const size = fs.statSync(file).size
    try {
      const fd = fs.openSync(file, 'r+')
      fs.closeSync(fd)
      return `${names[0]} size=${size} FREE`
    } catch (error) {
      return `${names[0]} size=${size} LOCKED(${error.code || 'unknown'})`
    }
  } catch (error) {
    return `ERR(${error.code || 'unknown'})`
  }
}

/**
 * 主安装器的 makensis 会用 File 指令读取 __uninstaller-*.exe。若此刻文件还没
 * 落盘、或正被安全软件独占，就会报 failed opening file。等它真正可读再放行。
 */
function waitForUninstaller() {
  for (let i = 0; i < 12; i += 1) {
    const state = uninstallerState()
    if (state === 'ABSENT' || state.includes('FREE')) return state
    sleepSync(250)
  }
  return uninstallerState()
}

const DEBUG = process.env.SHULIE_BUILD_DEBUG === '1'
let diagnostics = 0
function diag(tag, file, extra) {
  if (!DEBUG || diagnostics++ > 24) return
  console.error(
    `[env-patch] ${tag} ${path.basename(String(file))} | ${extra} | uninstaller=${uninstallerState()}`
  )
}

if (DEBUG) {
  console.error(
    `[env-patch] loaded; TEMP=${process.env.TEMP || '(none)'} TMP=${process.env.TMP || '(none)'}`
  )
}

childProcess.execFile = function patchedExecFile(file, args, options, callback) {
  const name = String(file)
  const isNsis = /makensis|__uninstaller/i.test(name)
  if (isNsis) diag('execFile:before', name, 'nsis')
  if (
    options &&
    typeof options === 'object' &&
    options.env &&
    typeof options.env === 'object' &&
    options.env.TEMP == null &&
    options.env.TMP == null
  ) {
    options = { ...options, env: { ...process.env, ...options.env } }
    if (isNsis) diag('execFile:env-fixed', name, 'merged TEMP/TMP')
  }
  return originalExecFile.call(this, file, args, options, callback)
}

// executeMakensis 用 spawnAndWrite → child_process.spawn 启动 makensis，
// 并把 NSIS 脚本写进 stdin。这里只做「放行前等待」，不改参数。
childProcess.spawn = function patchedSpawn(command, args, options) {
  const name = String(command)
  if (/makensis\.exe/i.test(name)) {
    diag('spawn:before', name, 'makensis')
    // 主安装器编译（卸载器 exe 已生成）时固定多等 500ms：360 对刚落盘的
    // 未签名 exe 会做一次实时扫描，扫描窗口内即使此刻能打开，makensis 读
    // 到一半也可能被独占。实测 rcedit 的重试耗时恰好起过这个作用。
    if (uninstallerState() !== 'ABSENT') sleepSync(500)
    const state = waitForUninstaller()
    diag('spawn:ready', name, `state=${state}`)
  }
  return originalSpawn.call(this, command, args, options)
}
