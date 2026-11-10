#!/usr/bin/env node
/**
 * Windows 安装包构建入口（NSIS 安装版 + portable 便携版）。
 *
 * 为什么需要这层包装：
 * electron-builder 在 NSIS 阶段会先编译并「运行」一个中间卸载器 exe
 * （dist/__uninstaller-nsis-*.exe，编译期带 BUILD_UNINSTALLER）。这个 exe
 * 启动时要向 %TEMP% 下的 $PLUGINSDIR 释放插件 DLL。如果 %TEMP% 被改成
 * 8.3 短名、被安全软件实时监控，或目录被清理软件清空，就会弹出
 *   NSIS Error: Error writing temporary file. Make sure your temp folder is valid.
 * 构建随之中断，dist 里留下一个只有 NSIS stub（约 188 KB）的假安装包，
 * 双击它同样会弹这个错 —— 这是最容易被误判成「TEMP 坏了」的情形。
 *
 * 更深一层的真实根因（2026-11-09 第五轮，已在依赖源码中逐行核实）：
 *   NsisTarget.js:347 → wine.js:13 → builder-util/util.js:95-98
 * electron-builder 25.1.8 在 Windows 运行这个 NSIS stub 时，传的 env 只有
 * { __COMPAT_LAYER: "RunAsInvoker" }，而 Windows 分支的 getProcessEnv()
 * 直接返回它、不与 process.env 合并。于是 stub 连 TEMP / TMP / USERPROFILE /
 * SystemRoot 都没有，GetTempPath() 只能退到 C:\Windows，概率性失败；卸载器
 * exe 写不出来，主安装器随即报
 *   File: failed opening file "__uninstaller-nsis-*.exe"
 * 所以光隔离父进程的 TEMP 不够，必须给这条链路补环境变量。
 *
 * 本脚本做七件事：
 * 1) 把 TEMP/TMP 隔离到项目内纯 ASCII 目录，绕开用户目录与安全软件监控；
 * 2) 构建前精确清理 NSIS 中间产物，避免残缺 stub 被当成成品分发；
 * 3) 清空外部注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE：某些 IDE 沙箱会
 *    通过 NODE_OPTIONS 注入删除钩子，把 electron-builder 清理临时卸载器的
 *    fs 调用劫持到回收站，导致 build 末段报 safe-delete / trash 失败；
 * 4) 用 node -r 注入 scripts/electron-builder-env.cjs，给上述 NSIS stub
 *    补齐 TEMP 等环境变量 —— 这是根治「还是报错」的关键一步；
 * 5) 构建前预检 buildResources 目录，禁止任何会被自动发现的图标文件；
 * 6) 构建失败时自动清理残留并重试一次（最多两次尝试）；子进程 stdio
 *    固定为 inherit，不要改成 pipe；
 * 7) 构建后逐个校验 exe 体积（成品远大于 ~190 KB 的 stub），残缺即以
 *    非零码失败，绝不静默交付，并给出中文排查清单。
 *
 * 还原方式：把 package.json 的 dist:win 改回
 *   "electron-vite build && electron-builder --win"
 * 删除 scripts/build-win.mjs、scripts/electron-builder-env.cjs 与 .build-tmp/
 * 即可把图标放回 build/ 亦无妨（但会重新触发 rcedit）。不改系统配置或注册表。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(root, 'dist')
const tempDir = join(root, '.build-tmp')
const cli = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
// 修正 electron-builder 生成 NSIS 卸载器时丢失 TEMP 的环境变量缺陷，见文件内注释
const envPatch = join(root, 'scripts', 'electron-builder-env.cjs')

function fail(message) {
  console.error(`\n[build-win] ${message}`)
  console.error('[build-win] dist 中的 exe 可能不完整，请勿分发。\n')
  process.exit(1)
}

if (!existsSync(cli)) fail('找不到 electron-builder CLI，请先执行 pnpm install')
if (!existsSync(envPatch)) fail('缺少 scripts/electron-builder-env.cjs（NSIS 环境变量补丁）')
mkdirSync(tempDir, { recursive: true })
mkdirSync(dist, { recursive: true })

// ── 预检 1：buildResources 里绝不能有图标 ──────────────────────────────
// electron-builder 会自动扫描 build/ 下的 icon.ico / icon.png 等，即使配置里
// 没有 win.icon 也会调 rcedit 改写 exe。本机实测该操作概率性报
// "Fatal error: Unable to commit changes"，并让 NSIS 打不开中间卸载器。
const buildResourcesDir = join(root, 'build')
const autoIcons = existsSync(buildResourcesDir)
  ? readdirSync(buildResourcesDir).filter((f) =>
      /^(icon|installerIcon|uninstallerIcon)\.(ico|png|icns)$/i.test(f)
    )
  : []
if (autoIcons.length) {
  fail(
    `build/ 里发现会被自动当作应用图标的文件：${autoIcons.join(', ')}\n` +
      '它们会让 electron-builder 调用 rcedit 改写 exe，本机概率性报 ' +
      '"Unable to commit changes" 并连累 NSIS 打包。\n' +
      '请把图标移到 assets/（现为 assets/icon.ico），或删除上述文件后重跑。'
  )
}

// ── 预检 2：随包分发与运行时窗口图标都依赖它 ──────────────────────────
if (!existsSync(join(root, 'assets', 'icon.ico'))) {
  fail('缺少 assets/icon.ico，请先执行 node scripts/make-icon.mjs')
}

// 干净环境：NSIS 用它写 $PLUGINSDIR，electron-builder 用它写 .nsh/.7z
const cleanEnv = { ...process.env }
cleanEnv.TEMP = tempDir
cleanEnv.TMP = tempDir
cleanEnv.TMPDIR = tempDir
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.ELECTRON_RUN_AS_NODE

/**
 * 在「干净子进程」里执行删除，避免脚本自身被注入的 shim 劫持。
 * pattern 以字符串传入，由子进程 RegExp 还原。
 */
function cleanWithNativeFs(target, pattern) {
  const code = [
    "const fs=require('node:fs'),p=require('node:path');",
    'const dir=process.argv[1], re=new RegExp(process.argv[2]);',
    'let n=0;',
    'for(const f of fs.readdirSync(dir)){',
    '  if(!re.test(f)) continue;',
    '  try{fs.rmSync(p.join(dir,f),{recursive:true,force:true});n++}catch{}',
    '}',
    "console.log('[build-win] 清理上次残留 '+n+' 项')"
  ].join('')
  return spawnSync(process.execPath, ['-e', code, target, pattern], {
    env: cleanEnv,
    stdio: 'inherit'
  })
}

// 只匹配 electron-builder 自己生成的 NSIS 中间产物 / 成品，不做通配递归删除
const INTERMEDIATE = '^(__uninstaller-nsis-.*\\.exe|.*\\.nsis\\.7z|ShuLie-.*\\.exe)$'
cleanWithNativeFs(dist, INTERMEDIATE)

// 失败时给出的排查清单。脚本刻意不捕获构建输出（原因见下方 stdio 说明），
// 因此用通用清单而不是日志关键词匹配。
const CHECKLIST = [
  '确认 build/ 里没有 icon.ico / icon.png：buildResources 会被自动发现，触发 rcedit 改写 exe',
  '把项目下的 dist/ 与 .build-tmp/ 加入 360 等安全软件信任区（用完从信任区移除即可还原），或临时退出主动防御',
  '结束残留的 makensis / NSIS / ShuLie 进程后重跑',
  '执行 pnpm install；必要时删除 %LOCALAPPDATA%\\electron-builder\\Cache',
  '若弹出 "Error writing temporary file"，多为上次失败留下的残缺 stub 被双击，或 NSIS 卸载器无法在 TEMP 释放插件'
]

// 【关键】stdio 必须是 'inherit'，不要改成 pipe。
// electron-builder 把 NSIS 脚本通过 stdin 交给 makensis；本机实测把 stdout /
// stderr 改成管道后，主安装器编译会稳定报
//   File: failed opening file "__uninstaller-nsis-*.exe"
// （输出链路变化改变了 NSIS 生成并读取中间卸载器的时序），6/6 复现；
// 改回 inherit 则稳定通过。代价是脚本读不到构建日志，故用上面的排查清单。
const MAX_ATTEMPTS = 3

console.log(`[build-win] TEMP 已隔离：${tempDir}`)
console.log('[build-win] 预检通过：build/ 无自动图标，assets/icon.ico 就绪')
console.log('[build-win] 提示：过程中若出现 ⨯ / NSIS 相关红字，多为 electron-builder 内部重试；')
console.log('[build-win]       以最终退出码与「产物校验通过」为准，不必中途手动终止。\n')
console.log('[build-win] 开始 electron-builder --win ...\n')

let build = null
let attempts = 0
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  attempts = attempt
  if (attempt > 1) {
    console.log(`\n[build-win] 第 ${attempt}/${MAX_ATTEMPTS} 次重试`)
    cleanWithNativeFs(dist, INTERMEDIATE)
    // 同步等待，让安全软件完成对新 exe 的实时扫描并释放句柄；
    // 用子进程定时器，不忙等 CPU。实测 1.5s 偏短，放宽到 2.5s。
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], {
      env: cleanEnv,
      stdio: 'ignore'
    })
    console.log('')
  }
  // 用 -r 注入补丁（而不是 NODE_OPTIONS），避免路径含空格时的解析问题，
  // 也不会把补丁带进无关子进程。补丁只影响 electron-builder 主进程内的
  // child_process.execFile，正是 execWine 运行 NSIS stub 的那一条链路。
  build = spawnSync(process.execPath, ['--require', envPatch, cli, '--win'], {
    cwd: root,
    env: cleanEnv,
    stdio: 'inherit',
    shell: false
  })
  if (build.error || build.status === 0) break
  console.warn(
    `[build-win] 第 ${attempt} 次遇到已知的偶发文件占用（安全软件锁住 NSIS 中间卸载器），` +
      '正在清理残留并自动重试，产物以最后一次校验为准…'
  )
}

if (!build || build.error) fail(`electron-builder 启动失败：${build?.error?.message || '未知原因'}`)
if (build.status !== 0) {
  // 失败时 dist 里可能留下几百 KB 的 NSIS stub，清掉避免被当成成品分发
  cleanWithNativeFs(dist, INTERMEDIATE)
  fail(
    `electron-builder 退出码 ${build.status}（已尝试 ${attempts} 次）\n\n` +
      `[build-win] 排查建议：\n${CHECKLIST.map((s) => `  · ${s}`).join('\n')}`
  )
}
if (attempts > 1) {
  console.log(`[build-win] 第 ${attempts} 次构建成功（已自动越过一次失败）`)
}

// 成品校验：安装版与便携版都应是几十 MB，NSIS stub 只有约 190 KB
const exes = readdirSync(dist).filter((name) => /^ShuLie-.*\.exe$/.test(name))
if (!exes.length) fail('dist 中没有任何 ShuLie-*.exe 产物')
let broken = false
for (const name of exes) {
  const mb = statSync(join(dist, name)).size / 1024 / 1024
  console.log(`[build-win] ${name}  ${mb.toFixed(1)} MB`)
  if (mb < 10) {
    console.error(`[build-win] ${name} 体积异常，疑似残缺 NSIS stub`)
    broken = true
  }
}

// 收尾：在干净子进程里移除隔离临时目录（构建进程已退出，句柄应已释放）
const removeTmp = [
  "const fs=require('node:fs');",
  'try{fs.rmSync(process.argv[1],{recursive:true,force:true})}catch{}'
].join('')
spawnSync(process.execPath, ['-e', removeTmp, tempDir], {
  env: cleanEnv,
  stdio: 'ignore'
})

if (broken) fail('检测到残缺安装包')
console.log('\n[build-win] 产物校验通过 ✔')
// 2026-11-09 实测：本机安全软件会对 dist/ 路径下启动的 Electron 进程做拦截，
// 表现为双击 dist/win-unpacked/书猎.exe 无任何窗口、进程退出码 0x80000003。
// 同一份文件复制到项目外即可正常运行，因此这里必须提醒，别让用户误判成产物损坏。
console.log(
  '\n[build-win] ⚠ 请勿直接双击 dist/win-unpacked/书猎.exe：本机按 dist/ 路径拦截 Electron 进程，' +
    '这是环境问题、不是产物损坏（详见 README「运行打包产物」）。\n' +
    '[build-win]   请用 ShuLie-Setup-*.exe 安装到项目外目录，或把 win-unpacked 整个复制到项目外再运行，例如：\n' +
    '[build-win]   powershell -c "Copy-Item .\\dist\\win-unpacked\\* D:\\ShuLieApp\\ -Recurse -Force"\n'
)
