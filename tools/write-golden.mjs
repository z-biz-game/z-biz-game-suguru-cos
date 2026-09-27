// 把 tools/golden.mjs 里的夹具按本机量出来的数字重写。改动出题器之后跑它，然后连着 diff 一起
// 提交——夹具的变化必须看得见，因为老存档的 seed 在新出题器下会画出另一张盘。
//
// 量化这件事只能在一个地方做：node 是量的一方、Chrome 是核对的一方，所以数据文件本身必须两边都
// 能读，写盘的代码得单独放这儿。

import { makePuzzle, TIERS } from '../js/engine/generate.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('./golden.mjs', import.meta.url));
const old = readFileSync(target, 'utf8');
const rows = TIERS.map((t) => {
  const p = makePuzzle(`golden|${t.key}`, t.key);
  if (!p) throw new Error(`${t.key} 出题失败：夹具不能凭空虚写`);
  return {
    tier: t.key,
    seed: p.originSeed,
    clues: p.clues,
    score: Math.round(p.score * 10) / 10,
    givens: Array.from(p.spec.givens).join(''),
    solution: Array.from(p.solution).join(''),
  };
});

const BEGIN = 'export const GOLDEN = [';
const at = old.indexOf(BEGIN);
const head = old.slice(0, at);
const rest = old.slice(at + BEGIN.length);
const end = rest.indexOf('\n];');
const tail = rest.slice(end + 3);
// 写坏一个被两边共读的夹具，比它没更新更糟：三处边界都要认出来才动手。
if (at < 0 || end < 0 || !tail.includes('export function goldenRows')) {
  throw new Error('夹具文件的边界没认出来，拒绝写盘');
}
const next = `${head}${BEGIN}\n${JSON.stringify(rows, null, 2).replace(/^\[|]$/g, '')}];${tail}`;
writeFileSync(target, next);
console.log(`已按本机量出的 ${rows.length} 条重写 ${target}`);
