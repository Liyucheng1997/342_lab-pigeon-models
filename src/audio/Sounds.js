import * as THREE from 'three';
import { rand, clamp } from '../utils/math.js';

// =====================================================================================
//  程序化合成的声音（WebAudio，无需音频文件）
//  · 咕咕声：低沉的“咕——噜噜——咕”，基频约 250–350 Hz，中段有约 30 Hz 的颤音
//  · 拍翅声：起飞时翼尖在背部上方相碰发出清脆的“啪”声，受惊时更响更密
//  · 振翅的呼呼声、着陆的扑翅声、城市环境底噪
// =====================================================================================
export class Sounds {
  constructor() {
    this.enabled = false;
    this.ctx = null;
    this.camera = null;
    this.volume = 0.8;
    this._last = new Map();
  }

  // 浏览器要求用户交互后才能启动音频
  enable() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuf = this._makeNoise(2);
      this._startAmbience();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.enabled = true;
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
    return true;
  }

  disable() {
    this.enabled = false;
    if (this.master) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }

  setCamera(cam) {
    this.camera = cam;
  }

  _makeNoise(seconds) {
    const n = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // 根据声源与摄像机的相对位置计算音量与左右声道
  _spatial(pos) {
    if (!this.camera) return { gain: 0.5, pan: 0 };
    const local = pos.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const d = local.length();
    const gain = clamp(1 / (1 + d * 0.35), 0, 1);
    const pan = clamp(local.x / Math.max(d, 0.5), -0.9, 0.9);
    return { gain, pan, d };
  }

  _out(pos, vol = 1) {
    const { gain, pan, d } = this._spatial(pos);
    if (gain * vol < 0.01) return null;
    const g = this.ctx.createGain();
    g.gain.value = gain * vol;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.master);
    return { node: g, d };
  }

  _throttle(key, ms) {
    const now = performance.now();
    if (now - (this._last.get(key) || 0) < ms) return true;
    this._last.set(key, now);
    return false;
  }

  _ok() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  // ---------------------------------------------------------------- 咕咕声
  coo(p, type = 'perch') {
    if (!this._ok() || this._throttle('coo' + p.id, 600)) return;
    const out = this._out(p.headWorld, 0.9);
    if (!out) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    const base = (p.sex === 'male' ? 255 : 290) * (1 / p.size) * rand(0.96, 1.04);
    // 音节：[时长, 起始频率倍率, 结束频率倍率, 颤音深度]
    const syll = type === 'bow'
      ? [[0.16, 1.05, 1.25, 0], [0.62, 1.2, 0.92, 0.65], [0.26, 1.08, 0.82, 0.15]]
      : [[0.14, 1.0, 1.18, 0], [0.38, 1.15, 0.98, 0.55], [0.12, 1.1, 1.22, 0], [0.32, 1.12, 0.85, 0.2]];
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1100;
    filt.Q.value = 0.8;
    const form = ctx.createBiquadFilter();
    form.type = 'peaking';
    form.frequency.value = 600;
    form.gain.value = 6;
    filt.connect(form).connect(out.node);
    let t = t0;
    for (const [dur, f0, f1, trem] of syll) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(base * f0, t);
      osc.frequency.exponentialRampToValueAtTime(base * f1, t + dur);
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(base * f0 * 2, t);
      osc2.frequency.exponentialRampToValueAtTime(base * f1 * 2, t + dur);
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.32, t + 0.04);
      env.gain.setValueAtTime(0.32, t + dur - 0.06);
      env.gain.linearRampToValueAtTime(0, t + dur);
      osc.connect(env);
      osc2.connect(g2).connect(env);
      if (trem > 0) {
        // 颤音（“噜噜”）：振幅调制
        const am = ctx.createGain();
        am.gain.value = 1 - trem * 0.5;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rand(26, 34);
        const lg = ctx.createGain();
        lg.gain.value = trem * 0.5;
        lfo.connect(lg).connect(am.gain);
        env.connect(am).connect(filt);
        lfo.start(t); lfo.stop(t + dur + 0.05);
      } else {
        env.connect(filt);
      }
      osc.start(t); osc.stop(t + dur + 0.05);
      osc2.start(t); osc2.stop(t + dur + 0.05);
      t += dur + 0.045;
    }
  }

  // ---------------------------------------------------------------- 拍翅 / 振翅
  _noiseBurst(pos, { dur = 0.03, freq = 2500, q = 1.2, vol = 0.6, type = 'bandpass', delay = 0 }) {
    const out = this._out(pos, vol);
    if (!out) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay + Math.min(out.d / 340, 0.2);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + Math.min(0.004, dur * 0.2));
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(env).connect(out.node);
    src.start(t, rand(0, 1.5), dur + 0.05);
  }

  clap(p) {
    if (!this._ok()) return;
    this._noiseBurst(p.pos, { dur: 0.045, freq: rand(1800, 2600), q: 0.9, vol: 0.9 });
    this._noiseBurst(p.pos, { dur: 0.02, freq: 4500, q: 2, vol: 0.4 });
  }

  flap(p) {
    if (!this._ok() || this._throttle('flap' + p.id, 90)) return;
    this._noiseBurst(p.pos, { dur: 0.09, freq: rand(500, 800), q: 0.7, vol: 0.35, type: 'lowpass' });
  }

  takeoff(p, alarm) {
    if (!this._ok()) return;
    for (let i = 0; i < (alarm ? 5 : 3); i++) this._noiseBurst(p.pos, { dur: 0.08, freq: 700, q: 0.6, vol: alarm ? 0.6 : 0.4, type: 'lowpass', delay: i * 0.11 });
  }

  land(p) {
    if (!this._ok()) return;
    for (let i = 0; i < 3; i++) this._noiseBurst(p.pos, { dur: 0.07, freq: 600, q: 0.6, vol: 0.25, type: 'lowpass', delay: i * 0.1 });
  }

  // ---------------------------------------------------------------- 环境声
  _startAmbience() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._makeNoise(4);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    this.ambGain = ctx.createGain();
    this.ambGain.gain.value = 0.05;
    src.connect(f).connect(this.ambGain).connect(this.master);
    src.start();
  }

  setAmbience(daylight) {
    if (!this.ambGain) return;
    this.ambGain.gain.setTargetAtTime(0.02 + daylight * 0.05, this.ctx.currentTime, 0.5);
  }

  click(pos) {
    if (!this._ok()) return;
    this._noiseBurst(pos, { dur: 0.06, freq: 1500, q: 0.5, vol: 1.0 });
  }
}
