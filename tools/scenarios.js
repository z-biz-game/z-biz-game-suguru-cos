// 浏览器场景套件。由 tools/playtest.cjs 注入，跑在真页面上。
//
// 这里断言的东西只认一个标准：读 DOM、读几何、读 canvas 的像素，不读标志位。
// 一个 `.hidden === false` 说的是代码想要什么，一个 client rect 和一个像素说的才是玩家拿到了什么。
// 这个游戏里真正有趣的失败恰好是"状态对了，画面或点击错了"那一种：引擎里数字落对了、屏幕上
// 画成了别的区域的底色；点下去的格子偏了一格；提示说了句对的话但计数没涨。
//
// window.suguru.engine 就是页面自己 import 的那张模块图，所以在这里通过的铅笔路径，
// 和玩家按下"提示"时用的是同一个求解器——不是为测试留的第二份。
//
// 还有一条写测试时必须守住的规矩：不许出现"永远为真"的断言。ck(x, n >= 0) 这种句子在
// 什么都不坏的时候绿，在什么都坏了的时候也绿，它把绿灯的花费付掉了却什么也没买。凡是比大小、
// 比内容的，一律走 eq 或写成具体的区间。
//
// ck(名字, 条件, 详情) 是真假；eq(名字, 实得, 应为) 是相等。混用会让 ck('count', 0)
// 在人眼里是红的、在布尔值眼里是绿的。

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows 是拷贝不是别名：下面要清空它，留着活引用会交回一份"0 条失败"的空报告。
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.suguru;
  const E = () => w.suguru.engine;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => (($(sel) || {}).textContent || '').trim();
  const num = (sel) => Number(text(sel).split('/')[0].replace(/[^\d.-]/g, '')) || 0;
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const canvasBox = () => A().view.canvas.getBoundingClientRect();

  function firstBlankCell(b) {
    for (let t = 0; t < b.size; t++) if (!b.givens[t]) return t;
    return -1;
  }
  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  function at(t) {
    const r = A().view.cellRect(t);
    const box = canvasBox();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  }
  async function tap(t) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(24);
  }
  async function key(k) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await wait(16);
  }

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const near = (p, c, tol = 12) => p.length === 3 && c.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    // 取样点不落在整数格上就是调用方的前提坏了（at(undefined) 会一路 NaN 到 getImageData，
    // 那一条 TypeError 会把整个场景的行全丢掉）。这里退成 [-1,-1,-1]，让坏前提留下一条 FAIL。
    const px = Math.round(x * d);
    const py = Math.round(y * d);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return [-1, -1, -1];
    const p = v.ctx.getImageData(px, py, 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // 区域底色的取样点：靠格子里侧 20% 处。正中间会被数字踩到，贴着边会吃到区域粗边界。
  function fillPixel(t) {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size * 0.2, r.y + r.size * 0.2);
  }
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);

  // WCAG 相对亮度与对比度：可访问性那条不靠"看着还行"。
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  // ---------- engine：规则、验胜、候选、唯一解 ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createSuguru && en.verify && en.nextDeduction));
    eq('规则有四条', Object.keys(en.RULES).length, 4);
    eq('规则按权重从轻到重排', en.RULE_ORDER.join(','), 'only,last,squeeze,nishio');
    ck('每条规则都有名字、权重和一句话说明', Object.values(en.RULES).every((r) => r.name && r.weight > 0 && r.note));
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].band[1] > en.TIERS[i - 1].band[1])) ordered = false;
      if (!(en.TIERS[i].w > en.TIERS[i - 1].w)) ordered = false;
    }
    ck('档位按难度带与盘面同时递增', ordered, JSON.stringify(en.TIERS.map((t) => [t.w, t.band])));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');
    ck('budgetMs 是实测出来的正数（不是占位的 900）', en.TIERS.every((t) => t.budgetMs > 0 && t.budgetMs !== 900), JSON.stringify(en.TIERS.map((t) => t.budgetMs)));
    ck('avgCells 落在成率开关的可用区（4.6~6.2）', en.TIERS.every((t) => t.avgCells > 4.6 && t.avgCells < 6.2), JSON.stringify(en.TIERS.map((t) => t.avgCells)));

    // 规则原文数得出来的小盘：题面给两个数、第三格只剩一号那种。这里不自己编形状——
    // 3×3 按行分区**根本没有解**（每行中间那格与下一行三格全相邻，1..3 被别区占死），
    // 上一版在这里手写 [1,2,3/3,1,2/2,3,1] 当作正解，其实 (0,1)=2 与 (1,2)=2 就斜角撞了，
    // 于是 verify 说"不收"、contradiction 说"有矛盾"，全是盘的错不是引擎的错。盘的形状得先
    // 有解，才配当规则的例子，所以从最小的真实档拿一张盘，数字全由它自己给。
    const real = en.makePuzzle('scen|mini', 'trainee');
    ck('规则夹具用的是一张真实盘', !!real, 'trainee 出题失败');
    if (real) {
      const rb = real.board;
      const rs = real.solution;
      // 找一个空格当靶子：它所在区域要 ≥2 格，才谈得上"区里别的格把这格挤到只剩一号"。
      const X = Array.from({ length: rb.size }, (_, t) => t).find((t) => !rb.givens[t] && rb.glen[t] >= 2);
      ck('夹具靶子格找到了', X !== undefined, String(X));
      const truthExcept = Int8Array.from(rs);
      truthExcept[X] = 0;
      eq('角格有三格相邻', rb.adj[0].length, 3);
      eq('盘中间的格有八格相邻', rb.adj[rb.w + 1].length, 8);
      eq('每格的区域长度等于它所在区域的格数', rb.glen[X], rb.groups[rb.gid[X]].length);
      eq('题面只给提示时没有矛盾', en.contradiction(rb, rb.givens), null);
      eq('全盘按真值填完时矛盾检测闭嘴', en.contradiction(rb, rs), null);
      eq('独立验胜接受全盘自洽', en.verify(rb, Int8Array.from(rs)).ok, true);
      ck('真值之外只剩一格时，那格只剩一个候选', en.candidates(rb, truthExcept, X).join(',') === String(rs[X]), `${en.candidates(rb, truthExcept, X)} vs ${rs[X]}`);
      const Z0 = rb.adj[X].find((t) => t !== X);
      eq('已经填上的格不再谈候选', en.candidates(rb, truthExcept, Z0).join(','), '');
      // 一个提示都不给的盘上铅笔居然也能开口（反证会删掉"必要条件塌掉"的那些数），所以这里
      // 要的是它不许编：空盘上落下的每一个数都必须是真值。两头都要断言，只写"没错的有几个"
      // 在零次落子时永远为真。
      const bare = en.createState(rb, { cells: new Int8Array(rb.size) });
      let bclaims = 0;
      let bgood = 0;
      let bguard = 0;
      while (bguard++ < 200) {
        const d = en.nextDeduction(bare);
        if (!d || d.stalled) break;
        bclaims++;
        if (rs[d.cell] === d.value) bgood++;
        en.applyDeduction(bare, d);
      }
      ck('空盘上铅笔确实开了口', bclaims > 0, String(bclaims));
      eq('空盘上开口也不编数', bgood, bclaims);
      const st = en.createState(rb, { cells: truthExcept });
      const d1 = en.nextDeduction(st);
      eq('只剩一格时空着的那格被点名', d1 && `${d1.cell},${d1.value}`, `${X},${rs[X]}`);
      ck('点名的规则是补全区域那两条之一', !!d1 && (d1.rule.key === 'only' || d1.rule.key === 'last'), d1 && d1.rule.key);
      // 反例全部落在这张真实盘上：改一格、留一格、填一个区装不下的数、造一次邻格重数。
      const alt = Int8Array.from(rs);
      alt[X] = rs[X] === 1 ? 2 : 1;
      eq('改一格就被独立验胜驳回', en.verify(rb, alt).ok, false);
      eq('留一格不算赢', en.verify(rb, truthExcept).ok, false);
      eq('全空格不算赢', en.verify(rb, new Int8Array(rb.size)).ok, false);
      const over = Int8Array.from(rs);
      over[X] = rb.glen[X] === 9 ? 9 : rb.glen[X] + 1;
      eq('区域装不下的数被拒', en.verify(rb, over).ok, false);
      const Z = rb.adj[X].find((t) => t !== X);
      const clash = Int8Array.from(rs);
      clash[Z] = rs[X];
      const con = en.contradiction(rb, clash);
      ck('相邻两格同数时矛盾说得出是哪几格', !!con && con.cells.length >= 2, JSON.stringify(con));
      eq('同区重数也被独立验胜驳回', en.verify(rb, clash).ok, false);
    }

    // 出货盘：唯一解 + 铅笔推到底 + 每步与出题那盘同数 + 改一格就验胜失败。
    const perTier = {};
    const used = {};
    for (const t of en.TIERS) {
      const p = en.makePuzzle('scen|engine', t.key);
      ck(`${t.key} 出一局`, !!p);
      if (!p) continue;
      const b = p.board;
      eq(`${t.key} 盘面尺寸就是档位`, `${b.w}×${b.h}`, `${t.w}×${t.h}`);
      ck(`${t.key} 每格恰好属于一个区域`, b.gid.every((g) => g >= 0) && b.groups.reduce((a, g) => a + g.length, 0) === b.size);
      ck(`${t.key} 区域不超档位上限`, b.groups.every((g) => g.length >= 1 && g.length <= t.maxSize), JSON.stringify(b.groups.map((g) => g.length)));
      ck(`${t.key} 每个区域都是连通的`, b.groups.every((g) => {
        const seen = new Set([g[0]]);
        const q = [g[0]];
        while (q.length) {
          const x = q.shift();
          for (const n of b.adj[x]) {
            // 区域内部按共边算连通（共角不算）：grow() 就是按共边长的。
            const dx = Math.abs((n % b.w) - (x % b.w));
            const dy = Math.abs(((n / b.w) | 0) - ((x / b.w) | 0));
            if (dx + dy === 1 && b.gid[n] === b.gid[x] && !seen.has(n)) {
              seen.add(n);
              q.push(n);
            }
          }
        }
        return seen.size === g.length;
      }));
      let sound = true;
      let stalled = null;
      const st = en.createState(b);
      let guard = 0;
      while (guard++ < 4000) {
        const d = en.nextDeduction(st);
        if (!d) break;
        if (d.stalled) {
          stalled = d.why;
          break;
        }
        if (p.solution[d.cell] !== d.value) sound = false;
        en.applyDeduction(st, d);
      }
      ck(`${t.key} 铅笔不靠猜测就推到底`, !stalled, stalled);
      ck(`${t.key} 每一步都与出题那盘同数`, sound);
      eq(`${t.key} 推到底通过独立验胜`, en.verify(b, st.cells).ok, true);
      eq(`${t.key} 穷举计数判定唯一`, en.countSolutions(p.spec, { cap: 2, budget: 400000 }).status, 'UNIQUE');
      eq(`${t.key} 分数落在自己的带里`, p.score >= t.band[0] && p.score <= t.band[1], true);
      ck(`${t.key} 提示数少于盘面的三分之二`, p.clues <= Math.ceil(b.size * 0.66), `${p.clues}/${b.size}`);
      // 分数表必须和真走过的步对上：breakdown 加总就是步数，Σ 权重×次数就是分数。
      // （"每一条规则都得在某一档出场"是 tools/engine-test.mjs 的活——它按 6 张/档统计，
      // 没出场的还拿随机中途局面补探一轮。这里一次只出一张盘，不该冒充那个统计量。）
      let sum = 0;
      let recomputed = 0;
      for (const [k, n] of Object.entries(p.breakdown)) {
        ck(`${t.key} 计分表里只有规则表认识的键`, en.RULE_ORDER.includes(k), k);
        sum += n;
        recomputed += n * en.RULES[k].weight;
      }
      eq(`${t.key} 各规则次数之和等于步数`, sum, p.steps);
      ck(`${t.key} 分数就是 Σ 权重×次数`, Math.abs(recomputed - p.score) < 1e-9, `${recomputed} vs ${p.score}`);
      ck(`${t.key} 这一局真的用到过规则`, sum > 0, JSON.stringify(p.breakdown));
      for (const [k, n] of Object.entries(p.breakdown)) used[k] = (used[k] || 0) + n;
      // 每一格改一档都必须被独立验胜抓住：判胜不是"数凑够了就算"。
      let escapes = 0;
      for (let x = 0; x < b.size; x++) {
        for (const v of [st.cells[x] === 1 ? 2 : 1, 9]) {
          const cut = Int8Array.from(st.cells);
          cut[x] = v;
          if (en.verify(b, cut).ok) escapes++;
        }
      }
      eq(`${t.key} 改任何一格都过不了验胜`, escapes, 0);
      perTier[t.key] = { clues: p.clues, size: b.size, steps: p.steps, score: p.score };
    }
    // 五张盘合计不能只会一条规则：只会"只此一格"的阶梯，档位差别就只剩格子数了。
    ck('五张出货盘合计用到两条以上规则', Object.keys(used).length >= 2, JSON.stringify(used));
    return report({ perTier, used });
  };

  // ---------- gen：出题器的命中率、时延、确定性、阶梯 ----------

  const gen = async () => {
    const en = E();
    for (const key of ['trainee', 'regular', 'master']) {
      const spec = en.tierFor(key);
      const t0 = performance.now();
      const r = en.generate({ ...spec, seed: 'scen|gen' });
      const ms = performance.now() - t0;
      ck(`${key} generate 交出货盘`, r.ok === true, r.reason);
      ck(`${key} 出题在预算的 4 倍以内（浏览器里比 CI 慢就报出来）`, ms <= spec.budgetMs * 4, `${Math.round(ms)}ms vs ${spec.budgetMs}ms`);
      ck(`${key} 抽的次数没超 tries`, (r.drawn || 0) <= spec.tries, `${r.drawn}/${spec.tries}`);
      ck(`${key} stats 里没有超预算淘汰`, !r.stats.overbudget, JSON.stringify(r.stats));
    }
    // 同一个 seed 两张盘必须一模一样：存档只记 seed 的前提。
    const a = en.makePuzzle('determinism|scen', 'expert');
    const b = en.makePuzzle('determinism|scen', 'expert');
    eq('同 seed 的题面一致', Array.from(a.spec.givens).join(','), Array.from(b.spec.givens).join(','));
    eq('同 seed 的区域划分一致', JSON.stringify(a.spec.groups), JSON.stringify(b.spec.groups));
    const c = en.makePuzzle('other|scen', 'expert');
    ck('换 seed 会换一张盘', Array.from(c.spec.givens).join(',') !== Array.from(a.spec.givens).join(','));
    // 同 seed 两次同盘只证明了"这台引擎稳"。存档只记 seed，赌的是玩家换个浏览器回来还是那一盘，
    // 所以要拿 node 量出来的夹具在这儿重算一遍（tools/golden.mjs 的注释记着它抓到的那次事故）。
    // 夹具加载失败必须留下一行 FAIL：整个场景崩掉的话，别的断言会跟着一起消失。
    let golden = null;
    try {
      golden = await import(new URL('tools/golden.mjs', document.baseURI).href);
    } catch (e) {
      ck('跨引擎夹具能加载', false, String((e && e.message) || e));
    }
    if (golden) {
      for (const r of golden.goldenRows(en.makePuzzle)) ck(`${r.tier} 的 seed 在浏览器里画出夹具那张盘`, r.pass, r.detail);
    }
    // 难度阶梯：每档各出 6 局，中位数必须严格递增。
    const meds = en.TIERS.map((tt) => {
      const s = [];
      for (let k = 0; k < 6; k++) {
        const p = en.makePuzzle(`ladder|${k}`, tt.key);
        if (p) s.push(p.score);
      }
      return Math.round(med(s) * 10) / 10;
    });
    let up = true;
    for (let i = 1; i < meds.length; i++) if (!(meds[i] > meds[i - 1])) up = false;
    ck('五档中位数严格递增', up, meds.join(' < '));
    return report({ meds });
  };

  // ---------- play：点击、键盘、数字键盘、撤销 ----------

  const play = async () => {
    A().show('game');
    eq('开始一局', A().begin({ tier: 'trainee', seed: 'scen|play' }), true);
    await wait(60);
    const g = A().game;
    const b = g.board;
    ck('切到对局视图', shown('#view-game') && !shown('#view-menu'));
    eq('标题写了档位名', text('#stat-name'), g.puzzle.tierName);
    ck('canvas 有非零尺寸', canvasBox().width > 100, JSON.stringify({ w: canvasBox().width }));
    eq('干净盘面下状态条是空的', text('#state-line'), '');
    eq('数字键盘出了 9 个键', $$('#pad button').length, 9);
    eq('已填读数从题面提示数起步', text('#stat-filled'), `${g.diag.given}/${b.size}`);

    // 选中：点每一格的正中间，必须命中那一格。
    let misses = [];
    for (let t = 0; t < b.size; t++) {
      const p = at(t);
      const got = A().view.hitCell(p.x, p.y);
      if (got !== t) misses.push(`${t}->${got}`);
    }
    eq('每一格的点击命中都和自己对得上', misses.join(','), '');

    // 题面格不可改
    const gi = Array.from(b.givens).findIndex((v) => v > 0);
    const giv = b.givens[gi];
    A().select(gi);
    A().play(gi, giv === 1 ? 2 : 1);
    eq('题面给的格子改不动', g.st.cells[gi], giv);
    ck('改题面格会说清楚为什么', text('#state-line').includes('题面'), text('#state-line'));

    // 落子：选中一个空格，用键盘写一个候选内的数
    const free = firstBlankCell(b);
    await tap(free);
    eq('点击之后选中格更新', g.sel, free);
    const cands = g.candidatesAt(free);
    ck('选中格的候选非空', cands.length > 0, String(cands.length));
    await key(String(cands[0]));
    eq('键盘落子写进了引擎的 cells', g.valueOf(free), cands[0]);
    eq('落子记了一步', text('#stat-moves'), '1');
    eq('已填读数跟着走', text('#stat-filled'), `${g.diag.filled}/${b.size}`);
    ck('落子之后状态条不再挂着上一句拒绝', !text('#state-line').includes('题面'), text('#state-line'));

    // 再点同一个数 = 擦掉
    await key(String(cands[0]));
    eq('同一个数再写一次是擦掉', g.valueOf(free), 0);
    eq('擦掉也算一步', text('#stat-moves'), '2');
    // 撤销拿回擦掉
    ck('撤销有东西可撤', A().undo() !== null);
    eq('撤销把数写回去了', g.valueOf(free), cands[0]);
    eq('撤销把步数退回去', text('#stat-moves'), '1');
    ck('撤到底之后撤销说不', (() => {
      while (A().undo()) { /* 清空 steps */ }
      return A().undo() === null;
    })());

    // 方向键
    await tap(0);
    await key('ArrowRight');
    eq('方向键把选中格移右一格', g.sel, 1);
    await key('ArrowUp');
    eq('越界的方向键不会把选中格弄没', g.sel, 1);

    // 超范围的数：数字键盘禁用，键盘路径也得写不进去
    const small = Array.from({ length: b.size }, (_, t) => t).find((t) => b.glen[t] < 9 && !b.givens[t]);
    await tap(small);
    eq('超出所在区域格数的数字键被禁用', $(`#pad button[data-digit="9"]`).disabled, true);
    await key('9');
    eq('键盘也写不进超范围的数', g.valueOf(small), 0);
    ck('被拒时说的是范围而不是沉默', /最大只能填/.test(text('#state-line')), text('#state-line'));
    const glen = b.glen[small];
    eq('数字键盘的最大可用键等于区域格数', (() => {
      let last = 0;
      for (const btn of $$('#pad button')) if (!btn.disabled) last = Number(btn.dataset.digit);
      return last;
    })(), glen);
    // 换一局必须真的换一张盘。默认种子曾经是按日期算的（sg2026928），于是同一天连按两次
    // "换一局"交出的是同一张——按钮写着换，做的事是没换。这里连点两次真按钮，量盘面本身。
    // 指纹吃的是 puzzle（board.givens + solution），Game 上没有 solution 字段。
    const fp = (p) => Array.from(p.board.givens).join('') + '/' + Array.from(p.solution).join('');
    A().begin({ tier: 'trainee', seed: 'scen|newgame' });
    await wait(60);
    const beforeFp = fp(A().game.puzzle);
    $('#btn-new').click();
    await wait(60);
    const afterFp = fp(A().game.puzzle);
    ck('按 换一局 交出的是另一张盘', afterFp !== beforeFp, afterFp === beforeFp ? afterFp : '');
    // 随机只许发生在"挑种子"这一步：换出来的这张盘仍然要只凭 seed 重画得出来，
    // 否则"存档只记 seed"对新抽的盘不成立。
    const seed = A().Store.resume().seed;
    const again = A().engine.makePuzzle(seed, A().tier);
    ck('新种子写进了续局存档', String(seed).startsWith('sg|trainee|'), String(seed));
    ck('换出来的盘只凭 seed 就重画得出同一张', !!again && fp(again) === afterFp, String(seed));
    return report({ size: `${b.w}×${b.h}`, clues: g.diag.given });
  };

  // ---------- hint：提示有代价、说得出规则、能一个人把局推完 ----------

  const hint = async () => {
    A().Store.reset();
    A().begin({ tier: 'apprentice', seed: 'scen|hint' });
    await wait(60);
    const g = A().game;
    const p = g.puzzle;
    eq('提示计数从 0 开始', text('#stat-hints'), '0');
    const info = A().useHint();
    ck('提示给了东西', !!info && !info.stalled, JSON.stringify(info));
    eq('提示是有代价的一步', info.charged, true);
    eq('提示计数涨到 1', text('#stat-hints'), '1');
    eq('步数不被提示污染', text('#stat-moves'), '0');
    eq('提示写下的数就是出题那盘的数', p.solution[info.cell], info.value);
    eq('提示真的落到了盘上', g.valueOf(info.cell), info.value);
    const named = E().RULES[info.rule];
    ck('提示报的规则在规则表里', !!named, info.rule);
    ck('提示的说明点了格子的名', text('#hint-line').includes('第'), text('#hint-line'));
    eq('提示框标题写的是规则名', text('#hint-rule'), `规则 · ${named.name}`);
    ck('提示文字把为什么说了出来', text('#hint-line').includes(String(info.value)), text('#hint-line'));
    // why 自带句末句号，接线时又补了一个，屏幕上就是"。。所以那一格是 3。"。
    ck('提示那句话没有重复标点', !/。。|，，|、、/.test(text('#hint-line')), text('#hint-line'));
    eq('提示不重复自己：再按一次是下一步', (() => {
      const second = A().useHint();
      return second.cell !== info.cell || second.value !== info.value;
    })(), true);
    eq('脚本游标跟着走', g.cursor, 2);
    // 一路提示到收工：这是"零猜测"在产品层面的可玩证明。
    let guard = 0;
    while (g.status !== 'won' && guard++ < 4000) A().useHint();
    eq('提示能一个人把整局推完', g.status, 'won');
    ck('收工时独立验胜通过', E().verify(g.board, g.st.cells).ok);
    eq('推完的盘和出题那盘一模一样', Array.from(g.st.cells).join(','), Array.from(p.solution).join(','));
    eq('赢了再按提示不产生代价', A().useHint(), null);
    ck('胜利横幅出来了', shown('#win-veil'));
    ck('横幅报了用时与提示数', /用时.*提示/.test(text('#win-meta')), text('#win-meta'));
    ck('横幅里写着这一档的实测带', /\d+–\d+/.test(text('#win-meta')), text('#win-meta'));
    ck('写了这一档的纪录', !!A().Store.best('apprentice'));
    eq('赢了之后不再留存档', A().Store.resume(), null);
    // 提示次数应当正好等于出题时那条脚本的长度：不该有白花的提示。
    eq('提示次数等于脚本长度', g.hints, g.script.length);
    eq('提示次数等于出题时实测的步数', g.hints, p.steps);
    eq('脚本长度等于盘面空格数', g.script.length, b_size(g) - g.diag.given);
    return report({ hints: g.hints });
  };
  const b_size = (g) => g.board.size;

  // ---------- conflict：写错的数买不通提示，也过不了独立判胜 ----------

  const conflict = async () => {
    A().begin({ tier: 'trainee', seed: 'scen|conflict' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('开局没有矛盾', g.diag.conflicts, 0);
    eq('开局过不了独立验胜（还有空格）', E().verify(b, g.st.cells).ok, false);

    // 找一个"当下候选里合法、但当场就撞车"的落点：候选只保证不和本盘已填的数重复，它不保证
    // 这一步之后还走得通。实测这盘开局有 22 个"候选合法但数字错了"的落点，其中 9 个当场让
    // 某个数在区域里无处可去——挑这 9 个来测，红圈和标红的读数条才有东西可画。
    // （第一版挑的是遍历到的第一个错落点，它可能只是"暂时看不出错"，于是 diag.conflicts 是 0，
    // 下面的取样点拿到 undefined 格，整个场景连行都交不回来。）
    let target = -1;
    let wrong = 0;
    for (let t = 0; t < b.size && target < 0; t++) {
      if (b.givens[t]) continue;
      for (const v of g.candidatesAt(t)) {
        if (v === g.puzzle.solution[t]) continue;
        const probe = Int8Array.from(g.st.cells);
        probe[t] = v;
        if (E().contradiction(b, probe)) {
          target = t;
          wrong = v;
          break;
        }
      }
    }
    ck('存在候选合法但当场撞车的落点', target >= 0, String(target));
    A().select(target);
    A().play(target, wrong);
    eq('错的数写进了候选合法的那格', g.valueOf(target), wrong);
    eq('这一盘过不了独立验胜', E().verify(b, g.st.cells).ok, false);
    ck('盘面自己报了矛盾', g.diag.conflicts > 0, JSON.stringify(g.diag));
    ck('矛盾说明写成了人话', /相邻|区域|填不进|矛盾|必须/.test(text('#state-line')), text('#state-line'));
    eq('冲突读数条被标红', $('#stat-conflicts-row').classList.contains('bad'), true);
    const badCells = Array.from(g.diag.badCells);
    // 靶子要挑没被选中的那一格：选中格自己压着一圈同样粗细的琥珀框，在它身上量红圈，
    // 量到的很可能是框而不是圈。
    const bad0 = badCells.find((t) => t !== g.sel) ?? badCells[0];
    ck('矛盾格被描了一圈红（不只是换了软底色）', (() => {
      if (bad0 === undefined) return false;
      const e = hex(cssVar('--error'));
      // 取样必须用 cellRect 的画布局部坐标：at() 返回的是页面 client 坐标（加了 canvas 的
      // getBoundingClientRect 偏移），喂给 getImageData 会往盘外右下方向偏一整段，量到的永远是面板底色。
      const r = A().view.cellRect(bad0);
      const cell = A().view.geo.cell;
      // 沿上边往里扫一线：红圈的路径在 r.y+2 处、描边宽度由 cell 算出来，写死一个偏移会在格子
      // 变小或线宽变化时扫到软底色上。
      for (let dy = 0; dy <= cell * 0.25; dy += 1) {
        if (near(pixel(r.x + cell * 0.5, r.y + dy), e, 40)) return true;
      }
      return false;
    })(), `bad=${badCells} sel=${g.sel}`);
    // 提示不能附和这个错误：它要么点名这格必须是别的数，要么继续说题面强制的那一步。
    const before = g.hints;
    const h = A().useHint();
    ck('提示对着错盘仍然说话', !!h, JSON.stringify(h));
    if (h && h.conflict) {
      ck('提示直接点名那格必须是几', h.conflict.includes('必须'), h.conflict);
      eq('指出矛盾的那次提示不收费', g.hints, before);
    } else if (h && h.charged) {
      eq('提示写下的数仍是正解的数', g.puzzle.solution[h.cell], h.value);
      ck('提示落子的格子本身没有矛盾', !g.diag.badCells.has(h.cell));
    }
    // 一直撤到那一格回空：撤销必须能把错手完整退回去。
    let spins = 0;
    while (g.valueOf(target) !== 0 && spins++ < 50) A().undo();
    eq('撤销把那格擦回空', g.valueOf(target), 0);
    eq('擦回空之后矛盾清零', g.diag.conflicts, 0);
    eq('回到空盘之后独立验胜仍然不通（还没填完）', E().verify(b, g.st.cells).ok, false);
    return report({ target, wrong });
  };

  // ---------- save：存档形状、体积、代价一起走 ----------

  const save = async () => {
    A().Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    for (const row of g.script.slice(0, 6)) {
      A().select(row.cell);
      A().play(row.cell, row.value);
    }
    for (let i = 0; i < 3; i++) A().useHint();
    const r = A().Store.resume();
    ck('落过子之后有存档', !!r);
    eq('存档记的是原始 seed', r.seed, g.puzzle.originSeed);
    eq('存档记了档位', r.tier, 'regular');
    ck('存档里格数等于盘面（解码后长度对得上）', r.cells.length === b.size, `${r.cells.length} vs ${b.size}`);
    eq('存档把玩家写的数原样带上', Array.from(r.cells).join(','), Array.from(g.st.cells).join(','));
    eq('存档把提示数带上', r.hints, g.hints);
    eq('存档把步数带上', r.moves, g.moves);
    ck('存档记了用时（不为负）', r.elapsedMs >= 0, String(r.elapsedMs));
    const bytes = JSON.stringify(A().Store.data).length;
    const saved = JSON.parse(localStorage.getItem('suguru.save.v1'));
    const inkBytes = JSON.stringify(saved.resume.ink).length;
    const naive = JSON.stringify(Array.from(g.st.cells)).length;
    ck('整份存档在 2KB 以内', bytes < 2048, `${bytes}B`);
    // 同一个盘面、同一种 JSON 编码，把两种形状摆在一起比才是证据：整份存档 vs 单一个数组
    // 那种比法会把"设置/记录也在里面"算成盘面的开销，游程编码就是这么被吹成省的一次。
    ck('盘面一格一字符确实比裸数组省', inkBytes < naive, `${inkBytes}B vs ${naive}B`);
    eq('盘面串的长度就是格数', saved.resume.ink.length, b.size);
    // 题面与答案都不许进存档：只记 seed 是这套存档能只有几百字节的原因。
    const raw = JSON.stringify(A().Store.data);
    ck('存档里没有塞题面数组', !raw.includes('"givens"'));
    ck('存档里没有塞正解数组', !raw.includes('"solution"'));
    eq('存档只有一个键', Object.keys(JSON.parse(localStorage.getItem('suguru.save.v1'))).sort().join(','), 'best,resume,settings,totals');
    return report({ bytes, naive, inkBytes });
  };

  // ---------- resume：回选档 → 继续，代价与盘面都回来 ----------

  const resume = async () => {
    A().Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(60);
    const g0 = A().game;
    for (const row of g0.script.slice(0, 7)) {
      A().select(row.cell);
      A().play(row.cell, row.value);
    }
    A().useHint();
    A().useHint();
    const snap = {
      cells: Array.from(g0.st.cells).join(','),
      seed: g0.puzzle.originSeed,
      moves: g0.moves,
      hints: g0.hints,
      givens: g0.diag.given,
    };
    A().show('menu');
    ck('回选档时挂出了"未完成"', shown('#resume-card'));
    ck('续局卡片报了档位', text('#resume-name').includes('高阶'), text('#resume-name'));
    ck('续局卡片把代价报了出来', /提示 \d+ · 步 \d+/.test(text('#resume-meta')), text('#resume-meta'));
    A().begin({ resume: true });
    await wait(60);
    const g1 = A().game;
    eq('恢复出来的盘是同一张', g1.puzzle.originSeed, snap.seed);
    eq('恢复出的盘面数字一模一样', Array.from(g1.st.cells).join(','), snap.cells);
    eq('恢复后步数没被洗掉', g1.moves, snap.moves);
    eq('恢复后提示数没被洗掉', g1.hints, snap.hints);
    eq('恢复后读数条也带上了', text('#stat-hints'), String(snap.hints));
    eq('恢复后题面提示数不变', g1.diag.given, snap.givens);
    ck('恢复之后题面给的数仍在原位', g1.st.cells.every((v, i) => (g1.board.givens[i] ? v === g1.board.givens[i] : true)));
    ck('恢复之后已经填的格子没丢', g1.diag.filled >= snap.givens + 7);
    const before = g1.hints;
    A().useHint();
    eq('恢复之后提示照样计费', g1.hints, before + 1);
    // 换一局之后旧存档要被新盘接上，而不是留下两条互相打架的续局。
    A().newGame('scen|resume-2');
    await wait(40);
    eq('换一局会覆盖续局', A().Store.resume().seed, 'scen|resume-2');
    // 走玩家那条路：回选档 → 按「清空存档」。清空必须说得出口"没有未完成这回事"，
    // 只清存储的话，手里这局会在下一次导航时被写回存档，卡片又自己立起来。
    A().show('menu');
    A().clearSave();
    await wait(20);
    eq('清空存档后续局卡片收起', shown('#resume-card'), false);
    eq('清空存档之后续局数据真的没了', A().Store.resume(), null);
    return report({ moves: snap.moves, hints: snap.hints });
  };

  // ---------- layout：几何、像素、令牌、窄屏 ----------

  const layout = async () => {
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(80);
    const v = A().view;
    const b = A().game.board;
    const box = canvasBox();
    const stage = $('#board-wrap').parentElement.getBoundingClientRect();
    ck('盘面没撑破容器', box.width <= stage.width + 1, `${box.width} vs ${stage.width}`);
    ck('盘面没超出视口', box.right <= window.innerWidth + 1 && box.left >= 0, JSON.stringify({ l: box.left, r: box.right, iw: window.innerWidth }));
    ck('格子不小于可读下限', v.geo.cell >= E().Cell.min, String(v.geo.cell));
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    eq('DPR 写进了几何', v.geo.dpr, dpr);
    eq('缓冲宽度等于 CSS 宽 × DPR', v.canvas.width, Math.round(box.width * dpr));
    eq('缓冲高度等于 CSS 高 × DPR', v.canvas.height, Math.round(box.height * dpr));

    // 区域底色真的画出来了：每格取样点必须等于它那一档色号。
    let mismatch = [];
    const seen = new Set();
    for (let t = 0; t < b.size; t++) {
      const want = hex(E().Regions[v.tint[b.gid[t]] % E().Regions.length]);
      if (!near(fillPixel(t), want, 8)) mismatch.push(`${t}:${fillPixel(t)}!=${want}`);
      seen.add(E().Regions[v.tint[b.gid[t]] % E().Regions.length]);
    }
    eq('每一格的区域底色都画对了', mismatch.join(' '), '');
    ck('一张大师盘上至少出现四种区域色', seen.size >= 4, String(seen.size));
    // 贴着的区域不同色：底色不承载规则，但同色贴边等于在画面上多留一个疑问。
    let tintTouch = 0;
    for (let t = 0; t < b.size; t++) {
      for (const n of b.adj[t]) if (b.gid[n] !== b.gid[t] && v.tint[b.gid[t]] === v.tint[b.gid[n]]) tintTouch++;
    }
    eq('贴着的区域不会同色', tintTouch, 0);

    // 跨区域边界必须真的画了线：沿边界取样，两侧底色都得不上。
    // 取样点也要躲开选中框——琥珀框压在边界上，"对不上两侧底色"会因为框而假绿。
    const g0 = A().game;
    let pair = null;
    for (let t = 0; t < b.size && !pair; t++) {
      const c = t % b.w;
      if (c + 1 >= b.w || b.gid[t + 1] === b.gid[t]) continue;
      if (t === g0.sel || t + 1 === g0.sel || g0.diag.badCells.has(t) || g0.diag.badCells.has(t + 1)) continue;
      pair = [t, t + 1];
    }
    ck('盘上存在左右相邻的异区域', !!pair);
    if (pair) {
      const r = v.cellRect(pair[0]);
      const onBorder = pixel(r.x + r.size, r.y + r.size * 0.5);
      ck('跨区域边界画的线两侧底色都对不上', !near(onBorder, fillPixel(pair[0]), 20) && !near(onBorder, fillPixel(pair[1]), 20), JSON.stringify(onBorder));
      const sameRow = (() => {
        // 靶子要躲开选中格：那圈琥珀方框就画在格的边上，取样点正好压在框上，量到的是
        // 选中态而不是内部细线（第一版就是这么把一条对的断言读成红的）。
        const g = A().game;
        for (let t = 0; t < b.size; t++) {
          const c = t % b.w;
          if (c + 1 >= b.w || b.gid[t + 1] !== b.gid[t]) continue;
          if (t === g.sel || t + 1 === g.sel || g.diag.badCells.has(t) || g.diag.badCells.has(t + 1)) continue;
          return [t, t + 1];
        }
        return null;
      })();
      ck('盘上存在同区域的相邻格', !!sameRow);
      if (sameRow) {
        const rr = v.cellRect(sameRow[0]);
        const inner = pixel(rr.x + rr.size, rr.y + rr.size * 0.5);
        ck('同区域内部只画细线（跟底色接近）', near(inner, fillPixel(sameRow[0]), 40), JSON.stringify({ inner, fill: fillPixel(sameRow[0]) }));
      }
    }

    // 颜色不是唯一载体：数字本身必须是高对比的墨色，且画在格子正中。
    const gi = Array.from(b.givens).findIndex((x) => x > 0);
    const rp = v.cellRect(gi);
    let ink = null;
    for (let dy = -0.2; dy <= 0.2 && !ink; dy += 0.02) {
      for (let dx = -0.12; dx <= 0.12 && !ink; dx += 0.02) {
        const p = pixel(rp.x + rp.size * (0.5 + dx), rp.y + rp.size * (0.5 + dy));
        if (near(p, hex(cssVar('--ink')), 26)) ink = p;
      }
    }
    ck('题面的数用高对比墨色画在格子正中', !!ink, String(ink));

    // 样式表和 canvas 用的是同一批令牌。
    eq('样式表里的墨色令牌来自主题', cssVar('--ink').toUpperCase(), '#F2F5FB');
    eq('区域底色令牌数与主题一致', E().Regions.length, 6);
    for (let i = 0; i < E().Regions.length; i++) {
      eq(`区域底色令牌 ${i} 落到了样式表`, cssVar(`--region-${i}`).toUpperCase(), E().Regions[i].toUpperCase());
      const cInk = contrast(hex(cssVar('--ink')), hex(E().Regions[i]));
      const cPlayer = contrast(hex(cssVar('--player')), hex(E().Regions[i]));
      ck(`墨色压在区域底色 ${i} 上 ≥ 4.5:1`, cInk >= 4.5, cInk.toFixed(2));
      ck(`玩家数字的琥珀色压在区域底色 ${i} 上 ≥ 4.5:1`, cPlayer >= 4.5, cPlayer.toFixed(2));
    }
    const cBg = contrast(hex(cssVar('--ink')), hex(cssVar('--surface')));
    ck('正文压在面板上 ≥ 7:1（AAA）', cBg >= 7, cBg.toFixed(2));
    // 粗边界是"这几格是一块"的唯一载体，所以六块底色上最低的这一块也得有 3:1；齐了的区域换
    // 绿色，那是同一个载体在另一种状态下，标准不能降低——两种颜色都得过。
    for (const [label, col] of [['常态', cssVar('--line-heavy')], ['齐了的绿', cssVar('--success')]]) {
      const worst = E().Regions.map((r) => ({ r, c: contrast(hex(r), hex(col)) })).sort((a, b) => a.c - b.c)[0];
      ck(`区域粗边界（${label}）压在六块底色上最低也 ≥ 3:1`, worst.c >= 3, `${worst.c.toFixed(2)} 在 ${worst.r} vs ${col}`);
    }

    // 窄屏：把 #app 的 max-width 改窄测的不是窄屏，是生产里不存在的一种形状——媒体查询、resize
    // 事件、栅格列数看的都是**视口**宽度，只改容器等于要求 320px 里塞下两列（一侧还 min 268px）。
    // 所以把整个应用装进一个 320px 的同源 iframe：那才是一台窄屏手机拿到的东西。
    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'narrow-viewport');
    frame.style.cssText = 'width:320px;height:760px;border:0;position:fixed;left:0;top:0';
    document.body.appendChild(frame);
    try {
      await new Promise((res, rej) => {
        frame.onload = res;
        frame.src = document.baseURI;
        setTimeout(() => rej(new Error('iframe 没在 8s 内加载完')), 8000);
      }).catch((e) => ck('窄屏 iframe 能加载', false, String(e && e.message)));
      await wait(160);
      const iwin = frame.contentWindow;
      const idoc = frame.contentDocument;
      ck('窄屏里应用真的启动了', !!(iwin && iwin.suguru));
      if (iwin && iwin.suguru) {
        iwin.suguru.begin({ tier: 'master', seed: 'scen|narrow' });
        await wait(160);
        const cols = iwin.getComputedStyle(idoc.querySelector('#view-game')).gridTemplateColumns.split(' ').length;
        ck('窄屏里对局视图收成了单列（媒体查询真的生效）', cols === 1, String(cols));
        const sw = idoc.documentElement.scrollWidth;
        ck('320px 视口里页面不横向溢出', sw <= iwin.innerWidth + 2, `${sw} > ${iwin.innerWidth}`);
        const ir = idoc.querySelector('#board').getBoundingClientRect();
        ck('320px 视口里画布完整落在视口内', ir.left >= -1 && ir.right <= iwin.innerWidth + 1, `${Math.round(ir.left)}…${Math.round(ir.right)} / ${iwin.innerWidth}`);
        ck('320px 视口里格子仍然不小于可读下限', iwin.suguru.view.geo.cell >= E().Cell.min, String(iwin.suguru.view.geo.cell));
      }
    } finally {
      frame.remove();
    }
    return report({ cell: v.geo.cell, tints: seen.size });
  };

  // ---------- a11y：读屏、键盘、焦点、开关 ----------

  const a11y = async () => {
    A().begin({ tier: 'trainee', seed: 'scen|a11y' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const cv = A().view.canvas;
    eq('canvas 可以聚焦', cv.tabIndex, 0);
    ck('canvas 有说明性的 aria-label', (cv.getAttribute('aria-label') || '').length > 8);
    eq('状态条是 aria-live=polite', $('#state-line').getAttribute('aria-live'), 'polite');
    eq('读屏格位播报也是 aria-live=polite', $('#sr-cell').getAttribute('aria-live'), 'polite');
    const free = firstBlankCell(b);
    await tap(free);
    const said = text('#sr-cell');
    const row = ((free / b.w) | 0) + 1;
    const col = (free % b.w) + 1;
    ck('选中一格会念出行列', said.includes(`第${row}行第${col}列`), said);
    ck('念出所在区域的格数', said.includes(`${b.glen[free]} 格区域`), said);
    const cands = E().candidates(b, g.st.cells, free);
    ck('念出的候选就是引擎算的那批', said.includes(cands.join('、')), `${said} vs ${cands}`);
    ck('说明白这是空格里能填什么', said.includes('还能填'), said);
    const filledBefore = g.diag.filled;
    await key(String(cands[0]));
    eq('落子之后已填数 +1', g.diag.filled, filledBefore + 1);
    ck('落子后播报改口说当前值', text('#sr-cell').includes(`数 ${cands[0]}`), text('#sr-cell'));
    await tap(free);
    ck('题面格被念成"题面给的"', (() => {
      const gi = Array.from(b.givens).findIndex((x) => x > 0);
      A().select(gi);
      return text('#sr-cell').includes('题面给的');
    })(), true);

    // 只用键盘与提示走完一局（不碰指针）。
    A().begin({ tier: 'trainee', seed: 'scen|a11y-kbd' });
    await wait(60);
    let guard = 0;
    while (A().game.status !== 'won' && guard++ < 4000) {
      const h = A().useHint();
      if (!h || !h.charged) break;
    }
    eq('只用键盘与提示也能收工', A().game.status, 'won');
    ck('收工后横幅可以靠 Enter 关掉', (() => {
      $('#btn-again').focus();
      return document.activeElement === $('#btn-again');
    })(), true);

    // 焦点可见。
    cv.focus();
    const st = getComputedStyle(cv);
    ck('聚焦的盘面有可见轮廓', parseFloat(st.outlineWidth) >= 2 || st.outlineStyle !== 'none', `${st.outlineStyle} ${st.outlineWidth}`);
    $('#btn-hint').focus();
    ck('按钮聚焦也有轮廓', parseFloat(getComputedStyle($('#btn-hint')).outlineWidth) >= 2, getComputedStyle($('#btn-hint')).outlineWidth);
    eq('无名按钮为 0', $$('button').filter((x) => !(x.textContent || '').trim() && !x.getAttribute('aria-label')).length, 0);
    eq('数字键盘有组名', $('#pad').getAttribute('aria-label'), '数字');
    ck('数字键有 aria-pressed 状态', $$('#pad button').every((x) => x.hasAttribute('aria-pressed')));
    // 按下态要用**当下这局**的格子查：上一段已经换过两局，拿旧 game 的读数去对新盘的
    // 选中格，读到的是别的数字（第一版就是这么把一条对的实现读成红的）。
    A().begin({ tier: 'regular', seed: 'scen|a11y-pad' });
    await wait(60);
    const pg = A().game;
    const pcell = firstBlankCell(pg.board);
    await tap(pcell);
    const pc = E().candidates(pg.board, pg.st.cells, pcell);
    A().play(pcell, pc[0]);
    eq('落子的数字键亮成按下态', $(`#pad button[data-digit="${pc[0]}"]`).getAttribute('aria-pressed'), 'true');
    eq('同一时刻只有那一个数字键是按下态', $$('#pad button').filter((x) => x.getAttribute('aria-pressed') === 'true').map((x) => x.dataset.digit).join(','), String(pc[0]));
    A().play(pcell, 0);
    eq('擦回空之后没有任何键亮着按下态', $$('#pad button').filter((x) => x.getAttribute('aria-pressed') === 'true').length, 0);

    // 动效开关：关掉之后不再自动抹掉提示脉冲，但文字已经把话说完。
    A().begin({ tier: 'regular', seed: 'scen|a11y-motion' });
    await wait(40);
    $('#btn-motion').click();
    await wait(20);
    eq('动效开关关掉的是真实状态', document.body.classList.contains('reduce-motion'), true);
    eq('动效开关写进了存档', A().Store.setting('reduceMotion'), true);
    A().useHint();
    ck('关动效时提示仍然写清了那一格', text('#hint-line').length > 6, text('#hint-line'));
    $('#btn-motion').click();
    await wait(20);
    eq('动效开关能切回来', document.body.classList.contains('reduce-motion'), false);
    // 音效开关同样落在真实状态上（AudioContext 在 headless 里可能没有，只查开关链路）。
    $('#btn-sound').click();
    eq('音效开关切到关', A().Store.setting('sound'), false);
    eq('音效按钮文案跟着改', text('#btn-sound'), '音效 关');
    $('#btn-sound').click();
    eq('音效开关切回开', A().Store.setting('sound'), true);
    // 清空存档是一行：所有派生状态都得回到初始。
    A().begin({ tier: 'trainee', seed: 'scen|a11y-reset' });
    await wait(40);
    A().useHint();
    $('#btn-reset').click();
    await wait(20);
    eq('清空存档后纪录没了', Object.keys(A().Store.data.best).length, 0);
    eq('清空存档后续局没了', A().Store.resume(), null);
    return report({});
  };

  // ---------- pause ----------
  //
  // #btn-pause 与 #btn-fullscreen 都是真控件：js/main.js:90 的 setPaused 真的把 startedAt 清零，
  // js/main.js:670 的 bindFullscreen 真的绑在顶栏那颗按钮上。按钮的 title 写着「暂停 / 继续 (P 或
  // Space)」，全屏那颗写着「全屏（F）」——原先十场里没有一场点过这两颗，也没有一场按过这三个键，
  // 所以这几句话在整个仓里没有任何一处代码为它们担保。这一场就是它们的台架。
  const pause = async () => {
    const a = A() || {};
    // 控件改名不许把整场吃成 0 条：拿一颗游离替身接住空 id，让每一条红都点出自己的名字，
    // 而不是在第一次 .click() 上抛 TypeError、后面几十条一起没跑。
    const STAND_IN = document.createElement('button');
    const el = (id) => document.getElementById(id) || STAND_IN;
    const lab = (id) => {
      const b = el(id);
      return {
        text: (b.textContent || '').trim(),
        pressed: b.getAttribute('aria-pressed'),
        title: b.getAttribute('title') || '',
        aria: b.getAttribute('aria-label') || '',
        disabled: !!b.disabled,
      };
    };
    const errs = [];
    const onErr = (e) => errs.push(String((e && (e.message || e.reason)) || e));
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onErr);
    const key = (k) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    // 名册与「按钮有名字」两条只读 DOM，所以排在需要 surface 的判据之前：app 死在启动阶段时它们仍然点得出名字。
    const topIds = $$('.top-actions button').map((b) => b.id).join(',');
    eq('pause: 顶栏按钮名册逐字对上（顺序、条数、id 全算）', topIds, 'btn-pause,btn-sound,btn-motion,btn-fullscreen');
    const nameless = ['btn-pause', 'btn-sound', 'btn-motion', 'btn-fullscreen'].filter((id) => {
      const l = lab(id);
      return !l.text && !l.title && !l.aria;
    });
    ck('pause: 顶栏四颗按钮每一颗都有玩家读得出来的名字（文字 / title / aria-label 至少一样）',
      nameless.length === 0, nameless.join(','));

    if (typeof a.simClock !== 'function' || typeof a.begin !== 'function' || typeof a.setPaused !== 'function') {
      ck('pause: 暂停那张脸在（window.suguru 的 simClock / begin / setPaused 读得到）', false,
        `surface=${typeof a.simClock}/${typeof a.begin}/${typeof a.setPaused}`);
      return report({ fatal: 'no surface' });
    }
    const started = a.begin({ tier: 'trainee', seed: 'scen|pause' });
    await wait(60);
    if (!started || !a.game) {
      ck('pause: 出得了盘（begin 返回真且 window.suguru.game 在）', false, `begin=${started}`);
      return report({ fatal: 'no board' });
    }

    const advance = async (ms) => { const t0 = a.simClock(); await wait(ms); return a.simClock() - t0; };
    // 先要「在走」，否则「停下来」是一句空话：一张从没跑过的表，暂停前后都是 0。
    const running = await advance(320);
    ck('pause: 没暂停时时钟在走（320 ms 的等待至少推进 150 ms）', running >= 150, `Δ=${running}`);
    const start0 = lab('btn-pause');
    eq('pause: 开局按钮写着「暂停」、没被按下', `${start0.text}/${start0.pressed}`, '暂停/false');
    ck('pause: 按钮的 title 把键位说给玩家听（「暂停 / 继续 (P 或 Space)」）',
      /P 或 Space/.test(start0.title), start0.title);

    el('btn-pause').click();
    await wait(40);
    const on1 = lab('btn-pause');
    eq('pause: 点一下之后按钮改口「继续」、aria-pressed 变真', `${on1.text}/${on1.pressed}`, '继续/true');
    const frozen = await advance(700);
    eq('pause: 暂停把时钟冻死（700 ms 之后 Δ 恰好是 0，不是「变慢了」）', frozen, 0);
    ck('pause: 界面冻住的那一刻引擎自己也说在暂停（按钮不是只改了个文字）', a.paused === true, `paused=${a.paused}`);

    // 恢复那一瞬最坏的坏法是把暂停期间的墙钟一次性灌进来：表从 12 s 跳到 19 s。上界只按跳幅判、
    // 不按速度预算判——setTimeout 从不提前，机器慢只会让等待更长，罚的是机器而不是代码。
    const atUnpause = a.simClock();
    el('btn-pause').click();
    const jump = a.simClock() - atUnpause;
    ck('pause: 恢复的第一帧不倒灌暂停期间的墙钟（刚才冻了 700 ms，跳幅必须远小于它）', jump < 200, `松手瞬间跳了 ${jump} ms`);
    eq('pause: 松开之后按钮回到「暂停」、aria-pressed 回假', `${lab('btn-pause').text}/${lab('btn-pause').pressed}`, '暂停/false');
    const resumed = await advance(220);
    ck('pause: 恢复后时钟重新按墙钟走（不是一句只改了标签的假恢复）', resumed >= 50, `Δ=${resumed}`);

    // title 里那两个键位是给用户看的承诺：P 与 空格 都得真的停表 / 松开表，而不是只改文字。
    key('p');
    await wait(40);
    const onP = lab('btn-pause');
    ck('pause: 按 P 真的停表（按钮改口「继续」，引擎也说在暂停）',
      a.paused === true && onP.text === '继续' && onP.pressed === 'true',
      `paused=${a.paused} ${onP.text}/${onP.pressed}`);
    const frozenP = await advance(300);
    eq('pause: P 停住之后 300 ms 里表一动不动', frozenP, 0);
    key(' ');
    await wait(40);
    const offSpace = lab('btn-pause');
    ck('pause: 按 空格 真的松开（title 写的是「P 或 Space」，不是只有 P）',
      a.paused === false && offSpace.text === '暂停' && offSpace.pressed === 'false',
      `paused=${a.paused} ${offSpace.text}/${offSpace.pressed}`);
    const afterSpace = await advance(220);
    ck('pause: 空格松开之后表接着走', afterSpace >= 50, `Δ=${afterSpace}`);

    // js/main.js:340-341 那句注释承诺「换一局＝新的一局，新局一定在走」。这一条就是它的台架：
    // 带着暂停换一局，newGame 若不解暂停，界面会显示「继续」而表一动不动——按钮与时钟各说各话。
    el('btn-pause').click();
    await wait(30);
    const g2 = a.newGame('scen|pause-new', a.tier);
    await wait(60);
    const afterNew = { begun: !!g2, text: lab('btn-pause').text, pressed: lab('btn-pause').pressed, flag: a.paused, moved: await advance(300) };
    ck('pause: 暂停中换一局，新局一定在走（按钮与时钟不许各说各话）',
      afterNew.begun && afterNew.text === '暂停' && afterNew.pressed === 'false' && afterNew.flag === false && afterNew.moved > 0,
      JSON.stringify(afterNew));

    // 全屏：两种结局都要有说法。headless Chrome 里 requestFullscreen 要一次真实的用户激活，而
    // 不在最上层的标签页 hasFocus() 为 false、会被直接拒——所以 tools/playtest.cjs 给 scenario
    // 那次求值带 userGesture 并先 bringToFront；走的是哪一支由报告里的 fs 字段点名。
    const fsBtn = el('btn-fullscreen');
    const w0 = innerWidth;
    const fsBefore = lab('btn-fullscreen');
    ck('pause: 全屏按钮开局可点、写着「全屏」、title 说了键位 F',
      !fsBefore.disabled && fsBefore.text === '全屏' && /F/.test(fsBefore.title),
      `${fsBefore.text}/${fsBefore.disabled}/${fsBefore.title}`);
    const inFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
    fsBtn.click();
    await wait(400);
    let fs = 'unsupported';
    if (inFs()) {
      fs = 'entered';
      const on = lab('btn-fullscreen');
      ck('pause: 进全屏之后按钮标成按下、文字改成「退出全屏」', on.pressed === 'true' && on.text === '退出全屏', `${on.text}/${on.pressed}`);
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      ck('pause: 全屏没有撑出横向滚动', overflow <= 1, `溢出 ${overflow} px`);
      const br = el('board-wrap').getBoundingClientRect();
      ck('pause: 全屏里棋盘整个在视口内',
        br.left >= -1 && br.top >= -1 && br.right <= innerWidth + 1 && br.bottom <= innerHeight + 1,
        `[${Math.round(br.left)},${Math.round(br.top)}] ${Math.round(br.width)}×${Math.round(br.height)} 视口 ${innerWidth}×${innerHeight}`);
      fsBtn.click();
      await wait(400);
      const off = lab('btn-fullscreen');
      ck('pause: 再点一次是退出全屏，不是「再进一次」', !inFs(), '还在全屏里');
      eq('pause: 退出后按钮文字回到「全屏」', off.text, '全屏');
      eq('pause: 退出后 aria-pressed 回假', off.pressed, 'false');
      ck('pause: 退出后 body 上的 fullscreen 类摘掉', !document.body.classList.contains('fullscreen'), [...document.body.classList].join(' '));
      // title 写着「全屏（F）」，js/main.js:724 真的绑了 F 键（`ev.key !== 'f' && ev.key !== 'F'`
      // 才 return，命中后 main.js:729 走 `ev.preventDefault()` 再 `toggle()`）。
      //
      // 这里**不**断言「按 F 之后进了全屏」：`key()` 派的是页内合成 KeyboardEvent，
      // 而 Chrome 只给**瞬时用户激活**过的脚本 `requestFullscreen()`。本场前面那次按钮
      // 点击已经把这份额度用掉了，于是合成 F 触发的 requestFullscreen() 被拒——
      // 那是 headless 的授权限制，不是产品缺陷（上一版这条判红就是这么来的，
      // 差点被当成「F 键没绑」的真缺陷）。
      //
      // 所以改成断言**绑定确实响应**：handler 命中就会 preventDefault，没绑就原样放过。
      // 这个判据不依赖 Chrome 的授权策略，因此是真判据；「真人按 F 能进全屏」要靠
      // 真的键盘输入验（`Input.dispatchKeyEvent`），本闸不具备那条通路，如实记账。
      const fHandled = (() => {
        const ev = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
        document.body.dispatchEvent(ev);
        return ev.defaultPrevented;
      })();
      ck('pause: F 键的处理器确实响应（title 里那句键位不是装饰）', fHandled,
        '合成 F 事件未被 main.js 的 handler 消费（defaultPrevented 仍为 false）');
      ck('pause: 合成按键不冒充玩家输入（没绑的键不该被消费，对照组）',
        !(() => {
          const ev = new KeyboardEvent('keydown', { key: 'Q', bubbles: true, cancelable: true });
          document.body.dispatchEvent(ev);
          return ev.defaultPrevented;
        })(), '一个没绑的键也被 preventDefault 了，说明这条判据量不出绑定');
    } else {
      const off = lab('btn-fullscreen');
      ck('pause: 进不去全屏时给一句人话理由（禁用 + title 说清为什么）',
        off.disabled === true && /主屏幕|不提供/.test(off.title), `disabled=${off.disabled} title=${off.title}`);
      ck('pause: 被拒绝的时候不假装按下', off.pressed !== 'true', `${off.text}/${off.pressed}`);
    }
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onErr);
    const errsNow = errs.length;
    ck('pause: 这一场没有未捕获异常/未处理 rejection（全屏被拒要由 js/main.js:694 的 settle 吃掉）',
      errsNow === 0, errs.slice(0, 3).join(' | '));
    return report({ fs, focus: document.hasFocus(), fsEnabled: document.fullscreenEnabled, frozen, frozenP, resumed, jump, afterNew: afterNew.moved, errs: errsNow });
  };

  window.__ng = { engine, gen, play, hint, conflict, save, resume, layout, a11y, pause };
})(window);
