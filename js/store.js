// 存档。所有东西挂在同一个键下，所以"清空存档"是一行；一局进行中的对局存的是
// (原始 seed, 档位, 玩家写下的数, 这一局已经花掉的代价)，而不是题面或答案的副本——
// 生成器是确定性的，盘面从来不需要经过存储搬运，一盘 9×9 恢复起来只有几百字节。
//
// 代价（moves/hints/elapsedMs）必须跟着盘面一起存。少了它，"用六次提示推到一半、关页面、
// 回来收个 提示 0 的记录"就是合法操作，而记录排名的第一条正是"没要提示"。

const KEY = 'suguru.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// 一格就是一个 0..9 的数，所以一格记一个字符。游程编码在这里反而更大：中途盘面里的空场
// 被填数切成一段一段，每段都要"值+长度"两元，实测 25 格的盘 RLE 380B 而裸数组才 99B。
// 定长字符画不用长度字段，也不必防负数。
function inkEncode(cells) {
  let s = '';
  for (let i = 0; i < cells.length; i++) s += String(cells[i] > 9 ? 0 : cells[i]);
  return s;
}

function inkDecode(s, len) {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const v = (s.charCodeAt(i) || 48) - 48;
    b[i] = v >= 0 && v <= 9 ? v : 0;
  }
  return b;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* 隐私模式 / 配额超了 —— 游戏照样能玩，只是记不住事 */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // 记录先比"没要提示地推完了几步"，再比步数，最后才比时间：一条纪录要说的是"这盘是我自己
  // 想出来的"，靠六次提示换来的快局不是那件事。
  recordBest(tier, { ms, hints, moves, score, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, score, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, cells, elapsedMs, run) {
    this.data.resume = {
      // 生成器会从拿到的 seed 再派生内部 seed，所以存档必须带**原始** seed，
      // 否则重建出来的盘不是同一张。
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      size: puzzle.board.size,
      ink: inkEncode(cells),
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, cells: inkDecode(r.ink, r.size) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
