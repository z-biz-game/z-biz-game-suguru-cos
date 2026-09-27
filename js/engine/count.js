// 独立的穷举计数器。
//
// 它是"这一局有几个解"的**第二意见**：自己从 (w, h, groups, givens) 重建邻接与区域表，
// 不 import suguru.js 的任何规则或候选函数——两条路线只有共享了实现才可能一起错。
// 这里也不许有任何推理：一格的候选只用规则原文（同区域不重数、八邻不同数）当场判，
// 逐格深搜到底。慢是它的本职，快是 suguru.js 的事。
//
// 返回 {count, status}：status = ZERO / UNIQUE / MANY / OVERBUDGET。
// 出题器只接受 UNIQUE；OVERBUDGET 的候选盘一律淘汰，不"当作唯一"出货。

export function countSolutions(spec, { cap = 2, budget = 400_000 } = {}) {
  const { w, h, groups, givens } = spec;
  const size = w * h;

  // 自己建树：格 -> 同区格（不含自己）、格 -> 八邻（不含自己）、格 -> 区域长度
  const same = Array.from({ length: size }, () => []);
  const near = Array.from({ length: size }, () => []);
  const capOf = new Int8Array(size);
  for (const cells of groups) {
    for (const a of cells) {
      capOf[a] = cells.length;
      for (const b of cells) if (a !== b) same[a].push(b);
    }
  }
  for (let t = 0; t < size; t++) {
    const r = Math.floor(t / w);
    const c = t % w;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        near[t].push(rr * w + cc);
      }
    }
  }

  const val = Int8Array.from(givens);
  const blanks = [];
  for (let t = 0; t < size; t++) if (!val[t]) blanks.push(t);

  let count = 0;
  let nodes = 0;
  let out = 'UNIQUE';

  const fits = (t, v) => {
    for (const x of same[t]) if (val[x] === v) return false;
    for (const x of near[t]) if (val[x] === v) return false;
    return true;
  };

  const walk = (i) => {
    if (nodes > budget) return false;
    if (i === blanks.length) {
      count++;
      return count >= cap;
    }
    const t = blanks[i];
    for (let v = 1; v <= capOf[t]; v++) {
      nodes++;
      if (nodes > budget) return false;
      if (!fits(t, v)) continue;
      val[t] = v;
      const stop = walk(i + 1);
      val[t] = 0;
      if (stop) return true;
    }
    return false;
  };

  const hitCap = walk(0);
  if (nodes > budget) out = 'OVERBUDGET';
  else if (!hitCap && count === 0) out = 'ZERO';
  else if (count > 1) out = 'MANY';

  return { count, status: out, nodes, blanks: blanks.length };
}
