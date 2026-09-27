// 跨引擎的定盘夹具。每一条都是 node 量出来的，浏览器门禁在 Chrome 里把同一份 seed 再算一遍，
// 必须逐字对上。
//
// 为什么非要钉在两个引擎之间、而不是只在自己家里查"同 seed 两次同盘"：出题器只要从**引擎相关的
// 地方**多拿一个随机数，同一个 seed 就会在不同引擎（或不同 V8 版本）里画出两张盘。2026-09-27
// 真撞上过一次——grow() 把 rng.next() 写进了 sort 的比较器，而比较次数是实现相关的：8×8 的
// 'scen|resume' 在 node 出 26 个提示的盘、在 Chrome 出 22 个。"存档只记 seed"要的是玩家换个
// 浏览器回来还是那一盘，所以这条得由夹具钉住，不能靠自觉。
//
// 这个文件必须能被浏览器 import（node 侧和 Chrome 侧跑的是同一份），所以量化脚本在
// tools/write-golden.mjs，改动出题器之后重新量：node tools/write-golden.mjs

export const GOLDEN = [

  {
    "tier": "trainee",
    "seed": "golden|trainee",
    "clues": 8,
    "score": 21,
    "givens": "0020015004000006010020300",
    "solution": "2423115154323216414325321"
  },
  {
    "tier": "apprentice",
    "seed": "golden|apprentice",
    "clues": 15,
    "score": 25.2,
    "givens": "060120400056002471600300200000001003",
    "solution": "564121437356152471631324252656131423"
  },
  {
    "tier": "regular",
    "seed": "golden|regular",
    "clues": 21,
    "score": 34.2,
    "givens": "2651073300005240000040030460000002500000103010260",
    "solution": "2651273314635245217142135463346132512545143413262"
  },
  {
    "tier": "expert",
    "seed": "golden|expert",
    "clues": 23,
    "score": 53.8,
    "givens": "2050000030000000057005004006000010700100800024010646100052002030",
    "solution": "2151212136434343157215124246323515757162821324313646152452732431"
  },
  {
    "tier": "master",
    "seed": "golden|master",
    "clues": 37,
    "score": 58.4,
    "givens": "500046740083500035306701000072007041608040000701000000000200006810061030076520042",
    "solution": "512146741283523235346741562172367341648542153731615321245232456813461731476523542"
  }
];

// 一张盘的指纹：题面、正解、提示数、实测难度。四样一起比才叫"同一张盘"。
export function fingerprint(p) {
  return {
    clues: p.clues,
    score: Math.round(p.score * 10) / 10,
    givens: Array.from(p.spec.givens).join(''),
    solution: Array.from(p.solution).join(''),
  };
}

// 两边共用同一段比较，失败的话也长得一样。make 收 (seed, tier) 出题。
export function goldenRows(make) {
  return GOLDEN.map((g) => {
    const p = make(g.seed, g.tier);
    if (!p) return { tier: g.tier, pass: false, detail: '这一档出题失败' };
    const got = fingerprint(p);
    const diff = [];
    for (const k of Object.keys(got)) if (got[k] !== g[k]) diff.push(`${k}: got ${got[k]} want ${g[k]}`);
    return { tier: g.tier, pass: !diff.length, detail: diff.join(' / ') };
  });
}
