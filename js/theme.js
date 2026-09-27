// 颜色、间距、动效的唯一来源。样式表通过 applyThemeVars() 读这些值，canvas 读的是同一批对象，
// 所以改一个令牌不可能只改到一边——"改了一行线色"变成"四十处不一致"就是这么来的。
//
// 区域底色（Regions）是这里唯一需要解释的一组：数方的分组信息本来就由粗边界说清楚了，
// 底色只负责把"一片一样深的格子"拆开。所以每一条都必须比 ink 暗到能让白字站上 4.5:1
// （`npm run verify` 的 layout 场景按 WCAG 公式逐块量像素，见 README），而不是靠肉眼挑个"看着还行"。

export const Palette = {
  bgTop: '#080B16',
  bgBottom: '#131A2E',
  surface: '#101627',
  surfaceLift: '#182036',
  line: '#243050',
  // 分组的唯一载体是这条粗边界（底色只负责拆开"一片一样深的格子"），所以它得压得过六块底色里
  // 最亮的那一块：#3A4A72 实测最低只有 1.64:1，等于把区域划分交给了一件看不见的东西在说。
  // 这一条换成 #6B7FA8 之后，压在六块底色上的最低值是 3.58:1（WCAG 1.4.11 对"看懂内容所必需
  // 的图形"要的就是 3:1），而盘内细线仍留在 #243050——分隔两格的线不该抢边界的戏。
  lineHeavy: '#6B7FA8',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // 琥珀是"玩家自己的手"：选中的格、刚敲下的数、提示的落点都借它，这样"这是你在做的事"是一个想法。
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  errorSoft: 'rgba(255,92,122,0.14)',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 题面给的数是冷白，玩家写的数是琥珀——这两种颜色之外，盘上的数字不该再有第三种身份。
  given: '#F2F5FB',
  player: '#FFC85C',
}

// 六块区域底色，色相分得开、亮度压在同一个窄带里（相对亮度 0.013~0.024），
// 于是 ink(#F2F5FB) 落在任何一块上都是 15:1 以上。相邻区域由 render/board.js 贪心取不同块。
export const Regions = ['#172337', '#14292A', '#22182F', '#2A2317', '#1B2E22', '#2C1A1F'];

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 3 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// 时长守在 150~350ms：再长就开始挡住下一次落子。
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = { min: 26, max: 62, digitScale: 0.5, border: 0.055, thin: 0.02 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  Regions.forEach((c, i) => root.setProperty(`--region-${i}`, c));
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// 系统偏好是地板，游戏内的开关只能往上加不能往下减——一个要求少动效的玩家，
// 不该被一台设成"无偏好"的 OS 否决。
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
