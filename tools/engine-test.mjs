// 推理内核的规矩测试。跑法：node tools/engine-test.mjs [每档种子数]
//
// 最硬的一条是"铅笔写下的每一个数都必须和出题那盘数字对得上"。出题器是先有解、再挖提示，
// 所以正解是已知的：任何一条规则只要落子和它不一样，就是在乱写——这一条抓的是"推错了"，
// 而不是"推不动"。同一轮里还顺手查三件配套的事：
//   · 已填格全是真值时，任何空格的候选集里必须还有真值（候选函数不许误杀）；
//   · 已填格全是真值时，全盘一致性检查 contradiction() 必须闭嘴（它一喊错就把正解判死）；
//   · 挖完的提示盘里，随便拿掉一个提示都必须"推不完"或"不止一解"——否则说明还没挖干净。
//
// 另外三条：独立穷举器（count.js，不含任何规则）必须说唯一，而且和另一套按区域顺序硬枚举的
// 朴素实现给同一个数；verify 必须收正解、拒绝每一处单格改动；同一个种子必须画出同一张盘。

import {
  createSuguru,
  createState,
  nextDeduction,
  applyDeduction,
  solveWithRules,
  candidates,
  contradiction,
  verify,
  cellName,
  countGivens,
  RULE_ORDER,
} from '../js/engine/suguru.js';
import { countSolutions } from '../js/engine/count.js';
import { makeRng } from '../js/engine/rng.js';
import { generate, makePuzzle, TIERS } from '../js/engine/generate.js';
import { goldenRows } from './golden.mjs';

const SAMPLES = Number(process.argv[2] || 6);
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

// 朴素对照：按区域顺序一格一格硬试，每次落子把**全盘已经填上的格**扫一遍（提示格从开局就在
// 盘上，只扫"先于自己"的那些会把冲突的提示漏掉——第一版就是这么错的，被 verify 当场驳回）。
// 没有候选集、没有推理、没有剪枝。它和 count.js 的搜索顺序不同，所以那边一旦依赖了顺序相关的
// 假设，两边就会给出不同的数。
function bruteCount(spec, { cap = 3, nodeCap = 400_000 } = {}) {
  const { w, h, groups, givens } = spec;
  const total = w * h;
  const gid = new Int16Array(total);
  const glen = new Int8Array(total);
  groups.forEach((g, gi) => g.forEach((t) => { gid[t] = gi; glen[t] = g.length; }));
  const order = groups.flat();
  const adj = Array.from({ length: total }, (_, t) => {
    const r = Math.floor(t / w);
    const c = t % w;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      out.push(rr * w + cc);
    }
    return out;
  });
  const cells = new Int8Array(total);
  for (let t = 0; t < total; t++) if (givens[t]) cells[t] = givens[t];
  let found = 0;
  let nodes = 0;
  let aborted = false;
  const walk = (i) => {
    if (i === order.length) {
      found++;
      return found >= cap;
    }
    if (++nodes > nodeCap) {
      aborted = true;
      return true;
    }
    const t = order[i];
    if (cells[t]) return walk(i + 1);
    for (let v = 1; v <= glen[t]; v++) {
      let ok = true;
      for (let x = 0; x < total; x++) {
        if (x === t || cells[x] !== v) continue;
        if (gid[x] === gid[t] || adj[t].includes(x)) { ok = false; break; }
      }
      if (!ok) continue;
      cells[t] = v;
      if (walk(i + 1)) return true;
      cells[t] = 0;
    }
    return false;
  };
  walk(0);
  return { found, aborted };
}

const usedRules = {};
let shipped = 0;

for (const tier of TIERS) {
  for (let s = 0; s < SAMPLES; s++) {
    const seed = `t${s}`;
    const r = generate({ ...tier, seed });
    const tag = `${tier.key}/${seed}`;
    if (!r.ok) {
      check(`${tag} 出题失败`, false, r.reason);
      continue;
    }
    shipped++;
    const { board, spec, solution } = r;
    check(`${tag} 提示必须都来自正解`, [...board.givens].every((v, t) => !v || v === solution[t]));

    // 铅笔路径逐手对账
    const st = createState(board);
    let steps = 0;
    let stall = null;
    while (steps < 5000) {
      const d = nextDeduction(st);
      if (!d) break;
      if (d.stalled) {
        stall = d.why;
        break;
      }
      const why = `${tag} 第 ${steps + 1} 手（规则 ${d.rule.key}）`;
      check(`${why} 写的数和正解不符`, st.cells[d.cell] === 0 && solution[d.cell] === d.value, `格 ${d.cell} 写 ${d.value}，正解 ${solution[d.cell]}`);
      const before = candidates(board, st.cells, d.cell);
      check(`${why} 候选里没有真值`, before.includes(solution[d.cell]), `${before.join('/')} 缺 ${solution[d.cell]}`);
      const con = contradiction(board, st.cells);
      check(`${why} 前一手指全盘一致性检查在乱喊`, !con, con ? con.what : '');
      applyDeduction(st, d);
      usedRules[d.rule.key] = (usedRules[d.rule.key] || 0) + 1;
      steps++;
    }
    check(`${tag} 铅笔推不完`, !stall, stall || '');
    check(`${tag} 推完但独立验胜不过`, verify(board, st.cells).ok);
    check(`${tag} 推出来的盘就是正解`, [...st.cells].every((v, t) => v === solution[t]));

    // 独立计数器
    const c = countSolutions(spec, { cap: 2, budget: 400_000 });
    check(`${tag} 计数器不说唯一`, c.status === 'UNIQUE', c.status);
    if (tier.w * tier.h <= 49) {
      const b = bruteCount(spec);
      if (!b.aborted) check(`${tag} 朴素枚举和计数器对不上`, b.found === 1, `朴素 ${b.found} 个`);
    }

    // verify 必须拒绝每一处单格改动：把任意一格换成它该区间的任何一个别的数，验胜都得说不。
    // 这里不能只试"下一个数"——初学档的盘里有 1 格区域，它唯一的合法值就是 1，"换成下一个数"
    // 换回来还是 1，等于什么都没改，验胜当然收下（第一版就是这么误报成 verify 漏了洞的）。
    let rejected = 0;
    let changes = 0;
    let escaped = null;
    const back = Int8Array.from(solution);
    for (let t = 0; t < board.size; t++) {
      for (let v = 1; v <= 9; v++) {
        if (v === back[t]) continue;
        changes++;
        solution[t] = v;
        const res = verify(board, solution);
        if (res.ok && !escaped) escaped = `${cellName(board, t)} 改成 ${v}`;
        if (!res.ok) rejected++;
      }
      solution[t] = back[t];
    }
    check(`${tag} 有单格改动没被验胜拒掉`, rejected === changes, `${rejected}/${changes}${escaped ? ` 漏网：${escaped}` : ''}`);

    // 挖不动的定义：拿掉这个提示，要么铅笔推不完，要么不止一解——两道门里任何一道断了，
    // 出题器留下它就是对的。只有"拿掉之后照样推得完、照样唯一"才算漏挖。
    let loose = 0;
    for (let t = 0; t < board.size; t++) {
      if (!spec.givens[t]) continue;
      const g = Int8Array.from(spec.givens);
      g[t] = 0;
      const cut = { ...spec, givens: g };
      if (!solveWithRules(createState(createSuguru(cut))).ok) continue;
      if (countSolutions(cut, { cap: 2, budget: 400_000 }).status === 'UNIQUE') loose++;
    }
    check(`${tag} 还有 ${loose} 个提示其实可以挖掉`, loose === 0);
  }
}

// 存档只记 seed，所以同一个 seed 必须画出同一张盘
for (const tier of TIERS) {
  const a = makePuzzle('determinism', tier.key);
  const b = makePuzzle('determinism', tier.key);
  check(`${tier.key} makePuzzle 返回空`, !!a && !!b);
  if (!a || !b) continue;
  check(`${tier.key} 同一个 seed 画出两张盘`, JSON.stringify(a.spec.givens) === JSON.stringify(b.spec.givens) && JSON.stringify(a.spec.groups) === JSON.stringify(b.spec.groups));
  check(`${tier.key} 复现的盘验胜不过`, verify(a.board, a.solution).ok);
}

// 上面那一条只查"同一台引擎里两次一样"。夹具查的是另一件事：这些数字是 node 量出来后写进
// tools/golden.mjs 的，浏览器门禁在 Chrome 里跑同一份，两边必须逐字相同——出题器里任何一处
// 引擎相关的随机数（sort 比较器里的 rng.next() 就是那样一处）都会在这里现形。
for (const r of goldenRows(makePuzzle)) check(`${r.tier} 与跨引擎夹具不符`, r.pass, r.detail);

// 挖完的盘上，规则表里每一条都该在真实对局里出场过。一条没出场过的规则要么是死代码，要么是
// 出货面太窄——两种都得知道，所以不许默默放过去：先按出货盘统计，没出场的再用随机中途局面
// 探一轮，还探不出才算 FAIL。
//
// 这一条抓出来的不只有"推不动"，还有一次真删：二联锁定（pair）在这里量出 0 次出场，于是
// 把 5 档 × 60 种子共 300 张盘全跑了一遍——pair×0；再拿 15k+ 个"提示全留、其余按真值填"的
// 中途局面探，还是 0 次。原因是这层减法只在"把某一格削到只剩一个数"时才落子，而二联锁定
// 天生是划线不是落子：候选窄到恰好同一对数时，同一盘的别的空格早就"只此一格"了，永远排在
// 它前面。规则就删了（js/engine/suguru.js 的 eliminations 上记着同一串数字），剩下的四条
// 每一条都被真实对局用过，只有 nishio 用得稀（300 盘 10 次），所以它还留着被探针看着。
console.log(`出货盘上的规则出场次数 ${RULE_ORDER.map((k) => `${k}×${usedRules[k] || 0}`).join('  ')}`);

const probe = { tries: 0 };
const missing = RULE_ORDER.filter((k) => !usedRules[k]);
if (missing.length) {
  for (const tier of TIERS) {
    for (let s = 0; s < 4 && missing.length; s++) {
      const r = generate({ ...tier, seed: `p${s}` });
      if (!r.ok) continue;
      const { board, solution } = r;
      for (let trial = 0; trial < 400 && missing.length; trial++) {
        probe.tries++;
        // 随机留一半：留得太少铅笔直接推不动，留得太多全是"只此一格"。
        // 用种子的 rng，不用 Math.random——门禁本身必须每次跑出同一个结果。
        const pr = makeRng(`${tier.key}|p${s}|${trial}`);
        const st = createState(board, { cells: new Int8Array(board.size) });
        for (let t = 0; t < board.size; t++) if (pr.next() < 0.5) st.cells[t] = solution[t];
        const d = nextDeduction(st);
        if (!d || d.stalled || !missing.includes(d.rule.key)) continue;
        check(`探针里 ${d.rule.key} 写的数和正解不符`, solution[d.cell] === d.value);
        usedRules[d.rule.key] = (usedRules[d.rule.key] || 0) + 1;
        const at = missing.indexOf(d.rule.key);
        if (at >= 0) missing.splice(at, 1);
      }
    }
  }
}
for (const k of missing) check(`规则 ${k} 既是死代码、探针（${probe.tries} 个随机中途局面）也唤不出它`, false);
console.log(missing.length ? '' : `${RULE_ORDER.length} 条规则全部实际生效过（出货盘出场 ${RULE_ORDER.map((k) => `${k}×${usedRules[k] || 0}`).join('  ')}，探针跑了 ${probe.tries} 个中途局面）`);

console.log(fails ? `\nFAILED ${fails}` : '\n推论、候选、矛盾检测、验胜、独立计数、确定性全部对账通过');
process.exit(fails ? 1 : 0);
