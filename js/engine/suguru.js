// 数方 Suguru 的推理内核。
//
// 题面：一张 w×h 的方格被切成若干区域，一个 k 格的区域里必须恰好装着 1..k 各一次；
// 任何两格如果共边或共角（八邻），数字不能相同。部分格子已经写好（提示数），其余要推。
//
// 这个文件里三件事分得很清：
//   nextDeduction / solveWithRules —— 铅笔路径。永不回溯、永不看正解，只写当下必然成立的数。
//                                    它同时是出题的验收测试和提示的唯一来源。
//   verify                         —— 按规则原文独立判胜，不读上面那位说过什么。
//   diagnose                       —— 给玩家看"哪里已经自相矛盾"，不落子。
// 独立穷举计数器在 count.js（它自己建树、自己判冲突，不 import 这里的规则表）。
//
// 为什么"只用这些规则写下的数一定是该盘每一个解里的数"：每一条都只用到**必要条件**。
// 候选集 cand(t) 是从"区域内没重、邻格里没重"算出来的，真解里 t 的取值必然落在里面
// （这两个约束是规则原文），所以 cand 是真可能取值的**超集**。超集只有两个方向有用：
// 里面剩一个 → 那一定是它；里面空了 → 前提已经矛盾。所有规则都只在这两个方向上落子。

export const EMPTY = 0;

export const RULES = {
  only: { key: 'only', name: '只此一格', weight: 1.2, note: '这一格只剩下一个数填得进去' },
  last: { key: 'last', name: '缺数只剩这格', weight: 1.8, note: '区域里这个数只有这一格放得下' },
  squeeze: { key: 'squeeze', name: '邻格挤压', weight: 3.4, note: '这个数在区域里只能落在贴着某格的几格里，那格就不能是它' },
  nishio: { key: 'nishio', name: '反证', weight: 6.0, note: '假设这格填它，剩下的数就放不下了' },
};

export const RULE_ORDER = ['only', 'last', 'squeeze', 'nishio'];

const MAX_DIGIT = 9;

// ---- 盘面 ---------------------------------------------------------------------------

export function createSuguru({ w, h, groups, givens }) {
  const size = w * h;
  const gid = new Int16Array(size).fill(-1);
  const glen = new Int8Array(size);
  groups.forEach((cells, gi) => {
    for (const t of cells) {
      if (gid[t] >= 0) throw new Error(`格 ${t} 同时属于两个区域`);
      gid[t] = gi;
      glen[t] = cells.length;
    }
  });
  for (let t = 0; t < size; t++) if (gid[t] < 0) throw new Error(`格 ${t} 不在任何区域里`);
  const adj = [];
  for (let t = 0; t < size; t++) {
    const r = Math.floor(t / w);
    const c = t % w;
    const list = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        list.push(rr * w + cc);
      }
    }
    adj.push(Int16Array.from(list));
  }
  const g = Int8Array.from(givens);
  return { w, h, size, groups, gid, glen, adj, givens: g, top: Math.max(...groups.map((x) => x.length)) };
}

export function createState(board, { cells = null } = {}) {
  const filled = cells ? Int8Array.from(cells) : Int8Array.from(board.givens);
  return { board, cells: filled, history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cells));
  if (st.history.length > 512) st.history.shift();
}

export function undoState(st) {
  const prev = st.history.pop();
  if (prev) st.cells = prev;
  return !!prev;
}

export const undo = undoState;

export function setCell(st, t, v) {
  if (t < 0 || t >= st.board.size) return { ok: false, reason: '不在盘上' };
  if (st.board.givens[t]) return { ok: false, reason: '题面给定的格不能改' };
  if (st.cells[t] === v) return { ok: true, changed: false, cell: t, value: v };
  snapshot(st);
  st.cells[t] = v;
  return { ok: true, changed: true, cell: t, value: v };
}

export const isGiven = (board, t) => board.givens[t] > 0;
export const cellName = (board, t) => `第${Math.floor(t / board.w) + 1}行第${(t % board.w) + 1}列`;
export const groupName = (board, t) => `${board.gid[t] + 1} 号区域（${board.glen[t]} 格）`;

// ---- 候选：一切的底座 -----------------------------------------------------------------
//
// 返回该格还能填哪些数（升序数组）。只有两条排除：同区域已出现过的数、八邻已填的数。
// 这两条都是规则原文，所以真解的取值一定在结果里。

export function candidates(board, cells, t) {
  if (cells[t]) return [];
  const used = new Uint8Array(MAX_DIGIT + 2);
  for (const n of board.groups[board.gid[t]]) if (cells[n]) used[cells[n]] = 1;
  for (const n of board.adj[t]) if (cells[n]) used[cells[n]] = 1;
  const out = [];
  for (let v = 1; v <= board.glen[t]; v++) if (!used[v]) out.push(v);
  return out;
}

// 区域 g 里还需要落哪些数、每个数现在有几格能落。used 之外的数都"还缺"。
function groupNeeds(board, cells, g) {
  const seen = new Uint8Array(MAX_DIGIT + 2);
  const blanks = [];
  for (const t of board.groups[g]) {
    if (cells[t]) seen[cells[t]] = 1;
    else blanks.push(t);
  }
  const missing = [];
  for (let v = 1; v <= board.groups[g].length; v++) if (!seen[v]) missing.push(v);
  return { blanks, missing };
}

// 全盘一致性检查（不落子，只报矛盾）。返回 null 表示还没矛盾。
export function contradiction(board, cells, { ignore = -1 } = {}) {
  for (let t = 0; t < board.size; t++) {
    if (!cells[t] || t === ignore) continue;
    const v = cells[t];
    if (v > board.glen[t]) return { cells: [t], what: '超出了区域的长度' };
    for (const n of board.adj[t]) if (cells[n] === v && n !== ignore) return { cells: [t, n], what: `${cellName(board, t)} 与 ${cellName(board, n)} 相邻却同为 ${v}` };
    for (const n of board.groups[board.gid[t]]) if (n !== t && cells[n] === v && n !== ignore) return { cells: [t, n], what: `${groupName(board, t)} 里 ${v} 出现了两次` };
  }
  for (let g = 0; g < board.groups.length; g++) {
    const { blanks, missing } = groupNeeds(board, cells, g);
    for (const v of missing) {
      let hosts = 0;
      for (const t of blanks) if (t !== ignore && candidates(board, cells, t).includes(v)) hosts++;
      if (!hosts) return { cells: blanks.length ? blanks : board.groups[g], what: `${groupName(board, g)} 还缺 ${v}，可区域里没有一格放得下它` };
    }
    if (missing.length > blanks.length) {
      return { cells: blanks.length ? blanks : board.groups[g], what: `${groupName(board, g)} 还缺 ${missing.join('/')} 却只剩 ${blanks.length} 格` };
    }
  }
  return null;
}

// ---- 减法层：squeeze 落子前先把"哪些候选必须划掉"算出来 ----------------------------------
//
// 返回每个空格在当前候选之外还要划掉的数（key = t，值 = Set）。规则只在这些减法
// 把某一格削到只剩一个数时落子，所以它们从不"肯定"任何未验证的数。
//
// 这里曾经还有第二条规则（二联锁定：区域里两格候选恰好是同一对数，别处不能再有它们），
// 实测 300 张出货盘（5 档 × 60 种子）里它出场 0 次，另外 15k+ 个"提示全留、其余按真值填"
// 的中途局面里也是 0 次：这层的减法只在"把某一格削到只剩一个数"时才落子，而二联锁定
// 天生是划线不是落子——候选要窄到恰好同一对，这一格的邻居就已经把别的数挤成"只此一格"了，
// 永远排在它前面。留着一条永远不出场的规则，等于在难度分和提示词表里虚报一项，所以删掉。
function eliminations(board, cells) {
  const dead = new Map();
  const kill = (t, v) => {
    if (!dead.has(t)) dead.set(t, new Set());
    dead.get(t).add(v);
  };

  for (let g = 0; g < board.groups.length; g++) {
    const { blanks, missing } = groupNeeds(board, cells, g);
    if (blanks.length < 2) continue;
    const cand = new Map(blanks.map((t) => [t, candidates(board, cells, t)]));

    // 邻格挤压：某个缺数 v 在区域里只剩几格能放，而这几格全贴着区域外的同一格 x，
    // 那么 v 必然落在 hosts 之一，x 就不能是 v。
    //
    // 能被削的格**必须在别的区域里**：本区域的空格只要装得下 v 就已经在 hosts 里了，
    // 在 hosts 之外又在本区域，就等于"装不下 v"，再划一次是空转。第一版就把这条写反了，
    // 结果这条规则一次也没生效过（tools/engine-test.mjs 的"每条规则都得出场"抓出来的）。
    for (const v of missing) {
      const hosts = blanks.filter((t) => cand.get(t).includes(v));
      if (hosts.length < 2) continue;
      for (let t = 0; t < board.size; t++) {
        if (cells[t] || board.gid[t] === g) continue;
        if (!hosts.every((x) => board.adj[t].includes(x))) continue;
        if (candidates(board, cells, t).includes(v)) {
          kill(t, v);
          break;
        }
      }
    }
  }
  return { dead };
}

// 划掉之后还剩几个候选（0 个也算，交给 contradiction 去喊）。
function trimmed(board, cells, t, dead) {
  const base = candidates(board, cells, t);
  const cut = dead.get(t);
  if (!cut || !cut.size) return base;
  return base.filter((v) => !cut.has(v));
}

// ---- 下一步推论 -----------------------------------------------------------------------

export function nextDeduction(st) {
  const { board, cells } = st;

  const con = contradiction(board, cells);
  if (con) {
    return { stalled: true, kind: 'conflict', cells: con.cells, why: `已经写下的数自相矛盾：${con.what}。`, rule: null };
  }

  const blanks = [];
  for (let t = 0; t < board.size; t++) if (!cells[t]) blanks.push(t);
  if (!blanks.length) return null;

  // 1. 只此一格
  for (const t of blanks) {
    const c = candidates(board, cells, t);
    if (c.length === 1) {
      return { kind: 'digit', cell: t, value: c[0], why: `${cellName(board, t)} 只能填 ${c[0]}：${describeBlocked(board, cells, t, c, 1)}。`, rule: RULES.only };
    }
    if (!c.length) {
      return { stalled: true, kind: 'conflict', cells: [t], why: `${cellName(board, t)} 一个数都填不进：${describeBlocked(board, cells, t, [], 0)}。`, rule: null };
    }
  }

  // 2. 缺数只剩这格（区域内的隐藏唯一）
  for (let g = 0; g < board.groups.length; g++) {
    const { blanks: gb, missing } = groupNeeds(board, cells, g);
    for (const v of missing) {
      const hosts = gb.filter((t) => candidates(board, cells, t).includes(v));
      if (hosts.length === 1) {
        const t = hosts[0];
        return { kind: 'digit', cell: t, value: v, why: `${groupName(board, t)} 必须有 ${v}，而这一区域里只有 ${cellName(board, t)} 放得下它。`, rule: RULES.last };
      }
    }
  }

  const { dead } = eliminations(board, cells);

  // 3. 减法把某一格削到只剩一个数：那一格不能是划掉之后的剩下的那个数以外的任何数。
  for (const t of blanks) {
    if (!dead.has(t)) continue;
    const before = candidates(board, cells, t);
    const after = trimmed(board, cells, t, dead);
    if (after.length !== 1) continue;
    const cut = before.filter((v) => !after.includes(v));
    return {
      kind: 'digit',
      cell: t,
      value: after[0],
      rule: RULES.squeeze,
      why: `${cellName(board, t)} 不能是 ${cut.join('、')} —— 那些数在别的区域里只剩贴着这格的几处可去，只剩 ${after[0]}`,
    };
  }

  // 4. 反证：只假设一格一个数，看必要条件塌不塌
  const ni = nishioStep(board, cells, blanks);
  if (ni) return ni;

  return null;
}

function nishioStep(board, cells, blanks) {
  for (const t of blanks) {
    const c = candidates(board, cells, t);
    const alive = [];
    const killed = [];
    for (const v of c) {
      cells[t] = v;
      const con = contradiction(board, cells);
      cells[t] = EMPTY;
      (con ? killed : alive).push(v);
    }
    if (!killed.length) continue;
    if (alive.length === 1) {
      return {
        kind: 'digit',
        cell: t,
        value: alive[0],
        why: `${cellName(board, t)} 试掉 ${killed.join('、')} 之后区域或邻格就放不下了，只能是 ${alive[0]}。`,
        rule: RULES.nishio,
      };
    }
    if (!alive.length) {
      return { stalled: true, kind: 'conflict', cells: [t], why: `${cellName(board, t)} 填任何一个数都会让盘面推不进去：${c.join('、')} 全被反证掉。`, rule: null };
    }
  }
  return null;
}

function describeBlocked(board, cells, t, cands, n) {
  const cut = [];
  for (let v = 1; v <= board.glen[t]; v++) {
    if (cands.includes(v)) continue;
    let where = null;
    for (const x of board.groups[board.gid[t]]) if (x !== t && cells[x] === v) where = `${groupName(board, t)} 里 ${cellName(board, x)} 已是 ${v}`;
    if (!where) for (const x of board.adj[t]) if (cells[x] === v) where = `${cellName(board, x)} 贴着它且已是 ${v}`;
    cut.push(`${v}（${where || '被划掉'}）`);
  }
  return cut.length ? `${cut.join('、')}` : `${n} 个候选都还在`;
}

export function applyDeduction(st, d) {
  if (!d || d.stalled || d.kind !== 'digit') return { changed: false };
  return setCell(st, d.cell, d.value);
}

// ---- 独立判胜：只读盘面，按规则原文 --------------------------------------------------

export function verify(board, cells) {
  const badCells = new Set();
  for (let t = 0; t < board.size; t++) {
    const v = cells[t];
    if (!v) {
      badCells.add(t);
      return { ok: false, badCells, reason: `${cellName(board, t)} 还空着` };
    }
    if (v > board.glen[t]) {
      badCells.add(t);
      return { ok: false, badCells, reason: `${cellName(board, t)} 填了 ${v}，可它所在区域只有 ${board.glen[t]} 格` };
    }
  }
  for (let t = 0; t < board.size; t++) {
    for (const n of board.adj[t]) {
      if (n <= t) continue;
      if (cells[n] === cells[t]) {
        badCells.add(t);
        badCells.add(n);
        return { ok: false, badCells, reason: `${cellName(board, t)} 与 ${cellName(board, n)} 相邻（含对角）却同为 ${cells[t]}` };
      }
    }
  }
  for (let g = 0; g < board.groups.length; g++) {
    const want = board.groups[g].length;
    const seen = new Uint8Array(want + 2);
    for (const t of board.groups[g]) {
      const v = cells[t];
      if (v > want || seen[v]) {
        for (const x of board.groups[g]) badCells.add(x);
        return { ok: false, badCells, reason: `${want} 号区域（${want} 格）没能各装下 1..${want}` };
      }
      seen[v] = 1;
    }
  }
  return { ok: true, badCells, reason: '每个区域恰好装着 1 到它的格数，相邻格（含对角）数字互不相同' };
}

// ---- 给玩家看的读数 -------------------------------------------------------------------

export function diagnose(st) {
  const { board, cells } = st;
  let filled = 0;
  let given = 0;
  let done = 0;
  const badCells = new Set();
  for (let t = 0; t < board.size; t++) {
    if (cells[t]) filled++;
    if (board.givens[t]) given++;
  }
  for (let g = 0; g < board.groups.length; g++) {
    const { missing } = groupNeeds(board, cells, g);
    if (!missing.length) done++;
  }
  const con = contradiction(board, cells);
  if (con) for (const t of con.cells) badCells.add(t);
  return {
    filled,
    given,
    blanks: board.size - filled,
    groupsDone: done,
    groups: board.groups.length,
    conflicts: badCells.size,
    badCells,
    reason: con ? con.what : '',
    won: verify(board, cells).ok,
  };
}

// ---- 铅笔路径：一路推到推不动 ---------------------------------------------------------

export function solveWithRules(st, { cap = 4000 } = {}) {
  const breakdown = {};
  let score = 0;
  let steps = 0;
  let stall = null;
  while (steps < cap) {
    const d = nextDeduction(st);
    if (!d) {
      stall = verify(st.board, st.cells).ok ? null : 'stalled';
      break;
    }
    if (d.stalled) {
      stall = 'contradiction';
      break;
    }
    applyDeduction(st, d);
    breakdown[d.rule.key] = (breakdown[d.rule.key] || 0) + 1;
    score += d.rule.weight;
    steps++;
  }
  const win = verify(st.board, st.cells);
  return { ok: win.ok, stall, steps, score, breakdown, cells: Int8Array.from(st.cells) };
}

export function solveSpec(spec) {
  return solveWithRules(createState(createSuguru(spec)));
}

export function countGivens(givens) {
  let n = 0;
  for (const v of givens) if (v) n++;
  return n;
}
