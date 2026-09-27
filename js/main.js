// 接线：DOM、指针、键盘、时钟、存档，以及验收 harness 驱动的 window.suguru 那层门面。
// 关于盘面的一条规则都不在这里——每个判断都从 js/engine/suguru.js 经 js/ui/game.js 拿过来。
//
// window.suguru.engine 挂的就是页面自己 import 的那张模块图（不是为测试另抄一份），
// 所以浏览器里跑绿的场景，验的是玩家真正用到的那位求解器。所有说明符都是相对路径：
// Pages 把仓库挂在 /<repo>/ 前缀下面，斜杠开头的写法在 github.io 上就是 404。

import { Palette, Regions, Cell, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate } from './engine/generate.js';
import { countSolutions } from './engine/count.js';
import * as Engine from './engine/suguru.js';
import { BoardView } from './render/board.js';
import { Game, buildScript, groupComplete } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  size: $('#stat-size'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  groups: $('#stat-groups'),
  conflicts: $('#stat-conflicts'),
  conflictsRow: $('#stat-conflicts-row'),
  clues: $('#stat-clues'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  srCell: $('#sr-cell'),
  pad: $('#pad'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let tier = 'trainee';
let pulse = null;
let pulseTimer = 0;
// 上一次读数里的"自洽区域"个数，专门用来听"刚刚有一块凑齐了"这件事。
let doneCount = 0;

// ---- clock ---------------------------------------------------------------------------

let startedAt = 0;
let baseElapsed = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function startClock() {
  if (!startedAt) startedAt = Date.now();
}
function stopClock() {
  if (startedAt) baseElapsed += Date.now() - startedAt;
  startedAt = 0;
}

// ---- geometry ------------------------------------------------------------------------

// 可用盒子只问一次：宽度跟着 .stage，高度不能让盘面把整个面板推下屏幕。
// 量的是**内容盒**——clientWidth 把 .stage 的左右内边距也算进来，画布就会比真放得下的宽度
// 胖出 32px，窄屏上多出一条横向滚动条（320px 视口实测溢到 343）。
function availBox() {
  const stage = el.wrap.parentElement;
  if (!stage) return { w: 518, h: 320 };
  const cs = getComputedStyle(stage);
  const inner = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const w = Math.max(240, inner - 2);
  const h = Math.max(240, Math.min(w, window.innerHeight - 210));
  return { w, h };
}

function draw() {
  if (!game) return;
  view.draw(game, { pulse });
}

// ---- readouts ------------------------------------------------------------------------

// 读数只有一个地方写。少了这条，就会出现"某一格统计更新了，另一格忘了"的那种半天找不到的一致性问题。
function syncStats() {
  if (!game) return;
  const s = game.state();
  el.name.textContent = s.name;
  el.tier.textContent = s.tier;
  el.size.textContent = `${game.w}×${game.h} · ${s.groups} 区域`;
  el.moves.textContent = s.moves;
  el.hints.textContent = s.hints;
  el.hintCount.textContent = s.hints;
  el.filled.textContent = `${s.filled}/${s.total}`;
  el.remaining.textContent = s.blanks;
  el.groups.textContent = `${s.groupsDone}/${s.groups}`;
  doneCount = s.groupsDone;
  el.conflicts.textContent = s.conflicts;
  el.clues.textContent = `${s.given}/${s.total}`;
  el.score.textContent = s.score === undefined ? '—' : s.score.toFixed(1);
  el.conflictsRow.classList.toggle('bad', s.conflicts > 0);
  el.time.textContent = fmtMs(clock());
  el.stateLine.textContent = s.conflicts
    ? `${s.conflicts} 处自相矛盾：${s.reason}`
    : s.status === 'won'
      ? '每个区域各装 1..k，相邻格（含对角）数字互不相同。'
      : '';
  el.stateLine.classList.toggle('good', !s.conflicts);
  el.srCell.textContent = describeSel();
  syncPad();
}

function syncAll() {
  syncStats();
  draw();
}

// 选中格对读屏器说的话。可玩性不靠颜色，也不靠"看得见那块底色"。
function describeSel() {
  if (!game || game.sel < 0) return '';
  const b = game.board;
  const t = game.sel;
  const row = Math.floor(t / b.w) + 1;
  const col = (t % b.w) + 1;
  const v = game.valueOf(t);
  const cand = game.candidatesAt(t);
  return `第${row}行第${col}列，${b.glen[t]} 格区域，当前${Engine.isGiven(b, t) ? '题面给的' : '你写的'}数 ${v || '空'}${
    v || Engine.isGiven(b, t) ? '' : `，还能填 ${cand.join('、') || '什么都不行（说明已经矛盾了）'}`
  }`;
}

// 数字键盘只出到"所在区域有几格"，再多出来的键是规则上不可能成立的，禁用它们不是提示。
function syncPad() {
  if (!game) return;
  const max = game.sel >= 0 ? game.board.glen[game.sel] : game.board.top;
  for (const btn of el.pad.querySelectorAll('button')) {
    const v = Number(btn.dataset.digit);
    btn.disabled = v > max;
    btn.setAttribute('aria-pressed', String(game.sel >= 0 && game.valueOf(game.sel) === v));
    btn.setAttribute('aria-label', `${v} 号${v > max ? '（超过所在区域的格数，填不进）' : ''}`);
  }
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.cells, clock(), { moves: game.moves, hints: game.hints });
}

// ---- hint / win ----------------------------------------------------------------------

function showHint(info) {
  if (!info) return;
  if (info.conflict) {
    el.hintRule.textContent = '和题面撞上';
    el.hintLine.textContent = info.conflict;
    say('conflict');
    flash(info.cell, Palette.error);
    return;
  }
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    say('conflict');
    return;
  }
  el.hintRule.textContent = `规则 · ${info.ruleName}`;
  // why 自己已经带了句末句号，这里再补一个就成了"。。所以那一格是 3。"。
  el.hintLine.textContent = `${info.why.replace(/。$/, '')}。所以那一格是 ${info.value}。`;
  say('hint');
  flash(info.cell, Palette.hint);
}

// 提示点名的那一格：动效关掉时也要留下可读的痕迹，所以脉冲只负责"看这里"，文字已经把话说完。
function flash(t, color) {
  pulse = { cell: t, color };
  clearTimeout(pulseTimer);
  if (systemPrefersReducedMotion() || document.body.classList.contains('reduce-motion')) return;
  pulseTimer = setTimeout(() => {
    pulse = null;
    draw();
  }, 1400);
}

function say(kind) {
  if (kind === 'conflict') Sound.conflict();
  else if (kind === 'hint') Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  const s = game.state();
  Store.recordSolve(ms, s.hints);
  const better = Store.recordBest(s.tier, {
    ms,
    hints: s.hints,
    moves: s.moves,
    score: game.puzzle.score,
    size: `${game.w}×${game.h}`,
  });
  Store.clearResume();
  el.winMeta.textContent = `${s.name} ${game.w}×${game.h} · 用时 ${fmtMs(ms)} · 步数 ${s.moves} · 提示 ${s.hints} · 实测难度 ${game.puzzle.score.toFixed(1)}（这一档的带是 ${tierFor(s.tier).band.join('–')}）`;
  el.winRecord.textContent = better ? '这是这一档的新纪录' : '';
  el.winVeil.hidden = false;
  Sound.win();
  renderRecords();
  renderResumeCard();
}

function afterStep(kind, v) {
  if (kind === 'place') Sound.place(v);
  else if (kind === 'erase') Sound.erase();
  else if (kind === 'undo') Sound.undo();
  // "某个区域刚自洽了"这个声音要用**上一步**的计数来比。commit() 在落子里就已经 recompute 过，
  // 所以在这里现取 game.diag 只会拿到新值，比出来永远是 0——第一版就是这么把这条音效写哑的。
  const justDone = game.diag.groupsDone > doneCount;
  el.winVeil.hidden = game.status !== 'won';
  syncAll();
  if (justDone && game.status !== 'won') Sound.region();
  if (game.status === 'won') onWin();
  else flushResume();
}

// ---- actions -------------------------------------------------------------------------

function useHint() {
  if (!game || game.status === 'won') return null;
  const info = game.hint();
  if (!info) return null;
  syncAll();
  if (info.charged) {
    if (game.status === 'won') onWin();
    else flushResume();
  }
  showHint(info);
  return info;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (!step) {
    Sound.denied();
    return null;
  }
  afterStep('undo');
  return step;
}

function select(t) {
  if (!game || t < 0) return false;
  if (!game.select(t)) return false;
  syncAll();
  return true;
}

function play(t, v) {
  if (!game || t < 0) return null;
  const step = game.play(t, v);
  if (!step) {
    Sound.denied();
    return null;
  }
  if (step.denied) {
    // 被拒的落子也要说清楚为什么：只响一声不解释，玩家会以为按钮坏了。
    const why =
      step.denied === 'given'
        ? '这一格是题面给的，改不了。'
        : `这一格在 ${step.max} 格的区域里，最大只能填 ${step.max}。`;
    el.stateLine.textContent = why;
    el.srCell.textContent = why;
    Sound.denied();
    return null;
  }
  afterStep(step.kind, step.value);
  return step;
}

function newGame(seed = null, tierKey = tier) {
  tier = tierKey;
  const s = seed || freshSeed(tierKey);
  const puzzle = makePuzzle(s, tierKey);
  if (!puzzle) {
    // 出题器交不出盘：把原因说出来，而不是让玩家盯着一张空板以为在加载。
    el.stateLine.textContent = `这一档出题失败（seed ${s}），再按一次换一局或回选档。`;
    return false;
  }
  game = new Game(puzzle);
  game.sel = firstBlank(puzzle.board);
  baseElapsed = 0;
  startedAt = 0;
  startClock();
  pulse = null;
  el.winVeil.hidden = true;
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前推得出的下一步，以及它依据哪条规则。';
  view.resize(game, availBox().w, availBox().h);
  syncAll();
  flushResume();
  renderResumeCard();
  return true;
}

function firstBlank(board) {
  for (let t = 0; t < board.size; t++) if (!board.givens[t]) return t;
  return 0;
}

// 换一局必须真的换一张盘。用日期当默认种子是个陷阱：同一天里按十次"换一局"会交出同一张盘，
// 而按钮写的是"换"。随机只允许发生在**挑种子**这一步——生成器本身仍然只吃 seed，
// 墙钟或随机数一旦进了生成器内部，"同一个 seed 在任何引擎画同一张盘"（tools/golden.mjs 钉的那条）当场破。
// 挑出来的 seed 会跟着续局存档一起写回去，所以恢复仍然是确定性的。
let drawNo = 0;
function freshSeed(tierKey) {
  const r = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return `sg|${tierKey}|${++drawNo}|${r}`;
}

function begin({ tier: t = 'trainee', seed = null, resume = false } = {}) {
  if (resume) {
    const r = Store.resume();
    if (r) {
      const puzzle = makePuzzle(r.seed, r.tier);
      if (puzzle) {
        tier = r.tier;
        game = new Game(puzzle);
        game.load(r.cells);
        game.moves = r.moves || 0;
        game.hints = r.hints || 0;
        game.sel = firstBlank(puzzle.board);
        baseElapsed = r.elapsedMs || 0;
        startedAt = 0;
        startClock();
        el.winVeil.hidden = true;
        view.resize(game, availBox().w, availBox().h);
        syncAll();
        show('game');
        return true;
      }
    }
  }
  const ok = newGame(seed, t);
  if (ok) show('game');
  return ok;
}

function show(which) {
  const menu = which === 'menu';
  el.viewMenu.hidden = !menu;
  el.viewGame.hidden = menu;
  if (menu) {
    stopClock();
    flushResume();
    renderMenu();
  } else {
    startClock();
    if (game) view.resize(game, availBox().w, availBox().h);
  }
  syncAll();
}

// ---- menu ----------------------------------------------------------------------------

const TIER_NOTE = {
  trainee: '提示给得多，一路"只此一格"就能收到尾',
  apprentice: '要开始数"这个数在这个区域还剩哪格放得下"',
  regular: '区域更密，邻格挤压开始派上用场',
  expert: '盘更大，偶尔得用一次反证',
  master: '步数最多的一档：每格都要自己想清楚能填什么',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier ghost';
    b.dataset.tier = t.key;
    b.innerHTML = `<span class="tier-name">${t.name}</span>
      <span class="tier-note">${TIER_NOTE[t.key] || ''}</span>
      <span class="tier-size mono">${t.w}×${t.h} · 难度 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.innerHTML = `<b>${t.name}</b><span>${
      best ? `${best.size} · ${fmtMs(best.ms)} · 步 ${best.moves} · 提示 ${best.hints}` : '还没有纪录'
    }</span>`;
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  if (!r) {
    el.resumeCard.hidden = true;
    return;
  }
  const t = tierFor(r.tier);
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `未完成的 ${t.name}`;
  el.resumeMeta.textContent = `${t.w}×${t.h} · 用时 ${fmtMs(r.elapsedMs || 0)} · 提示 ${r.hints || 0} · 步 ${r.moves || 0}`;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

// ---- settings ------------------------------------------------------------------------

function applySettings() {
  const sound = Store.setting('sound') !== false;
  Sound.setEnabled(sound);
  const btn = $('#btn-sound');
  btn.textContent = sound ? '音效 开' : '音效 关';
  btn.setAttribute('aria-pressed', String(sound));
  const reduce = Store.setting('reduceMotion') === true;
  setReduceMotion(reduce);
  document.body.classList.toggle('reduce-motion', reduce);
  const mb = $('#btn-motion');
  mb.textContent = reduce ? '动效 少' : '动效 全';
  mb.setAttribute('aria-pressed', String(!reduce));
}

// ---- pointer & keyboard ---------------------------------------------------------------

el.canvas.addEventListener('pointerdown', (e) => {
  if (!game) return;
  e.preventDefault();
  el.canvas.focus({ preventScroll: true });
  select(view.hitCell(e.clientX, e.clientY));
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (el.viewGame.hidden) return;
  if (!game) return;
  const k = e.key;
  if (/^[1-9]$/.test(k)) {
    e.preventDefault();
    if (game.sel >= 0) play(game.sel, Number(k));
    return;
  }
  if (k === '0' || k === 'Backspace' || k === 'Delete') {
    e.preventDefault();
    if (game.sel >= 0) play(game.sel, 0);
    return;
  }
  const move = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[k];
  if (move) {
    e.preventDefault();
    const cur = game.sel >= 0 ? game.sel : 0;
    const x = cur % game.w + move[0];
    const y = ((cur / game.w) | 0) + move[1];
    const t = game.cellOf(x, y);
    if (t >= 0) select(t);
    return;
  }
  if (k === 'h' || k === 'H') {
    e.preventDefault();
    useHint();
  } else if (k === 'z' || k === 'Z') {
    e.preventDefault();
    undo();
  } else if (k === 'n' || k === 'N') {
    e.preventDefault();
    newGame();
  } else if (k === 'Escape') {
    e.preventDefault();
    show('menu');
  }
});

// ---- wiring --------------------------------------------------------------------------

function buildPad() {
  el.pad.innerHTML = '';
  for (let v = 1; v <= 9; v++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.dataset.digit = String(v);
    b.textContent = String(v);
    b.addEventListener('click', () => {
      if (game && game.sel >= 0) play(game.sel, v);
    });
    el.pad.appendChild(b);
  }
}

$('#btn-hint').addEventListener('click', useHint);
$('#btn-erase').addEventListener('click', () => {
  if (game && game.sel >= 0) play(game.sel, 0);
});
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => newGame());
$('#btn-menu').addEventListener('click', () => show('menu'));
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => newGame());
$('#btn-resume').addEventListener('click', () => begin({ resume: true }));
// 清空存档要连手里这一局一起放下。只清存储不算清完：这局还在内存里，下一次回选档、
// 切后台、关页面都会把它写回 resume——玩家刚看到"存档已清空"，续局卡片又自己冒出来。
function clearSave() {
  Store.reset();
  game = null;
  pulse = null;
  applySettings();
  renderMenu();
  el.stateLine.textContent = '存档已清空。';
}

$('#btn-reset').addEventListener('click', clearSave);
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', Store.setting('sound') === false);
  applySettings();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', Store.setting('reduceMotion') !== true);
  applySettings();
});

window.addEventListener('resize', () => {
  if (!game || el.viewGame.hidden) return;
  view.resize(game, availBox().w, availBox().h);
  draw();
});

// 切到后台就把时钟停下：不然"挂一小时再回来收尾"也能刷出纪录。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopClock();
    flushResume();
  } else if (!el.viewGame.hidden && game && game.status !== 'won') {
    startClock();
  }
});
window.addEventListener('pagehide', () => {
  stopClock();
  flushResume();
});

applyThemeVars();
applySettings();
buildPad();
renderMenu();
show('menu');

// ---- harness surface ------------------------------------------------------------------

window.suguru = {
  version: VERSION,
  engine: {
    ...Engine,
    TIERS,
    tierFor,
    makePuzzle,
    generate,
    countSolutions,
    buildScript,
    groupComplete,
    Regions,
    Cell,
  },
  view,
  Store,
  get game() {
    return game;
  },
  get tier() {
    return tier;
  },
  show,
  begin,
  newGame,
  clearSave,
  useHint,
  undo,
  select,
  play,
  draw,
  state: () => (game ? game.state() : null),
  solveWithLogic: () => {
    if (!game) return null;
    game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return game.state();
  },
  setCell: (t, v) => {
    if (!game) return null;
    // 直接落子，不经过 play() 的 toggle 语义：场景测试要能按格号铺一盘指定的数。
    const r = Engine.setCell(game.st, t, v);
    game.recompute();
    game.checkWin();
    syncAll();
    return r;
  },
};
