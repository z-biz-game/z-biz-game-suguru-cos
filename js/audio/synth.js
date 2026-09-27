// 合成音效，不带采样文件。益智游戏的听觉是**状态读数**——"落下一个数""擦掉""这处自相矛盾"
// "某个区域凑齐了""整盘收工"——每一个都是一条短包络，所以合成器既让产物保持小，也让词汇保持诚实。
//
// 只保留一个音色：一个振荡器 + 两点音高滑动 + 指数衰减。加第二种"声音形状"的游戏，
// 最后都会拥有一批听不出属于同一件乐器的音效。

let ctx = null;
let master = null;
let enabled = true;

function audio() {
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  setEnabled(v) {
    enabled = !!v;
  },
  enabled: () => enabled,

  // 落子的音高跟着数字走：1 最低、9 最高。写下的数在听上就是一段旋律，
  // 而"叮"一声不分大小那种音效，玩家在闭眼校对时什么也读不出来。
  place(v = 1) {
    const f = 392 * Math.pow(2, (Math.max(1, Math.min(9, v)) - 1) / 12);
    tone({ f0: f, f1: f * 1.5, dur: 0.12, type: 'triangle', gain: 0.19 });
  },
  erase() {
    tone({ f0: 240, f1: 170, dur: 0.07, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // 一个区域自洽了：纯五度上行，短。它是"这里可以暂时不管了"的读数，不是奖励。
  region() {
    tone({ f0: 587, dur: 0.1, type: 'sine', gain: 0.12 });
    tone({ f0: 880, dur: 0.14, type: 'sine', gain: 0.1, delay: 0.05 });
  },
  // 两个失谐的声部：故意难听的音程，留给玩家必须不看屏幕也注意到的那一件事。
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  denied() {
    tone({ f0: 150, f1: 140, dur: 0.05, type: 'square', gain: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
