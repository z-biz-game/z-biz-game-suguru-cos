// Canvas 渲染层。它读 Game 的引擎状态来画，自己不判断任何东西——没有哪个数字在这里被判定为
// "对"，也没有哪个区域在这里被宣布"齐了"——所以画面不可能和提示、判胜共用的那位求解器打架。
//
// 布局也住在这里（格子边长来自容器、盘面原点、DPR），因为 hitCell 必须用 draw 刚刚用过的那批
// 数字来回答。这两处一旦分家，就会出现那种"盘面画对了，点击却偏一格"的事故。


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；本仓连 setInterval 都没有，无任何周期性重绘
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Regions, Cell, Radius, Font } from '../theme.js';
import { isGiven } from '../engine/suguru.js';

const FONT = Font.sans;

export function layoutFor(w, h, availW, availH) {
  const pad = 14;
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

// 相邻（含共角）的区域不共用同一块底色。底色本身不承载规则信息——分组是粗边界说的——
// 但两块贴在一起却同色，就等于画面上多出一个"这是一块？"的疑问，所以顺手做贪心着色：
// 按区域从大到小，取第一个没有被已着色的邻区用过的色号；六块不够用时退回复用（边界还在）。
export function regionColors(board) {
  const groups = board.groups;
  const order = groups.map((cells, g) => [g, cells.length]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const color = new Int8Array(groups.length).fill(-1);
  const near = (g) => {
    const set = new Set();
    for (const t of groups[g]) for (const n of board.adj[t]) if (board.gid[n] !== g) set.add(board.gid[n]);
    return set;
  };
  for (const [g] of order) {
    const used = new Set();
    for (const n of near(g)) if (color[n] >= 0) used.add(color[n]);
    let k = 0;
    while (k < Regions.length && used.has(k)) k++;
    color[g] = k % Regions.length;
  }
  return color;
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
    this.game = null;
    this.tint = null;
  }

  // 后备缓冲按设备像素定尺寸，而每个绘制调用都留在 CSS 像素里：顶部一次 setTransform，
  // 就免得把这个文件里每个常数都乘以二。
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    this.tint = regionColors(game.board);
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    return { x: (t % this.game.w) * cell + x, y: (((t / this.game.w) | 0) * cell) + y, size: cell };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  draw(game, { pulse = null } = {}) {
    this.game = game;
    if (!this.tint) this.tint = regionColors(game.board);
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const cells = game.st.cells;
    const bad = game.diag.badCells;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // 1) 区域底色。逐格铺，形状就是区域本身；同区域的格由第 2 步的细线连成一片。
    for (let t = 0; t < b.size; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = Regions[this.tint[b.gid[t]] % Regions.length];
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // 2) 格内细线：只画同一区域之间的分隔，让玩家看见"这是一块里的两格"。
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let t = 0; t < b.size; t++) {
      const r = this.cellRect(t);
      const c = t % b.w;
      const row = (t / b.w) | 0;
      if (c + 1 < b.w && b.gid[t + 1] === b.gid[t]) line(ctx, r.x + cell, r.y, r.x + cell, r.y + cell);
      if (row + 1 < b.h && b.gid[t + b.w] === b.gid[t]) line(ctx, r.x, r.y + cell, r.x + cell, r.y + cell);
    }

    // 3) 区域边界：换了区域、或者撞到盘边，就是粗线。齐了的区域换成绿色粗线——
    //    这个"齐"是引擎的 groupComplete 说的（1..k 各一次），不是这里自己数出来的。
    const heavy = Math.max(2, cell * Cell.border);
    ctx.lineCap = 'square';
    for (let g = 0; g < b.groups.length; g++) {
      const done = game.doneGroups.has(g);
      ctx.strokeStyle = won || done ? Palette.success : Palette.lineHeavy;
      ctx.lineWidth = heavy;
      for (const t of b.groups[g]) {
        const r = this.cellRect(t);
        const c = t % b.w;
        const row = (t / b.w) | 0;
        const sep = (o) => o === undefined || b.gid[o] !== g;
        const right = c + 1 < b.w ? t + 1 : undefined;
        const left = c - 1 >= 0 ? t - 1 : undefined;
        const down = row + 1 < b.h ? t + b.w : undefined;
        const up = row - 1 >= 0 ? t - b.w : undefined;
        if (sep(right)) line(ctx, r.x + cell, r.y, r.x + cell, r.y + cell);
        if (sep(left)) line(ctx, r.x, r.y, r.x, r.y + cell);
        if (sep(down)) line(ctx, r.x, r.y + cell, r.x + cell, r.y + cell);
        if (sep(up)) line(ctx, r.x, r.y, r.x + cell, r.y);
      }
    }
    ctx.lineCap = 'butt';

    // 4) 冲突格：底色提示 + 描一圈。只靠变红是不够的，所以圈是形状，色是附加。
    for (const t of bad) {
      const r = this.cellRect(t);
      ctx.fillStyle = Palette.errorSoft;
      ctx.fillRect(r.x + 1, r.y + 1, cell - 2, cell - 2);
      ctx.strokeStyle = Palette.error;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
    }

    // 5) 选中的格：琥珀方框。键盘玩家和指针玩家走的是同一个 sel。
    if (game.sel >= 0) {
      const r = this.cellRect(game.sel);
      ctx.strokeStyle = isGiven(b, game.sel) ? Palette.info : Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.07);
      roundRect(ctx, r.x + 1.5, r.y + 1.5, cell - 3, cell - 3, Radius.cell);
      ctx.stroke();
    }

    // 6) 数字。题面给的用冷白，玩家写的用琥珀——盘上的数字只有这两种身份，
    //    冲突时再叠一层 error 色，所以"我写的哪几个出事了"一眼分得出来。
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.round(cell * Cell.digitScale);
    for (let t = 0; t < b.size; t++) {
      const v = cells[t];
      if (!v) continue;
      const r = this.cellRect(t);
      const given = isGiven(b, t);
      ctx.font = `${given ? 700 : 600} ${fs}px ${FONT}`;
      ctx.fillStyle = bad.has(t) ? Palette.error : given ? Palette.given : Palette.player;
      ctx.fillText(String(v), r.x + cell / 2, r.y + cell / 2 + 1);
    }

    // 7) 提示刚刚点名的那一格——UI 唯一被允许说"看这里"的地方。
    if (pulse && pulse.cell != null && pulse.cell >= 0) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2.5, cell * 0.09);
      ctx.setLineDash([Math.max(4, cell * 0.22), Math.max(3, cell * 0.16)]);
      roundRect(ctx, r.x + 3, r.y + 3, cell - 6, cell - 6, Radius.cell);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 给 harness 用：这一格此刻应当是什么颜色，由这一层的取色逻辑自己回答，
  // 免得测试里另抄一份调色板。
  fillOfCell(t) {
    return Regions[this.tint[this.game.board.gid[t]] % Regions.length];
  }

  borderOfGroup(g) {
    return this.game.doneGroups.has(g) ? Palette.success : Palette.lineHeavy;
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
