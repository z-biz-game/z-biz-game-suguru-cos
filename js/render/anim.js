// 动效的仿真层。它只持有"看得见的东西"的状态（提示脉冲、收工火花、选中格的呼吸），
// 不判断任何规则——规则一律在 js/engine/suguru.js。
//
// 为什么这里要有一个定步长累加器，而不是一句 `x += 0.5`：数方是回合制的，动效只负责
// "把刚才发生的事说清楚"，所以它必须**在任何刷新率下说同一句话**。30Hz 与 120Hz 之间
// 唯一可信的公共单位是仿真步，不是帧。于是：
//   advance(帧 dt) → accum += 帧dt → 每满 SIM_STEP 跑一步 step()
// 步内所有写法都是 dt 的函数：位移 `x += vx*s`、阻尼 `vx *= Math.pow(DRAG, s)`、
// 寿命 `life -= s`。这里没有一处 `*= 0.96` 或 `if (Math.random() < 0.02)` 那种只在 60Hz 成立的写法。
//
// 随机数自带一条 LCG（种子固定），不用 Math.random()：否则同一局重放在两个刷新率下
// 会撒出两堆不同的火花，帧率对拍根本没法判。

export const SIM_STEP = 1 / 120;
const GRAVITY = 620; // px/s²
const DRAG = 0.16; // 每秒保留比例（指数阻尼，见 step 里的 Math.pow）
const PULSE_LIFE = 1.4; // s
const BREATH_PERIOD = 2.6; // s

export class Anim {
  constructor() {
    this.reduced = false;
    this.particles = [];
    this.reset();
  }

  // 重开/换一局要把时钟、累加器、脉冲、粒子全部放下。只清粒子留着时钟，就会出现
  // "新一局的火花按上一局的相位飘"。
  reset() {
    this.clock = 0;
    this.steps = 0;
    this.accum = 0;
    this.breath = 0;
    this.pulse = null;
    this.pulseT = 0;
    this.particles.length = 0;
    this.seed = 0x2f6b2b1;
  }

  rand() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  setReducedMotion(v) {
    this.reduced = !!v;
    if (this.reduced) {
      // 动效关掉：火花直接散场，脉冲退成一张静图（由 draw 画，不需要 rAF）。
      this.particles.length = 0;
    }
  }

  flash(cell, color) {
    this.pulse = { cell, color };
    this.pulseT = 0;
  }

  clearPulse() {
    this.pulse = null;
    this.pulseT = 0;
  }

  // 收工：从盘面中心撒一把火花。数量按面积给，小屏不至于糊成一片。
  burst(cx, cy, r, count = 96) {
    if (this.reduced) return 0;
    for (let i = 0; i < count; i++) {
      const a = this.rand() * Math.PI * 2;
      const sp = 140 + this.rand() * 300;
      this.particles.push({
        x: cx + Math.cos(a) * r * 0.18,
        y: cy + Math.sin(a) * r * 0.18,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 90,
        life: 0.85 + this.rand() * 0.75,
        maxLife: 1.6,
        size: 8 + this.rand() * 16,
        spin: (this.rand() - 0.5) * 6,
        rot: this.rand() * Math.PI,
      });
    }
    return this.particles.length;
  }

  // 唯一还在吃"帧 dt"的地方：累加器。定步长之后所有逐粒子位移都拿的是 SIM_STEP，
  // 所以帧率对拍的阴性对照要钉在这一行（accum += elapsed → accum += 1/60 必红）。
  advance(elapsed) {
    this.accum += elapsed;
    let guard = 0;
    while (this.accum >= SIM_STEP && guard++ < 16) {
      this.accum -= SIM_STEP;
      this.step(SIM_STEP);
    }
    // 一次喂进太多（后台回来、断点续跑）就丢掉欠账，只追 16 步，不追一整秒。
    if (this.accum > SIM_STEP * 16) this.accum = 0;
  }

  step(s) {
    this.clock += s;
    this.steps++;
    this.breath += s;

    if (this.pulse) {
      this.pulseT += s;
      if (this.pulseT >= PULSE_LIFE) this.clearPulse();
    }

    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= s;
      if (p.life <= 0) {
        ps.splice(i, 1);
        continue;
      }
      const damp = Math.pow(DRAG, s);
      p.vy += GRAVITY * s;
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.rot += p.spin * s;
    }
  }

  // 要不要继续要帧：关掉动效之后只剩"有东西在动"才要帧，静图不占循环。
  needsFrame() {
    return !!this.pulse || this.particles.length > 0 || !this.reduced;
  }

  snapshot() {
    return {
      clock: this.clock,
      steps: this.steps,
      accum: this.accum,
      breath: this.breath,
      pulseOn: this.pulse ? 1 : 0,
      pulseT: this.pulseT,
      particleCount: this.particles.length,
      reduced: this.reduced ? 1 : 0,
    };
  }
}

export const pulseProgress = (a) => (a.pulse ? Math.min(1, a.pulseT / PULSE_LIFE) : 0);
export const breathPhase = (a) => (a.breath % BREATH_PERIOD) / BREATH_PERIOD;
