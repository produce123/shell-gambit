/**
 * Shell Gambit — 音效
 *
 * 全部用 WebAudio 现场合成，不加载任何音频文件：
 *  · 零额外请求，GitHub Pages 上开箱即用
 *  · 体积极小，不会因为加载失败而报错
 *
 * 浏览器要求音频必须由用户手势触发，所以第一次点击时才创建 AudioContext。
 */

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    // 音效开关由玩家自己决定，并记在本地
    this.enabled = localStorage.getItem('sg.sound') !== 'off';
  }

  /** 开/关音效（持久化） */
  setEnabled(on) {
    this.enabled = !!on;
    localStorage.setItem('sg.sound', on ? 'on' : 'off');
    if (on) {
      this.ensure();
      this.play('click');
    }
  }

  /** 延迟创建 AudioContext（必须在用户手势里调用） */
  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        this.enabled = false;
        return null;
      }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.3;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** 一段简单的正弦/方波音 */
  tone({ freq = 440, to = null, dur = 0.12, type = 'sine', gain = 0.5, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    // 短促的淡入淡出，避免爆音
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 一段过滤后的噪声（枪声、破壳声等） */
  noise({ dur = 0.18, gain = 0.5, freq = 1200, to = 300, q = 1, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  play(name) {
    if (!this.enabled) return;
    try {
      switch (name) {
        case 'click': // 普通点击
          this.tone({ freq: 720, dur: 0.05, type: 'square', gain: 0.16 });
          break;
        case 'tap':
          this.tone({ freq: 420, dur: 0.06, type: 'triangle', gain: 0.2 });
          break;
        case 'card': // 出牌
          this.tone({ freq: 900, to: 1300, dur: 0.1, type: 'triangle', gain: 0.22 });
          this.noise({ dur: 0.06, gain: 0.1, freq: 3000, to: 1500 });
          break;
        case 'shoot': // 实弹
          this.noise({ dur: 0.3, gain: 0.7, freq: 1800, to: 120, q: 0.7 });
          this.tone({ freq: 120, to: 45, dur: 0.28, type: 'sine', gain: 0.55 });
          break;
        case 'saw': // 手锯
          this.noise({ dur: 0.32, gain: 0.24, freq: 2600, to: 900, q: 3 });
          break;
        case 'blank': // 空弹：干脆的"咔"
          this.tone({ freq: 1400, dur: 0.03, type: 'square', gain: 0.2 });
          this.tone({ freq: 300, dur: 0.05, type: 'square', gain: 0.16, delay: 0.03 });
          break;
        case 'heal': // 回血
          this.tone({ freq: 520, to: 780, dur: 0.16, type: 'sine', gain: 0.28 });
          this.tone({ freq: 780, dur: 0.12, type: 'sine', gain: 0.2, delay: 0.13 });
          break;
        case 'info': // 放大镜
          this.tone({ freq: 1000, dur: 0.09, type: 'sine', gain: 0.2 });
          this.tone({ freq: 1400, dur: 0.11, type: 'sine', gain: 0.16, delay: 0.08 });
          break;
        case 'invert': // 逆转器
          this.tone({ freq: 300, to: 900, dur: 0.2, type: 'triangle', gain: 0.24 });
          break;
        case 'cuff': // 手铐
          this.noise({ dur: 0.1, gain: 0.3, freq: 4200, to: 2000, q: 4 });
          this.tone({ freq: 180, dur: 0.09, type: 'square', gain: 0.2, delay: 0.04 });
          break;
        case 'hurt': // 掉血
          this.tone({ freq: 320, to: 110, dur: 0.24, type: 'sawtooth', gain: 0.3 });
          break;
        case 'throw': // 扔出去
          this.noise({ dur: 0.22, gain: 0.16, freq: 700, to: 2400, q: 1.2 });
          break;
        case 'splat': // 砸中
          this.noise({ dur: 0.14, gain: 0.32, freq: 900, to: 180, q: 0.8 });
          break;
        case 'boom': // 绽放
          this.tone({ freq: 1600, to: 2600, dur: 0.16, type: 'sine', gain: 0.18 });
          break;
        case 'win': // 胜利
          [523, 659, 784, 1046].forEach((f, i) =>
            this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.26, delay: i * 0.11 })
          );
          break;
        case 'lose':
          [400, 330, 260].forEach((f, i) =>
            this.tone({ freq: f, dur: 0.26, type: 'sine', gain: 0.24, delay: i * 0.13 })
          );
          break;
        case 'round': // 换弹
          this.tone({ freq: 240, dur: 0.08, type: 'square', gain: 0.2 });
          this.tone({ freq: 300, dur: 0.1, type: 'square', gain: 0.18, delay: 0.12 });
          break;
        default:
          this.tone({ freq: 600, dur: 0.05, type: 'sine', gain: 0.15 });
      }
    } catch {
      /* 音效失败绝不能影响游戏 */
    }
  }
}

export const sfx = new Sfx();

/** 给所有按钮加统一的点击音 */
export function bindClickSounds(root = document) {
  root.addEventListener(
    'pointerdown',
    (e) => {
      const btn = e.target.closest('button');
      if (btn && !btn.disabled) sfx.play('click');
    },
    { passive: true }
  );
}