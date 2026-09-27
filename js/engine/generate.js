// 出题器：先定"1 都在哪"，再让每个区域从自己的锚点长出来，然后按号位配数字，最后从"全是提示"往回挖。
//
// 挖洞阶段和 ships 那一仓同构：铅笔路径必须推得完（suguru.js，不回溯），独立穷举器必须说
// 唯一（count.js，不含任何规则）。任何一道不过就把这一格填回去。于是出货的盘同时满足
// "唯一解"与"零猜测"，而且提示数已经少到挖不动为止。
//
// 分数是铅笔路径的加权和（Σ 每次应用的规则权重），band 是 tools/balance.mjs 实测出来的区间。
// 抽盘条件里不许掺墙钟，也不许把随机数交给 sort 的比较器——同一个种子必须在任何引擎里画出同
// 一张盘，那是"存档只记 seed"的前提。
//
// 尺寸这件事不能拍脑袋，国王图里藏着一道计数恒等式：数字 k 只出现在 ≥k 格的区域里，每个这样的
// 区域恰好一个 k，而同一数字的两两不能共边共角，于是
//
//     N_k =（尺寸 ≥ k 的区域数）≤ α = ceil(w/2)·ceil(h/2)
//
// 头两版都拿它当**事后过滤器**：先随机切一盘连通区域，再回溯给它们配数字。实测 5×5 到 9×9 各
// 40 次切盘，配得满数字的不到 2 个；把失败的盘交给一个不带任何启发式的纯穷举器，它说"无解"——
// 也就是说恒等式只是必要条件，随机切的盘绝大多数**天生没有数字解**，深搜多久都是白搜。
// （5×5/maxSize=3 是极端例子：恒等式把区域数逼死成 9 = α，9 个 1 必须占满国王图的最大独立集，
// 8 个 2、8 个 3 又各自要独立，盘根本没解。）
//
// 所以构造顺序换成"从最稀的数字往长出"：先取一个互不相邻的锚点集当所有的 1 → 每个锚点长出一个
// 区域（"每区恰好一个 1"由构造保证）→ 再按号位从大往小，每个号位挑一次独立点集。这样数字解不是
// 赌出来的。挖洞阶段照旧，见下面的两道门。

import { makeRng } from './rng.js';
import { createSuguru, createState, solveWithRules, verify, countGivens } from './suguru.js';
import { countSolutions } from './count.js';

const nbr4 = (w, h, t) => {
  const r = Math.floor(t / w);
  const c = t % w;
  const out = [];
  if (r > 0) out.push(t - w);
  if (r < h - 1) out.push(t + w);
  if (c > 0) out.push(t - 1);
  if (c < w - 1) out.push(t + 1);
  return out;
};

const nbr8 = (w, h, t) => {
  const r = Math.floor(t / w);
  const c = t % w;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      out.push(rr * w + cc);
    }
  }
  return out;
};

// 区域数：由"平均每块 avgCells 格"定，上下界是两条硬账——n·maxSize ≥ 格数（装得下），
// n ≤ α（1 放得下）。取在 avgCells 附近 ±1，让锚点不必贴着 α 找。
export function groupCount(w, h, maxSize, avgCells, rng) {
  const cells = w * h;
  const alpha = Math.ceil(w / 2) * Math.ceil(h / 2);
  const nMin = Math.ceil(cells / maxSize);
  const nMax = Math.min(alpha, cells - 1);
  if (nMin > nMax) return 0;
  const around = Math.round(cells / avgCells);
  const lo = Math.max(nMin, around - 1);
  const hi = Math.min(nMax, around + 1);
  if (lo > hi) return 0;
  return lo + rng.int(hi - lo + 1);
}

// ---- 锚点：先把"1 都在哪"定下来 ----------------------------------------------------------------
//
// 1 是数方里最稀的数字：每个区域恰好一个，且两两不能共边共角。所以反过来做——先取国王图的一个
// 独立点集当"1 的位置"，再让每个区域从自己的锚点长出去。于是"每区恰好一个 1"是构造出来的事实，
// 不是事后要验的运气。
//
// 取法：打乱全部格子，依次收下与已收格不相邻的那些；一轮收不满 n 个就换套顺序重来，取收得最多的。
export function anchors(w, h, n, rng, { rounds = 40 } = {}) {
  const total = w * h;
  let best = [];
  for (let round = 0; round < rounds && best.length < n; round++) {
    const taken = new Uint8Array(total);
    const out = [];
    for (const t of rng.shuffle([...Array(total).keys()])) {
      if (taken[t]) continue;
      out.push(t);
      taken[t] = 1;
      for (const x of nbr8(w, h, t)) taken[x] = 1;
    }
    if (out.length > best.length) best = out;
  }
  if (best.length < n) return null;
  // 独立点集的任意子集仍独立，所以多出来的随机丢掉就行
  return rng.shuffle(best).slice(0, n);
}

// ---- 从锚点长出区域 ------------------------------------------------------------------------------
//
// 锚点各占一格，其余的格一轮一轮地分。每一手挑"最危险"的空格——它的空邻居最少，再不定下来就要
// 被别人的地盘封成谁也收不了的洞；收下它的是目前最小的那个区域，这样没有区域会早早撑到 maxSize
// 然后把邻居的路堵死。每一格都接在本区域已有的格上，所以每块必然连通；锚点一开始就在自己区域里，
// 所以不会被别人抢走。返回的 groups[i][0] 就是 i 号区域的锚点（它的 1）。
export function grow(w, h, anch, maxSize, rng) {
  const total = w * h;
  if (anch.length * maxSize < total) return null;
  const gid = new Int16Array(total).fill(-1);
  const groups = anch.map(() => []);
  anch.forEach((t, i) => {
    gid[t] = i;
    groups[i].push(t);
  });
  const owners = [];
  let left = total - anch.length;
  while (left > 0) {
    let pick = -1;
    let pickFree = 99;
    let pickOwners = null;
    for (let t = 0; t < total; t++) {
      if (gid[t] >= 0) continue;
      owners.length = 0;
      let free = 0;
      for (const x of nbr4(w, h, t)) {
        if (gid[x] < 0) {
          free++;
          continue;
        }
        if (groups[gid[x]].length < maxSize && !owners.includes(gid[x])) owners.push(gid[x]);
      }
      if (!owners.length) continue;
      if (free < pickFree || (free === pickFree && rng.next() < 0.35)) {
        pick = t;
        pickFree = free;
        pickOwners = owners.slice();
      }
    }
    if (pick < 0) return null;
    // 破平手的随机数要**先抽好再排**：把 rng.next() 写进比较器里，抽几次就取决于比较器被调了几次，
    // 而 sort 的比较次数是实现相关的（引擎、版本、数组长度都会改它）。实测后果正是这里要的确定性
    // 的反面：同一个 seed，node 抽出 26 个提示的盘、Chrome 抽出 22 个——"存档只记 seed"当场失效。
    const keyed = pickOwners.map((gi) => [gi, rng.next()]);
    keyed.sort((a, b) => groups[a[0]].length - groups[b[0]].length || a[1] - b[1]);
    const gi = keyed[0][0];
    gid[pick] = gi;
    groups[gi].push(pick);
    left--;
  }
  return groups;
}

// ---- 配数字：一次配一个号位，从小往上 -------------------------------------------------------------
//
// k 格的区域要装下 1..k 各一次。1 已经躺在锚点了，剩下的是一批一批挑：号位 k 要在"尺寸 ≥ k 的
// 区域"里各挑一格，而这一批格两两不能共边共角；挑完才轮到 k+1。每批只是一次独立点集选取，约束
// 只落在同数字之间——比一次性给全盘着色好搜得多（第一版想一口气配完，随机切的盘 40 个里配不满的
// 有 38 个，而且独立穷举证明那些盘**根本没有数字解**；这一版从构造上避开了那一类盘）。
//
// 号位必须从小到大配。反过来的话（先配大号），轮到 2 的时候每个区域只剩最后一格可放——全盘 n 个
// 2 全成了被前几手定死的被迫格，互相撞车的概率极高（实测：7×7 配到号位 3 就"无候选"，6 个节点就
// 判死）。顺着配，号位 2 面对的是"每个区域除去锚点全是候选"的最宽裕时刻，越往后候选越少，但参与
// 的区域也越少（只有尺寸 ≥ k 的才要出格），两头一起在收紧。
export function assignDigits(groups, w, h, rng, { cap = 3000 } = {}) {
  const total = w * h;
  const val = new Int8Array(total);
  for (const g of groups) val[g[0]] = 1;
  const top = groups.reduce((a, g) => Math.max(a, g.length), 0);
  for (let k = 2; k <= top; k++) {
    const need = [];
    for (let gi = 0; gi < groups.length; gi++) if (groups[gi].length >= k) need.push(gi);
    if (!need.length) continue;
    let nodes = 0;
    const chosen = new Uint8Array(groups.length);
    const blocked = new Int16Array(total); // 已被本格号选中的格的八邻计数（叠加，回溯时减回去）
    const candOf = (gi) => {
      const out = [];
      const g = groups[gi];
      for (let i = 1; i < g.length; i++) if (!val[g[i]] && !blocked[g[i]]) out.push(g[i]);
      return out;
    };
    const walk = () => {
      if (++nodes > cap) return false;
      let bi = -1;
      let bc = null;
      for (const gi of need) {
        if (chosen[gi]) continue;
        const c = candOf(gi);
        if (!c.length) return false;
        if (!bc || c.length < bc.length) {
          bi = gi;
          bc = c;
        }
      }
      if (bi < 0) return true;
      for (const t of rng.shuffle(bc)) {
        chosen[bi] = 1;
        val[t] = k;
        const near = nbr8(w, h, t);
        for (const x of near) blocked[x]++;
        if (walk()) return true;
        for (const x of near) blocked[x]--;
        val[t] = 0;
        chosen[bi] = 0;
      }
      return false;
    };
    if (!walk()) return null;
  }
  return val;
}

// 两道门。逻辑检查便宜得多，先让它挡掉大部分不合格。
function measure(spec, countBudget = 200_000) {
  const board = createSuguru(spec);
  const t0 = performance.now();
  const run = solveWithRules(createState(board));
  const ms = performance.now() - t0;
  if (!run.ok) return { ok: false, stage: 'logic', reason: run.stall || 'stalled', ms, run };
  const c = countSolutions(spec, { cap: 2, budget: countBudget });
  if (c.status === 'OVERBUDGET') return { ok: false, stage: 'count', reason: 'overbudget', ms, run };
  if (c.status !== 'UNIQUE') return { ok: false, stage: 'count', reason: c.status === 'ZERO' ? 'no-solution' : 'ambiguous', ms, run };
  return { ok: true, board, score: run.score, steps: run.steps, breakdown: run.breakdown, ms };
}

// 从"每格都是提示"往回挖，一轮一轮挖到挖不动为止：一轮里能挖的格全挖一遍，只要这一轮有收获
// 就再来一轮。少跑这一层循环，出货的盘就不是"最简"的——先被试过的那一格当时挖不动，
// 后来别的格挖掉了、它的约束松了，就再也轮不到它了。tools/engine-test.mjs 里有一条
// "任何一个提示拿掉都推不完或不唯一"的门禁，盯的就是这个。
function dig(board, solution, rng, { minGivens = 0, countBudget = 200_000 } = {}) {
  const givens = Int8Array.from(solution);
  const specOf = () => ({ w: board.w, h: board.h, groups: board.groups, givens });
  let last = measure(specOf(), countBudget);
  if (!last.ok) return last;
  for (let swept = 0; ; swept++) {
    let removed = 0;
    for (const t of rng.shuffle([...Array(board.size).keys()])) {
      if (countGivens(givens) <= minGivens) break;
      const back = givens[t];
      if (!back) continue;
      givens[t] = 0;
      const got = measure(specOf(), countBudget);
      if (!got.ok) {
        givens[t] = back;
        continue;
      }
      last = got;
      removed++;
    }
    if (!removed) break;
  }
  const spec = specOf();
  spec.givens = Int8Array.from(givens);
  return { ...last, spec, givens, clues: countGivens(givens) };
}

export function layout({ w, h, maxSize, avgCells = 4, seed }) {
  const rng = makeRng(`${seed}|layout|${w}x${h}x${maxSize}`);
  const n = groupCount(w, h, maxSize, avgCells, rng);
  if (!n) return null;
  for (let k = 0; k < 60; k++) {
    const anch = anchors(w, h, n, rng);
    if (!anch) continue;
    const groups = grow(w, h, anch, maxSize, rng);
    if (!groups) continue;
    const val = assignDigits(groups, w, h, rng);
    if (!val) continue;
    const board = createSuguru({ w, h, groups: groups.map((g) => g.slice().sort((a, b) => a - b)), givens: val });
    if (verify(board, val).ok) return { board, solution: val, groups: board.groups };
  }
  return null;
}

export function generate(opts = {}) {
  const {
    w = 6,
    h = 6,
    maxSize = 8,
    avgCells = 5.4,
    seed = 'plain',
    band = null,
    tries = 40,
    minGivens = 0,
    countBudget = 200_000,
    report = () => {},
  } = opts;
  let best = null;
  let drawn = 0;
  const stats = { accepted: 0, inBand: 0, notLogic: 0, ambiguous: 0, overbudget: 0, noLayout: 0 };
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const laid = layout({ w, h, maxSize, avgCells, seed: trial });
    if (!laid) {
      stats.noLayout++;
      continue;
    }
    drawn++;
    const rng = makeRng(`${trial}|dig`);
    const dug = dig(laid.board, laid.solution, rng, { minGivens, countBudget });
    if (!dug.ok) {
      if (dug.stage === 'logic') stats.notLogic++;
      else if (dug.reason === 'overbudget') stats.overbudget++;
      else stats.ambiguous++;
      report({ k, stage: dug.stage, ok: false, reason: dug.reason });
      continue;
    }
    const offBand = band ? Math.abs(dug.score - Math.min(Math.max(dug.score, band[0]), band[1])) : 0;
    if (band && dug.score >= band[0] && dug.score <= band[1]) stats.inBand++;
    const cand = {
      board: dug.board,
      spec: dug.spec,
      solution: Int8Array.from(laid.solution),
      seed: trial,
      score: dug.score,
      steps: dug.steps,
      breakdown: dug.breakdown,
      ms: dug.ms,
      offBand,
      clues: dug.clues,
      gen: k + 1,
    };
    stats.accepted++;
    if (!best || cand.offBand < best.offBand) best = cand;
    report({ k, stage: 'ready', ok: true, score: dug.score, clues: dug.clues });
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, reason: stats.noLayout ? 'no-layout' : 'stalled', stats, drawn };
  return { ok: true, ...best, stats, drawn };
}

// 档位表。band / budgetMs 都由 tools/balance.mjs 实测填写，不拍脑袋。
//
// avgCells 不是口味参数，是成率的开关：随机切的盘要有数字解，区域平均得 5~6 格。
// 5×5~9×9 各扫了一遍 (区域数, maxSize)（12 个种子），平均 4.5 格以下成率就往零掉——
// 9×9 在 n=14（avg 5.8）是 12/12，n=17（avg 4.8）起是 0/12；7×7 从 n=9 的 12/12 掉到
// n=12 的 2/12。原因见文件头：每个号位都是一批互不相邻的格，而任意 2×2 里同号只能有一个，
// 于是号位 1 和号位 2 合起来最多吃掉半盘格数——区域平均 4 格正好卡在临界，随机盘几乎全废。
// 所以阶梯靠"盘更大 + 挖得更狠"上升，不靠把区域切小。
//
// band 是 2026-09-27 用 `node tools/balance.mjs 24` 量出来的 15~85 分位；budgetMs 是同一次跑出的
// 出题墙钟 p95（本机、24 样本）向上取整到 20ms。门禁是 p95 ≤ budgetMs × 2，两倍的余量留给 CI 的
// 共享 runner——第一次 CI 红了先看它打印的真实 p95，那个数才是该写进这里的基线，别去砍 tries。
export const TIERS = [
  { key: 'trainee', name: '初学', w: 5, h: 5, maxSize: 7, avgCells: 5.0, band: [15, 27], keepT: 0, tries: 40, budgetMs: 60 },
  { key: 'apprentice', name: '上手', w: 6, h: 6, maxSize: 8, avgCells: 5.1, band: [22, 40], keepT: 0, tries: 40, budgetMs: 40 },
  { key: 'regular', name: '熟练', w: 7, h: 7, maxSize: 8, avgCells: 5.4, band: [30, 49], keepT: 0, tries: 40, budgetMs: 80 },
  { key: 'expert', name: '高阶', w: 8, h: 8, maxSize: 8, avgCells: 5.3, band: [44, 63], keepT: 0, tries: 40, budgetMs: 200 },
  { key: 'master', name: '大师', w: 9, h: 9, maxSize: 8, avgCells: 5.8, band: [56, 73], keepT: 0, tries: 40, budgetMs: 280 },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
    maxSize: tier.maxSize,
  };
}

export { createSuguru, createState, solveWithRules, verify };
