// 可玩的状态机：一次点击做什么、撤销拿回什么、盘面什么时候算收工、提示被允许说什么。
//
// 两处故意绑死 js/engine/suguru.js：
//   * 数字就活在引擎自己的 st.cells 数组里，判胜用的是引擎那份独立 verify()（按规则原文写，
//     不看这个文件说过什么），所以"UI 说我赢了"不可能和"每个区域各装 1..k、邻格不重数"打架。
//   * 提示读的是**题面**推出来的那条脚本（buildScript），不是玩家自己的手。于是写错的数
//     买不通提示：引擎会继续说题面真正强制的那一步，而不是附和这个错误。

import {
  createState,
  setCell,
  undo as undoState,
  nextDeduction,
  applyDeduction,
  candidates,
  diagnose,
  verify,
  isGiven,
  cellName,
} from '../engine/suguru.js';

export const EMPTY = 0;

// 出题时接受这张盘所走的那条铅笔路径，原样记下来：每行是 {cell, value, rule, why}。
// 用的就是引擎的 nextDeduction + applyDeduction，所以提示和"这局凭什么出货"是同一份推理，
// 不是为 UI 另写一遍的近似版。
export function buildScript(board, { cap = 4000 } = {}) {
  const st = createState(board);
  const rows = [];
  while (rows.length < cap) {
    const d = nextDeduction(st);
    if (!d || d.stalled) break;
    rows.push({ cell: d.cell, value: d.value, rule: d.rule, why: d.why });
    applyDeduction(st, d);
  }
  return rows;
}

// 一个区域自己那条约束满了没有：恰好装着 1..k 各一次。这是纯规则原文的局部事实，
// 只说"这块暂时不用回头看"，不代表它和邻区合得来（那由 conflict 那一侧负责说）。
export function groupComplete(board, cells, g) {
  const grp = board.groups[g];
  const seen = new Uint8Array(grp.length + 1);
  for (const t of grp) {
    const v = cells[t];
    if (!v || v > grp.length || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = puzzle.board.w;
    this.h = puzzle.board.h;
    this.st = createState(puzzle.board);
    this.script = buildScript(puzzle.board);
    this.cursor = 0;
    this.steps = [];
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.sel = -1;
    this.lastHint = null;
    this.recompute();
  }

  recompute() {
    this.diag = diagnose(this.st);
    this.doneGroups = new Set();
    for (let g = 0; g < this.board.groups.length; g++) {
      if (groupComplete(this.board, this.st.cells, g)) this.doneGroups.add(g);
    }
    return this.diag;
  }

  cellOf(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  valueOf(t) {
    return t >= 0 && t < this.board.size ? this.st.cells[t] : EMPTY;
  }

  // 一次动作只写一格，快照由引擎的 setCell 推入 history，所以撤销是一格一格精确反着走。
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  select(t) {
    if (t < 0 || t >= this.board.size || this.sel === t) return false;
    this.sel = t;
    return true;
  }

  // 题面给的格不可改；再写一次同一个数就是擦掉（省掉一个"擦"按钮的寻路成本）。
  // 超出所在区域格数的数直接拒：数字键盘本来就不出那个键，键盘路径也得走同一个闸门，
  // 否则会出现"按钮禁用了但按键还能写进去"那种两套规矩的样子。
  play(t, v) {
    if (this.status === 'won' || t < 0) return null;
    if (isGiven(this.board, t)) return { denied: 'given', cell: t };
    if (v < 0 || v > 9) return null;
    if (v > this.board.glen[t]) return { denied: 'range', cell: t, max: this.board.glen[t] };
    const from = this.st.cells[t];
    const to = from === v ? EMPTY : v;
    const res = setCell(this.st, t, to);
    if (!res.ok || !res.changed) return null;
    return this.commit(to ? 'place' : 'erase', { writes: [{ cell: t, from, to }], value: to });
  }

  load(cells) {
    for (let t = 0; t < this.board.size; t++) {
      if (isGiven(this.board, t)) continue;
      const v = cells[t];
      this.st.cells[t] = v >= 1 && v <= 9 ? v : EMPTY;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes) this.st.cells[w.cell] = w.from;
    // 撤回的提示仍然是一次被用过的提示：记录按"借了多少力"排名，退还计数等于让玩家可以
    // 一路撤出个"提示 0"的好成绩。脚本游标退回一格，好让撤回后那一步还能被提示说一遍。
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    else this.cursor = Math.max(0, this.cursor - 1);
    this.recompute();
    // 收回一步之后重判一次胜：赢过之后撤销，"won"必须自己退回去，而不是让 UI 去手改状态位。
    this.checkWin();
    return step;
  }

  // 题面已经强制、而玩家还没写下的下一条事实。它前面的每一行都已经在盘上了，所以提示永远是
  // 一次真实的推进；脚本走完时盘也就推完了，"无话可说"不会被计费。
  hint() {
    if (this.status === 'won') return null;
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (this.st.cells[row.cell] === row.value) {
        this.cursor++;
        continue;
      }
      if (this.st.cells[row.cell] !== EMPTY) {
        // 玩家自己的数和题面强制的数撞上：说出来，不收钱。
        return {
          conflict: `${cellName(this.board, row.cell)} 必须是 ${row.value}：${row.why}`,
          cell: row.cell,
          value: row.value,
        };
      }
      const from = this.st.cells[row.cell];
      setCell(this.st, row.cell, row.value);
      this.cursor++;
      this.commit('hint', { writes: [{ cell: row.cell, from, to: row.value }], value: row.value, rule: row.rule.key });
      const info = {
        rule: row.rule.key,
        ruleName: row.rule.name,
        cell: row.cell,
        value: row.value,
        why: row.why,
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '题面能推的都已经推完了：剩下的格只能自己收尾。' };
  }

  checkWin() {
    // 判胜只问 verify：本文件的 moves / diag 一律不参与。
    this.status = verify(this.board, this.st.cells).ok ? 'won' : 'playing';
    return this.status === 'won';
  }

  // 只给验收 harness 和"替我收工"用：把题面脚本走到底。它写下的每一格都是铅笔规则支持的。
  solveWithLogic({ cap = 4000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const h = this.hint();
      if (h && h.conflict) {
        // 玩家留下的错数挡了路：清掉那一格再看题面说什么，而不是把错的抄成对的。
        if (!isGiven(this.board, h.cell)) setCell(this.st, h.cell, EMPTY);
        this.recompute();
        continue;
      }
      if (!h || h.stalled) break;
    }
    return { status: this.status, tries: k, hints: this.hints, moves: this.moves };
  }

  // 一格还能填哪些数——用的是引擎的 candidates，不在这里另算一套，所以候选点和提示
  // 永远不会各说各话。
  candidatesAt(t) {
    if (t < 0 || this.st.cells[t]) return [];
    return candidates(this.board, this.st.cells, t);
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      filled: g.filled,
      total: this.board.size,
      given: g.given,
      blanks: g.blanks,
      groupsDone: this.doneGroups.size,
      groups: this.board.groups.length,
      conflicts: g.conflicts,
      badCells: Array.from(g.badCells),
      reason: g.reason,
      score: this.puzzle.score,
      steps: this.steps.length,
      script: this.script.length,
      cursor: this.cursor,
      selected: this.sel,
    };
  }
}
