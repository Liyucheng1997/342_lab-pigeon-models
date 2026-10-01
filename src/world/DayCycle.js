import * as THREE from 'three';
import { SUNRISE, SUNSET, SECONDS_PER_GAME_HOUR } from '../config.js';
import { clamp, lerp, smoothstep } from '../utils/math.js';

// 昼夜循环：时间、太阳高度、光照、天空颜色、气温
export class DayCycle {
  constructor(startHour = 7.2) {
    this.hour = startHour;     // 0–24
    this.day = 1;
    this.timeScale = 1;        // 时间倍速
    this.paused = false;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.cloudiness = 0.15;
    this._skyTop = new THREE.Color();
    this._skyHorizon = new THREE.Color();
  }

  // dt：真实秒；返回本帧推进的游戏小时
  update(dt) {
    if (this.paused) return 0;
    const dh = (dt * this.timeScale) / SECONDS_PER_GAME_HOUR;
    this.hour += dh;
    if (this.hour >= 24) {
      this.hour -= 24;
      this.day += 1;
    }
    this._computeSun();
    return dh;
  }

  skipTo(hour) {
    if (hour <= this.hour) this.day += 1;
    this.hour = hour;
    this._computeSun();
  }

  _computeSun() {
    const h = this.hour;
    // 太阳在 SUNRISE 升起、SUNSET 落下，正午最高（约 58°）
    const dayLen = SUNSET - SUNRISE;
    const u = (h - SUNRISE) / dayLen; // 0..1 白天
    const elev = Math.sin(u * Math.PI) * 1.0 - (u < 0 || u > 1 ? 0.25 : 0);
    const az = lerp(-1.9, 1.9, clamp(u, -0.3, 1.3));
    this.sunElevation = u >= 0 && u <= 1 ? Math.sin(u * Math.PI) * 1.02 : -0.3;
    const e = this.sunElevation;
    this.sunDir.set(Math.sin(az) * Math.cos(e), Math.sin(e), Math.cos(az) * Math.cos(e) * 0.6 + 0.35).normalize();
    this.moonDir.set(-this.sunDir.x * 0.6, Math.max(0.4, -this.sunDir.y + 0.4), -0.4).normalize();
    void elev;
  }

  get daylight() {
    // 0（深夜）–1（白天）；黄昏与黎明平滑过渡
    return smoothstep(-0.12, 0.18, this.sunElevation);
  }

  get isNight() {
    return this.hour < SUNRISE - 0.3 || this.hour > SUNSET + 0.4;
  }

  get isDusk() {
    return this.hour > SUNSET - 1.2 && this.hour < SUNSET + 0.8;
  }

  get isDawn() {
    return this.hour > SUNRISE - 0.6 && this.hour < SUNRISE + 1.0;
  }

  // 气温：清晨最低约 11°C，下午 15 时最高约 24°C
  get temperature() {
    return 17.5 + 6.5 * Math.sin(((this.hour - 9) / 24) * Math.PI * 2);
  }

  // 光照强度（晴天直射）
  get sunStrength() {
    return smoothstep(-0.02, 0.35, this.sunElevation) * (1 - this.cloudiness * 0.6);
  }

  skyColors() {
    const d = this.daylight;
    const golden = Math.exp(-((this.sunElevation - 0.05) ** 2) / 0.02) * (this.sunElevation > -0.15 ? 1 : 0);
    const nightTop = new THREE.Color('#050913'), nightHor = new THREE.Color('#121a2c');
    const dayTop = new THREE.Color('#3f7fd0'), dayHor = new THREE.Color('#b9d4ea');
    const goldTop = new THREE.Color('#3b4f86'), goldHor = new THREE.Color('#f2a35e');
    this._skyTop.copy(nightTop).lerp(dayTop, d).lerp(goldTop, golden * 0.6);
    this._skyHorizon.copy(nightHor).lerp(dayHor, d).lerp(goldHor, golden * 0.85);
    return { top: this._skyTop, horizon: this._skyHorizon, golden };
  }

  get clockString() {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  get periodLabel() {
    const h = this.hour;
    if (h < 5) return '深夜';
    if (h < SUNRISE + 0.5) return '黎明';
    if (h < 9) return '清晨';
    if (h < 11.5) return '上午';
    if (h < 13.5) return '中午';
    if (h < 17) return '下午';
    if (h < SUNSET + 0.6) return '黄昏';
    if (h < 22) return '夜晚';
    return '深夜';
  }
}
