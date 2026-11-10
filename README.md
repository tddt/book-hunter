<div align="center">

# 书猎 · Book Hunter

**本地优先的多格式电子书管理与阅读器 —— 搜得到、导得进、读得舒服。**

*A local-first, multi-format ebook library and reader for the desktop, with a home-grown typesetting engine.*

![version](https://img.shields.io/badge/version-2.3.0-blue.svg)
![platform](https://img.shields.io/badge/platform-Windows-0078D6.svg?logo=windows&logoColor=white)
![stack](https://img.shields.io/badge/Electron%2033%20%7C%20Vue%203%20%7C%20TypeScript-42b883.svg?logo=electron&logoColor=white)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[![Download](https://img.shields.io/badge/Download-Windows%202.3.0-b4482f.svg?logo=windows&logoColor=white)](https://github.com/tddt/book-hunter/releases/latest)
[![Website](https://img.shields.io/badge/Website-Project%20Page-42b883.svg)](https://tddt.github.io/book-hunter/)

</div>

---

书猎是一款面向桌面端的电子书管理工具。它把**书库整理、全文检索、沉浸式阅读、在线取书、对照翻译**收进一个本地应用：书和笔记都留在自己的磁盘上，不需要账号，也不依赖云端服务。

从 2.0 起，EPUB 之外还能直接导入 MOBI / AZW3 / PDF / TXT —— 所有非 EPUB 格式在导入时统一转成标准 EPUB 入库，因此**五种格式共用同一套排版、目录、进度、检索与标注能力**，不是五个各凑合一下的阅读器。

## 界面一览

![深色主题下的书架：封面墙、分类筛选与阅读进度](docs/screenshots/shelf-dark.jpg)

| 格式工具：多个 TXT 合并 / 单独转 EPUB | 窗口收窄到手机宽度（≤640px） |
| :---: | :---: |
| <img src="docs/screenshots/tools-dark.png" width="440" alt="格式工具界面"> | <img src="docs/screenshots/mobile-dark.jpg" width="205" alt="手机宽度响应式布局"> |

## ✨ 特性

- **五种格式，一套体验**：EPUB / MOBI / AZW3 / PDF / TXT 均可导入；支持单文件、多文件、整文件夹递归、窗口拖拽，以及双击 `.epub` 自动导入，SHA1 指纹去重。
- **自研排版引擎**：不依赖 `epub.js`。EPUB 解压 → 章节 HTML 清洗 → CSS 多列原生分页，版心居中、宽屏双页不裁字，真实页码与按字数加权的全书进度。
- **真·全文检索**：书名 / 作者 / 出版社 / 分类 / 标签走倒排索引（毫秒级），整本正文走可中断的流式扫描；命中片段能一键跳到**该命中所在的那一页**并高亮。
- **沉浸式阅读**：工具栏默认隐藏、鼠标移到屏幕边缘才浮现；5 套纸张主题、字号 / 行距 / 段距 / 版心宽度 / 页边距、翻页动画、目录、书签、5 色划线、笔记、书内搜索、全屏与快捷键，关闭重开自动回到上次位置。
- **正文内对照翻译**：译文按段落注入正文，与原文共用版心、字号、行距和翻页，而非挤在侧边小字抽屉里；支持原文 + 译文 / 仅译文 / 仅原文三态、15 种目标语言、第二对照语言、划词翻译，译文落盘缓存，离线可读。
- **在线取书**：聚合 Project Gutenberg / Gutendex / Standard Ebooks / Open Library / Internet Archive 五个公版书源，支持自定义 OPDS 目录与 EPUB 直链，首屏即可浏览各源热门榜；下载带进度、结构校验与自动去重。
- **整理与外观**：分类树、多标签、收藏、阅读状态、评分、网格 / 列表视图；浅色 / 深色 / 跟随系统三态主题，标题栏一键换肤，窗口收窄到 ≤640px 自动切换底部标签栏的响应式布局。
- **启动屏与容错**：独立启动窗口展示真实初始化阶段，渲染层错误边界与全局异常条保证出错不白屏，`F1` / `?` 打开帮助、快捷键与诊断信息。

<details>
<summary><b>格式工具与转换细节</b></summary>

多个 TXT 可「合并成一本」（每个文件为卷、文件内章节为二级目录）或「每本单独生成」；自动识别 UTF-8 BOM / UTF-16 LE·BE / 严格 UTF-8 / GB18030，识别「第 X 章 / 卷 / 回 / 节」标题，无标题文本按字数分节且首章前的简介保留为「开篇」。同名产物自动加 `_2`、`_3`，**不覆盖**已有文件。所有生成的 EPUB 都会回喂解析器做结构自校验，绝不写出「能写不能读」的文件。

</details>

## 📦 支持格式

| 格式 | 导入 | 说明 |
| :--- | :---: | :--- |
| `.epub` | ✅ | 原生字节入库；EPUB2 NCX / EPUB3 NAV 均支持 |
| `.mobi` `.azw3` | ✅ | MOBI6 / KF8 双入口自动回退；**不支持 DRM 与 KFX** |
| `.pdf` | ✅ | 抽取文本层；**扫描版需先 OCR**，不保留原版式 |
| `.txt` | ✅ | 编码自动识别、章节切分；纯文本无图片 |
| 多个 `.txt` → `.epub` | 🛠️ | 内置格式工具，产物可一键导入书架 |

`.azw` / `.kf8` / `.prc` 别名同样接受。安装包**只关联 `.epub`**，不抢占系统里 PDF / TXT 的默认打开方式。

## 🚀 快速开始

### 直接安装（推荐）

到 [Releases](https://github.com/tddt/book-hunter/releases/latest) 下载预编译安装包，页面附 SHA256 供校验：

| 文件 | 说明 |
| :--- | :--- |
| `ShuLie-Setup-2.3.0-x64.exe` | 安装版，自动注册 `.epub` 文件关联 |
| `ShuLie-Portable-2.3.0-x64.exe` | 便携版，不写注册表，放到任意目录即可运行 |

> 若安装版被本机安全软件误拦，可改用便携版，或把整个目录复制到项目路径之外再运行。

### 从源码构建

环境要求：**Node.js 20+**、**pnpm 9+**、Windows（当前打包目标）。仓库内 `.npmrc` 已配置国内镜像。

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发运行（热更新）

pnpm typecheck        # 类型检查
pnpm build            # 构建 main / preload / renderer 三层
pnpm dist:dir         # 产出免安装目录 dist/win-unpacked
pnpm dist:win         # 产出 NSIS 安装版 + 便携版 exe
```

数据全部保存在本地 `%APPDATA%\书猎\library\`：书目、进度、书签、笔记、译文缓存都在这里，**备份整个 `library` 目录即可完整迁移**。删除书籍默认只移除书库记录，不动原文件。

## 🏗 架构一览

| 层 | 选型 | 关键点 |
| :--- | :--- | :--- |
| 桌面壳 | Electron 33 + electron-vite | main / preload / renderer 三层独立打包 |
| 界面 | Vue 3 + TypeScript + Pinia | `file://` 下用 hash 路由；状态集中在 store |
| 阅读渲染 | 自研 `NativeReaderEngine` | CSS 多列分页，完全掌控中文排版与进度模型 |
| 存储检索 | 原子 JSON + MiniSearch | 千本以内够用，**零原生模块**，避开 node-gyp |
| 多格式 | `NormalizedBook` → `buildEpub()` | 阅读器只认标准 EPUB，新增格式不动阅读链路 |
| 网络 | 主进程 `fetch` + 适配器注册表 | CSP 不放行外部 `connect-src`，换书源 / 换翻译通道只改一处 |

```
src/
├── shared/      领域模型 · 强类型 IPC 契约 · 格式清单
├── main/        生命周期 · 领域服务 · 格式适配 · 在线/翻译基础设施
├── preload/     contextBridge 白名单
└── renderer/    Vue 界面 · 自研阅读引擎 · 浅/深设计系统
scripts/         Windows 打包加固 · 图标生成
docs/            开发与设计文档 · 界面截图 · 项目主页源码
```

仓储、索引、扫描器、解析器、阅读引擎、书源与翻译通道都面向接口编程，替换实现只需调整 `src/main/container.ts` 与适配器注册表；书库上万本时可把仓储换成 SQLite + FTS5，上层服务与 IPC 不用动。完整取舍、目录树与版本演进见 **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。

<details>
<summary><b>已知边界</b></summary>

- 为保证版心统一，不加载 EPUB 原书样式表；特殊诗歌 / 表格排版会退化为通用排版。
- PDF 只抽文本层、不做 OCR；非 EPUB 转换后保留文字 / 图片 / 目录，不保留原版式。
- 在线取书只处理最终返回真实 EPUB 字节流的链接；需登录、付费墙、DRM 或强反爬的站点不在支持范围。
- 内置公版书源以英文书为主；免费翻译公共通道有额度与频率限制，可用自建 LibreTranslate 端点替代。
- 「手机布局」指 Electron 窗口收窄到 ≤640px 的响应式布局与触屏点击区，**不包含** Android / iOS 打包或触摸手势翻页。

</details>

## 🗺 路线图

- [x] 发布 GitHub Release 预编译安装包（v2.3.0）
- [ ] 书库一键备份与恢复、迁移向导
- [ ] 125% / 150% / 200% 系统缩放与多显示器 DPI 专项回归
- [ ] 代码签名与自动更新通道
- [ ] 结构化本地日志轮转、崩溃后恢复上次阅读位置
- [ ] 万本级虚拟列表与 SQLite + FTS5 可选后端

## 🤝 参与贡献

欢迎提 Issue 反馈问题或建议，也欢迎 PR。提交前请至少跑一次 `pnpm typecheck`，并尽量在描述里说明「改动前的行为 / 改动后的行为 / 怎么验证」。

有几条项目原则希望一起守住：**不影响现有功能**、**改排版先读懂分页几何**、**IPC 参数一律走 `api.ts`**（Vue Proxy 跨 `contextBridge` 会抛 `An object could not be cloned`）、**不接盗版源、不绕过 DRM 或付费墙**。相关根因与实现细节都在 [开发文档](docs/DEVELOPMENT.md) 里。

## 🙏 致谢与合规

- 构建与运行时：Electron、electron-vite、Vue 3、TypeScript、Pinia、Vite、JSZip、MiniSearch、pdfjs-dist、@lingo-reader/mobi-parser。
- 公版书源：Project Gutenberg、Gutendex、Standard Ebooks、Open Library、Internet Archive，以及用户自行接入的 OPDS 目录。
- 翻译通道：TranSmart、Bing、MyMemory、Google gtx（默认关闭）、自建 LibreTranslate。仅使用面向公众免费开放、无需 API Key 的接口，用于个人阅读的低频翻译；译文质量与可用性由各服务方决定，请遵守其条款与频率限制。

在线取书**只收录公有领域或明确免费授权的内容**，翻译功能不伪造付费凭证、不绕过鉴权。

## 📄 许可证

[MIT](LICENSE) © 2026 tddt
