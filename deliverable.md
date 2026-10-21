# 数方 - 交付报告

| 项 | 值 |
| --- | --- |
| **App 名称** | 数方（Suguru · 区域推理） |
| 仓库 | z-biz-game-suguru-cos |
| 品类 | 益智 · 区域填数（每区域装 1..k，邻格含对角不同数） |
| 依赖 | 0（`dependencies` 为 `{}`，零构建；Electron 只是 devDependency） |
| 浏览器断言 | 355 条 / 0 失败（`engine 116 · gen 21 · play 31 · hint 26 · conflict 15 · save 14 · resume 15 · layout 42 · a11y 48 · pause 27`） |
| 部署集闸 | 31 条引用（含 5 张位图尺寸核对）/ 55 行 / 0 失败；阴性自证 `DS_SELFTEST rc=0` |
| 引擎台架 | `npm test` 绿：四条规则 soundness 探针 / 独立计数对账 / 跨引擎指纹对账全通过 |

## 任务摘要

把"有机并线"之后那棵**整局不可玩**的树救回来，再把它推到可上线的状态。

并线（`a0b300e`，两侧 `237df5e` / `bb4ef9f` 有机合并 + `82f6c8a` 去同名顶层声明）留下的是一棵树，
不是一局能玩的游戏：`js/main.js` 顶层两处 `let paused` 让整个模块 **SyntaxError**，`js/audio/synth.js`
引用了从未声明的 `nodes`，`window.suguru` 门面上闸要用的九个键被裁掉了，`css/game.css` 丢了 39 行
（含暂停遮罩的样式），部署清单拷的是 `assets/` 而不是运行时真正要的 `art/`。
这一轮把这些逐条修掉，并把每一条的**依据**写在下表里。

## 真实文件清单

```
index.html  css/game.css  server.cjs  package.json  .gitignore  LICENSE
js/main.js  js/theme.js  js/store.js  js/pwa.js
js/audio/synth.js
js/engine/  rng.js suguru.js count.js generate.js
js/ui/game.js
js/render/  board.js anim.js
art/        tex-board.png spark.png                （运行时位图，assets/gen/make_art.py 产出）
icons/      favicon-16/32/48 apple-touch-icon icon-192/512/1024 icon-maskable-512 og-image
tools/      engine-test.mjs balance.mjs golden.mjs write-golden.mjs playtest.cjs
            scenarios.js verify.sh assemble-site.sh deploy-set.mjs deploy-set-selftest.mjs
.github/workflows/  ci.yml pages.yml
README.md  DESIGN.md  deliverable.md
```

## 改动表：一开始错在哪 → 现在为什么对

| # | 现象 | 处理 | 依据 |
| --- | --- | --- | --- |
| 1 | `js/main.js` 顶层两处 `let paused = false;`（第 66 行本地侧、第 94 行远端侧） | 留一份声明 | ES module 顶层同名声明是 **SyntaxError**，整份 main.js 不加载 ⇒ 页面停在选档页、`window.suguru` 永不出现。`node --check` 复现 |
| 2 | `js/audio/synth.js` 并线后是坏的：`nodes++` 引用**从未声明**的 `nodes`；`Sound.setMuted / muted() / enabled() / state() / resetCount()` 整个不见了 | 整份恢复为本地侧那版（真静音 + 节点计数 + 台架读数） | ES module 是严格模式，`nodes++` 每次发声抛 ReferenceError；而 `applySettings()` 第一行就是 `Sound.setMuted(!sound)` ⇒ 启动即 TypeError，`window.game` 的 getter 每次读都调 `Sound.muted()` 也抛 |
| 3 | `js/main.js` 新一局里 `pulse = null;` —— `pulse` 全仓无声明（本地侧早已改成 `anim.reset()`） | 改回 `anim.reset(); setPaused(false);` | 换一局必抛 ReferenceError |
| 4 | `#btn-pause` 挂了两个 click（`() => setPaused(!paused)` 与 `togglePause`） | 只留 `togglePause` | 双开关＝按了没反应（第一次 click 暂停、紧接着第二次 click 又放开） |
| 5 | `index.html` 有两个 `id="btn-pause"`（顶栏 + 右侧面板） | 面板那颗删掉，顶栏那颗是唯一入口 | 重复 id：`getElementById` 只拿到第一个，面板那颗永远没有处理器。顶栏那颗的 title「暂停 / 继续 (P 或 Space)」是闸钉住的 |
| 6 | M 键接两遍（document 级 `toggleMute()` + window 级 `$('#btn-sound').click()`） | 只留 document 级那一份，并把它提到"选档页提前 return"之前 | 一次按键走完两处 ⇒ 静音被自己抵消，按 M 看着像没反应；顶栏那颗音效按钮在选档页也在场，两页都得按得动 |
| 7 | F 键接两遍（document 级 `toggleFullscreen()` + 远端 `bindFullscreen` IIFE 的 window 级），两套全屏实现、两颗全屏按钮（`#btn-full` 与 `#btn-fullscreen`） | 合成**一套**实现、一颗入口按钮（`#btn-fullscreen`，闸钉住的那颗），能力取两边并集：远端那套的特性检测（含 `ms` 前缀）与"不支持就禁用并写清原因"，本地那套的"进出全屏画布重排" | 双开关＝按了没反应；两套实现同时监听 `fullscreenchange` 会互相回写 |
| 8 | `css/game.css` 被裁掉 39 行：`#pause-veil` / `.pause-card` 的样式、`@media (pointer: coarse)` 的触控命中区、`@media (prefers-reduced-motion: reduce)` 与 `.reduce-motion *` 的减动效地板、`:fullscreen` 的全屏底色 | 整段补回（触控那几条加了 `!important`，见下） | 页面有 `#pause-veil`、`js/main.js` 有 `syncPauseUI()` 把遮罩掀开，样式表里却没有它的样式 ⇒ 暂停看起来是"盘面下方多了一块白框" |
| 9 | `js/main.js` 的 `window.suguru` 门面丢了 9 个键（`anim` / `Sound` / `togglePause` / `restartGame` / `toggleMute` / `toggleFullscreen` / `isPaused` / `phase` / `rt`） | 补回 | 闸的 a11y 场正要用 `A().anim.clock` 与 `A().phase()`、`A().Sound.state()` —— 少了它们，量具只能靠点按钮猜状态，"暂停只是改了个标签"这种假实现也能过 |
| 10 | `js/main.js` 的 `setPaused` 被换成远端那版弱的：只改按钮文案，无遮罩、无 body class、不写存档、不 `syncAll()` | 换回本地那版（`game.status !== 'won'` 守卫 + 停表/写档 + `syncPauseUI()` + `syncAll()`） | 闸的 pause 场逐条盯着"暂停把时钟冻死""暂停遮罩出来了""暂停时提示被拒" |
| 11 | `manifest.webmanifest` 是远端那版：主题色 `#0a0a12`（连自己的 CSS 都不认）、少 11 个字段、少两张图标 | 恢复本地那版（`#080B16` 与 `index.html` 的 `theme-color` 一致；`id/scope/display_override/orientation/lang/dir/categories/description` 齐全；五张图标的 `sizes` 逐张量过 PNG IHDR 真值） | `tools/deploy-set.mjs` 的 P 段（声明的 sizes 必须等于真宽高）与 R3/R5/R6 |
| 12 | 部署清单 `tools/assemble-site.sh` 的位图循环写的是 `for d in icons assets; do` | 改成 `for d in icons art; do`，`assets/` 挪进"不进站点"名单 | `assets/` 只有出图脚本 `make_art.py` 的源码；运行时真要的是 `art/tex-board.png`（盘底纸纹）与 `art/spark.png`（收工火花），原来那两份**不在清单里** ⇒ 线上 404，而所有闸跑的都是仓库根，一条都不会红 |
| 13 | `tools/deploy-set.mjs` 的实数钉 `EXPECT_CHECKS 26` / `EXPECT_ROWS 45` 在并线后就已经对不上 | 改成实测值 `31` / `55` | 并线那一刻起部署集闸就是红的：在合并前的 ref 上建 worktree 跑同一个闸，基线读数就是 `31 条引用 / rows 50`，与钉的 26/45 不符。**钉的是实数，强度不变**（条数再漂它照样红） |
| 14 | `tools/deploy-set-selftest.mjs` 的 X1 针写死了 `for d in icons assets; do` | 改成从仓里现取那行 `for d in ...; do` | 清单收哪几个位图目录是本仓自己的事；针写死就等于给改清单的人埋一颗地雷（针打空 ⇒ `edit()` 抛错 ⇒ 这一刀没落地） |
| 15 | `index.html` 的 head 拼了两套：viewport 与 `twitter:card` 挤在同一行、og/twitter 只留一半字段、data-URI 的手画 SVG 与真 PNG 图标各挂一份 | head 归一：viewport 独占一行、og/twitter 字段补齐且 `og:image` 指真图 `icons/og-image.png`（绝对 URL）、只留真 PNG 图标 | `og:image` 必须写绝对 URL（抓取器不替 Pages 补 `/<slug>/`），`tools/deploy-set.mjs` 的 R7 就按这一条盯 |
| 16 | service worker 注册了两遍（`js/pwa.js` 与 `js/sw-register.js`） | 只留 `js/pwa.js`，删掉 `js/sw-register.js` 与它的 `<script>` | 两次 register 同一份 sw.js 不坏，但"谁负责注册"从此有两个答案，改一个漏一个就静默失效 |

## 口径裁决：空格键到底算不算暂停

两侧行为互斥，本轮按**闸是行为裁决者**取远端那侧：

- 远端侧：P 与空格并在一起，顶栏按钮的 title 写着「暂停 / 继续 (P 或 Space)」；
  闸（`tools/scenarios.js` 的 pause 场）明写"title 里那两个键位是给用户看的承诺：P 与 空格 都得真的停表"，
  并逐条断言"按 空格 真的松开""空格松开之后表接着走"。
- 本地侧的代码注释明写"故意不把 Space 也绑成暂停"。

⇒ 结论：**空格 = 暂停**（较新且有意的一侧，且闸站在它那边）；本地侧那句注释已按事实改写。
副作用一并核过：`tools/playtest.cjs` 不注入空格，闸里只有 pause 场那一次 `key(' ')`，选档页的空格仍是"开当前档"
（选档页那段排在暂停那段之前）。

## 待人接手（本轮没有替产品做决定）

- **静音偏好的落盘口**：远端侧在 `js/audio/synth.js` 里另有一路 `localStorage['cos.mute']`，
  与 `Store.setting('sound')` 并存（本轮统一到 Store 那一路 —— 闸判的也是它）。
  已经在旧版浏览器里存下 `cos.mute` 的玩家，那个键值从此**不再被读也不再被写**。
  要不要做一次性迁移，请产品定。
- `js/store.js` 本地侧那版（带坏记录清洗）保留：远端那版的 `load()` 是
  `{...base, ...JSON.parse(raw)}` 那一类写法，一条 `null` 记录就能让整个 Store 拿不到 data，
  玩家看到的是"页面白屏/按钮全哑"而不只是"那次续局没了"。这一版是并线里已经取胜的，不在本轮改动内。

## 构建验证结论

本机直接测量（不依赖任何子代理转述）：

```
npm run check                     rc=0  OK
npm test                          绿（四条规则 soundness / 独立计数对账 / 跨引擎指纹）
bash tools/verify.sh              === ALL GREEN ===   exit 0
  浏览器 355 checks / 0 failed   （10 场：engine 116 · gen 21 · play 31 · hint 26 · conflict 15
                                  · save 14 · resume 15 · layout 42 · a11y 48 · pause 27）
  pause 场读数   fs=entered focus=True fsEnabled=True frozen=0 frozenP=0 resumed=222 jump=1
                 afterNew=302 errs=0        ← 冻结恰好 0 ms、恢复不倒灌、未捕获异常 0 条
  deploy-set     31 条引用（含 5 张位图尺寸核对）/ rows 55 / fail 0
  selftest       DS_SELFTEST rc=0（12 把刀逐个按预期发力，X13 内联位图 SKIP）
```

`VERIFY_RC=0`。

## 本轮提交的顺序

1. 主修复（`js/main.js`、`js/audio/synth.js`、`js/render/board.js` 未改、`index.html`、`css/game.css`、
   `manifest.webmanifest`、`tools/assemble-site.sh`、`tools/deploy-set-selftest.mjs`、
   `tools/deploy-set.mjs` 的实数钉、`tools/scenarios.js` 的行号指向）。
2. 交付报告与 README 的实数对齐（断言条数、场景数、部署集两颗钉、文件规模、玩法键位表）。
