import { BrowserWindow, app } from 'electron'

/**
 * 启动界面（Splash Screen）。
 *
 * 设计取舍：
 *  - 独立无边框 BrowserWindow + 内联 HTML（data URL），不走 renderer 构建、不依赖
 *    asar 里的资源，因此 app.whenReady() 之后第一帧就能显示，不会出现「白屏等主窗口」。
 *  - 页面里没有任何 <script>，阶段/进度全部由主进程 executeJavaScript 写入，
 *    既避免 CSP 问题，也保证进度反映的是真实初始化阶段而不是假动画。
 *  - 纯展示窗口：sandbox + nodeIntegration:false + contextIsolation，不加载外部内容。
 *  - 有 12s 强制销毁兜底；任何异常都返回 null，绝不因为启动屏失败而阻塞主流程。
 *  - SHULIE_NO_SPLASH=1 可关闭（开发与自动化验证用）。
 */

export interface Splash {
  /** 更新阶段文案与进度（0-100） */
  setPhase(label: string, percent: number): void
  /** 主窗口首帧已显示后调用：淡出并销毁 */
  finish(): void
  /** 启动失败：显示原因并稍作停留，随后由调用方退出应用 */
  fail(message: string): void
}

/** 单独导出，便于离线渲染验证启动屏视觉，不依赖真实 Electron 窗口。dark 由主进程偏好缓存决定。 */
export function splashHtml(version: string, dark = false): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>书猎 · 启动中</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:'Segoe UI Variable Display','Segoe UI','Microsoft YaHei',sans-serif;
  --sp-bg:#f7f9fe;--sp-fg:#172035;--sp-g1:#e5edff;--sp-g2:#f0ebff;
  --sp-muted:#96a3b9;--sp-text2:#586680;--sp-border:#e4eaf4;
  --sp-ver:rgba(255,255,255,.7);--sp-track:#e8eef9;--sp-foot:#a7b2c5;
  --sp-line:#edf1f8;--sp-inset:rgba(255,255,255,.5);
  background:var(--sp-bg);color:var(--sp-fg);position:relative;
  -webkit-font-smoothing:antialiased;user-select:none}
body.dark{--sp-bg:#14171e;--sp-fg:#e7ebf4;--sp-g1:rgba(63,104,216,.20);
  --sp-g2:rgba(140,110,220,.16);--sp-muted:#778194;--sp-text2:#aeb8ca;
  --sp-border:#2c3340;--sp-ver:rgba(255,255,255,.05);--sp-track:#262d38;
  --sp-foot:#6e788b;--sp-line:#252b35;--sp-inset:rgba(255,255,255,.12)}
.glow{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(420px 260px at 6% -10%,var(--sp-g1) 0%,transparent 68%),
  radial-gradient(360px 240px at 104% 108%,var(--sp-g2) 0%,transparent 66%)}
.wrap{position:relative;height:100%;display:flex;flex-direction:column;padding:32px 36px 22px}
.brand{display:flex;align-items:center;gap:13px}
.logo{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;
  background:linear-gradient(135deg,#6b8cf5 0%,#3d63d2 100%);
  box-shadow:0 8px 20px rgba(63,104,216,.28),inset 0 1px 0 var(--sp-inset)}
.name{font-size:22px;font-weight:700;letter-spacing:4px;line-height:1.15}
.sub{margin-top:4px;font-size:9px;font-weight:600;letter-spacing:2.4px;color:var(--sp-muted)}
.ver{margin-left:auto;padding:4px 9px;border:1px solid var(--sp-border);border-radius:999px;
  font-size:10px;color:var(--sp-muted);background:var(--sp-ver)}
.center{flex:1;display:flex;flex-direction:column;justify-content:center;gap:13px}
.slogan{font-size:13px;letter-spacing:.4px;color:var(--sp-text2)}
.track{height:5px;border-radius:999px;background:var(--sp-track);overflow:hidden}
#bar{height:100%;width:6%;border-radius:999px;position:relative;
  background:linear-gradient(90deg,#6b8cf5,#3d63d2);
  transition:width .5s cubic-bezier(.16,1,.3,1)}
#bar::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.62),transparent);
  animation:sheen 1.7s linear infinite}
@keyframes sheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--sp-muted)}
#phase{color:var(--sp-text2)}
#pct{margin-left:auto;font-variant-numeric:tabular-nums}
.dot{width:5px;height:5px;border-radius:50%;background:#6b8cf5;
  animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
.foot{display:flex;align-items:center;padding-top:13px;border-top:1px solid var(--sp-line);
  font-size:10px;color:var(--sp-foot)}
body.bye{opacity:0;transform:scale(.985);
  transition:opacity .26s ease,transform .26s ease}
body.error #phase{color:#e2747a}
body.error #bar{background:#d5585b}
@media (prefers-reduced-motion:reduce){#bar::after,.dot{animation:none}}
</style></head>
<body class="${dark ? 'dark' : 'light'}">
<div class="glow"></div>
<div class="wrap">
  <div class="brand">
    <div class="logo">
      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#fff"
        stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5.2A2.2 2.2 0 0 1 6.2 3H19v15.5H6.2A2.2 2.2 0 0 0 4 20.7z"/>
        <path d="M4 20.7A2.2 2.2 0 0 1 6.2 18.5H19"/>
        <path d="M11.4 9.2a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8z"/>
        <path d="M13.5 13.3 15.6 15.4"/>
      </svg>
    </div>
    <div><div class="name">书猎</div><div class="sub">BOOK HUNTER</div></div>
    <div class="ver">v${version}</div>
  </div>
  <div class="center">
    <div class="slogan">把书找出来，把阅读还给自己</div>
    <div class="track"><div id="bar"></div></div>
    <div class="row"><span class="dot"></span><span id="phase">正在启动…</span><span id="pct">6%</span></div>
  </div>
  <div class="foot"><span>本地优先 · 数据不离开这台电脑</span><span style="margin-left:auto">© 2026 书猎</span></div>
</div>
</body></html>`
}

export function showSplash(dark = false): Splash | null {
  if (process.env['SHULIE_NO_SPLASH'] === '1') return null

  let win: BrowserWindow | null = null
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let startedAt = Date.now()

  try {
    win = new BrowserWindow({
      width: 460,
      height: 284,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      center: true,
      // 等内联页面首帧绘制完再显示，否则 data: URL 加载的几十毫秒里会闪一个纯白空窗
      show: false,
      backgroundColor: dark ? '#14171e' : '#f7f9fe',
      title: '书猎 · 启动中',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    const target = win
    const version = app.getVersion()
    const ready = target.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(version, dark))}`
    )
    void ready
      .then(() => {
        if (!closed && !target.isDestroyed() && !target.isVisible()) {
          target.show()
          // 最短展示时长从「真正可见」开始算，而不是从窗口对象创建开始算
          startedAt = Date.now()
        }
      })
      .catch(() => undefined)

    const destroy = (): void => {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      if (!target.isDestroyed()) target.destroy()
      win = null
    }

    // 极端情况下（页面加载卡死 / ready-to-show 一直不触发）不能让启动屏永远遮住应用
    timer = setTimeout(destroy, 12000)
    timer.unref?.()

    const run = (code: string): void => {
      void ready
        .then(() => {
          if (!closed && !target.isDestroyed()) {
            void target.webContents.executeJavaScript(code).catch(() => undefined)
          }
        })
        .catch(() => undefined)
    }

    return {
      setPhase(label, percent) {
        const pct = Math.max(0, Math.min(100, Math.round(percent)))
        const text = JSON.stringify(label)
        run(
          `(function(){var a=document.getElementById('phase');if(a)a.textContent=${text};` +
            `var b=document.getElementById('bar');if(b)b.style.width='${pct}%';` +
            `var c=document.getElementById('pct');if(c)c.textContent='${pct}%';})()`
        )
      },
      finish() {
        if (closed) return
        // 最短展示时长：本机 SSD 上初始化可能只要几百毫秒，
        // 立刻关掉会变成「闪一下」，观感比没有启动屏更差。
        // SHULIE_SPLASH_HOLD_MS 仅用于自动化验证时延长窗口。
        const hold = Number(process.env['SHULIE_SPLASH_HOLD_MS'] || 0)
        const minMs = Number.isFinite(hold) && hold > 0 ? hold : 900
        const wait = Math.max(0, minMs - (Date.now() - startedAt))
        setTimeout(() => {
          run("document.body.classList.add('bye')")
          setTimeout(destroy, 300)
        }, wait)
      },
      fail(message) {
        if (closed) return
        const text = JSON.stringify(`启动失败：${message}`)
        run(
          `(function(){document.body.classList.add('error');` +
            `var a=document.getElementById('phase');if(a)a.textContent=${text};})()`
        )
        setTimeout(destroy, 1500)
      }
    }
  } catch (error) {
    console.warn('[splash] 启动界面创建失败，跳过', error)
    if (win && !win.isDestroyed()) win.destroy()
    return null
  }
}
