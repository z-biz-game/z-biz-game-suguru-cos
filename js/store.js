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

// 两段式解码。第一段只管"能不能 parse 成个东西"，第二段逐条清洗：
// 一条坏记录只丢那一条。原先是 `{...base, ...JSON.parse(raw)}` 那一类写法——
// localStorage 里躺着一条 `null`、或者 resume.size 是个字符串，就当场抛异常，
// 整个 Store 拿不到 data，玩家看到的是"页面白屏/按钮全哑"，而不只是"那次续局没了"。
function intInRange(v, min, max) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function nonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

// 和 nonNeg 的分别是"缺省"与"丢弃"：设置/累计值坏了回到 0 是合理的，但一条
// ms 是字符串的**纪录**被清洗成 ms=0，就等于凭空造出一个世界纪录并长期占住排名。
// 纪录的写入方（recordBest）只会写数字，所以这里严格到"必须是数字"。
function uint(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function saneSettings(s) {
  const base = defaults().settings;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return base;
  return {
    sound: typeof s.sound === 'boolean' ? s.sound : base.sound,
    reduceMotion: typeof s.reduceMotion === 'boolean' ? s.reduceMotion : base.reduceMotion,
  };
}

function saneTotals(t) {
  const base = defaults().totals;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return base;
  return { solved: nonNeg(t.solved), hints: nonNeg(t.hints), ms: nonNeg(t.ms) };
}

// 纪录是一条一档：某档那条坏了只丢那一档，其余档原样留着。
function saneBest(b) {
  const out = {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) return out;
  for (const [tier, rec] of Object.entries(b)) {
    if (typeof tier !== 'string' || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const ms = uint(rec.ms);
    const hints = uint(rec.hints);
    const moves = uint(rec.moves);
    if (ms === null || hints === null || moves === null) continue;
    out[tier] = {
      ms,
      hints,
      moves,
      score: Number.isFinite(rec.score) ? rec.score : 0,
      size: typeof rec.size === 'string' ? rec.size.slice(0, 16) : '',
      at: nonNeg(rec.at),
    };
  }
  return out;
}

const MAX_BOARD = 400; // 9×9 = 81，留足余量；越界一律当坏记录

function saneResume(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.seed !== 'string' || !r.seed || typeof r.tier !== 'string' || !r.tier) return null;
  const size = intInRange(r.size, 1, MAX_BOARD);
  if (size === null) return null;
  if (typeof r.ink !== 'string' || r.ink.length !== size) return null;
  return {
    seed: r.seed.slice(0, 128),
    tier: r.tier.slice(0, 32),
    size,
    ink: r.ink,
    elapsedMs: nonNeg(r.elapsedMs),
    moves: nonNeg(r.moves),
    hints: nonNeg(r.hints),
    at: nonNeg(r.at),
  };
}

function load() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(KEY));
  } catch {
    return defaults(); // 第一段：连 parse 都没过，只能从零开始
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults();
  return {
    settings: saneSettings(parsed.settings),
    best: saneBest(parsed.best),
    resume: saneResume(parsed.resume),
    totals: saneTotals(parsed.totals),
  };
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
