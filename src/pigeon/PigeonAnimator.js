import * as THREE from 'three';
import { clamp, lerp, damp, dampAngle, smoothstep, rand, noise1, TAU } from '../utils/math.js';

// =====================================================================================
//  程序化动画：把行为层给出的“目标姿态”平滑地施加到模型上，并叠加
//  · 步态（双足交替迈步 + 两骨 IK，脚掌着地不打滑）
//  · 点头行走（头部“定住—前冲”交替，鸽子用以在行走时稳定视像）
//  · 振翅循环（下扑伸展、上挥收拢、起飞时翼尖背侧拍击发声）
//  · 啄食、眨眼（啄击末段闭眼）、呼吸、东张西望（侧眼扫视）、抖羽等微动作
// =====================================================================================

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _v = V3(), _v2 = V3(), _v3 = V3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();

export const STAND_HEAD = Object.freeze({ x: 0, y: 0.18, z: 0.074 });

function defaults() {
  return {
    bodyHeight: 0.1, bodyPitch: -0.38, bodyRoll: 0, bodyForward: 0,
    head: V3(STAND_HEAD.x, STAND_HEAD.y, STAND_HEAD.z),
    headPitch: 0.15, headYaw: 0, headRoll: 0,
    neckPuff: 0, crop: 0, fluff: 0,
    foldL: 1, foldR: 1, raiseL: 0, raiseR: 0, droop: 0, spread: 1, sweep: 0, twist: 0,
    tailSpread: 0, tailPitch: 0.22, tailYaw: 0,
    lid: 0, beak: 0, toeCurl: 0,
  };
}

export class PigeonAnimator {
  constructor(model) {
    this.m = model;
    this.t = defaults();     // 目标
    this.c = defaults();     // 当前
    this.speed = {           // 各通道的平滑速率
      body: 8, head: 14, wing: 14, tail: 8, misc: 6, puff: 4,
    };
    this.legMode = 'ground'; // ground | air | land | sit | oneLeg | swim
    this.lookAround = true;
    this.headBob = true;
    this.walkSpeed = 0;      // 由实体写入：当前地面速度（m/s）
    this.localVel = V3();
    this.groundY = () => 0;
    this.events = [];

    // 步态
    this.feet = [0, 1].map((i) => ({
      i, planted: V3(), yaw: 0, swing: false, s: 0, from: V3(), to: V3(), dur: 0.11, init: false,
    }));
    this.stanceRoll = 0;
    // 点头
    this.bob = { phase: 'free', hold: V3(), t: 0, start: V3(), offset: V3() };
    // 振翅
    this.flap = { active: false, phase: 0, freq: 6.5, amp: 0.75, bias: 0.1, flexAmt: 0.5, clap: false, lastSin: 0, glide: 0 };
    // 啄
    this.peckState = null;
    // 微动作
    this.blinkT = rand(1, 4);
    this.blink = 0;
    this.look = { t: 0, yaw: 0, pitch: 0, roll: 0 };
    this.breath = { phase: 0, rate: 0.45, depth: 0.012 };
    this.shakeT = 0;
    this.nibble = 0;     // 理羽时的轻啄抖动幅度
    this.swallow = 0;    // 饮水吞咽
    this.time = 0;
  }

  emit(type, data) {
    this.events.push({ type, data });
  }

  // 设置目标姿态（部分字段）
  set(params) {
    for (const k in params) {
      if (k === 'head') this.t.head.copy(params.head);
      else this.t[k] = params[k];
    }
  }

  reset() {
    const d = defaults();
    for (const k in d) {
      if (k === 'head') this.t.head.copy(d.head);
      else this.t[k] = d[k];
    }
  }

  // 立即将当前姿态设为目标（瞬移或初始化时）
  snap() {
    for (const k in this.t) {
      if (k === 'head') this.c.head.copy(this.t.head);
      else this.c[k] = this.t[k];
    }
    for (const f of this.feet) f.init = false;
    this.bob.phase = 'free';
  }

  // 开始一次啄击：targetWorld 为喙尖应触及的世界坐标点
  peck(targetWorld, { duration = 0.34, eat = true } = {}) {
    if (this.peckState) return false;
    this.peckState = { t: 0, dur: duration, target: targetWorld.clone(), contact: false, eat };
    return true;
  }

  get pecking() {
    return !!this.peckState;
  }

  startFlap(opts) {
    Object.assign(this.flap, { active: true, glide: 0 }, opts);
  }

  stopFlap() {
    this.flap.active = false;
  }

  shake() {
    this.shakeT = 0.7;
  }

  // ---------------------------------------------------------------------------- 主更新
  update(dt, render = true) {
    this.time += dt;
    const m = this.m, t = this.t, c = this.c, S = this.speed;
    this.events.length = 0;

    // ---- 平滑各通道 ----
    for (const k of ['bodyHeight', 'bodyPitch', 'bodyRoll', 'bodyForward']) c[k] = damp(c[k], t[k], S.body, dt);
    for (const k of ['headPitch', 'headRoll']) c[k] = damp(c[k], t[k], S.head, dt);
    c.headYaw = dampAngle(c.headYaw, t.headYaw, S.head, dt);
    c.head.x = damp(c.head.x, t.head.x, S.head, dt);
    c.head.y = damp(c.head.y, t.head.y, S.head, dt);
    c.head.z = damp(c.head.z, t.head.z, S.head, dt);
    for (const k of ['foldL', 'foldR', 'raiseL', 'raiseR', 'droop', 'spread', 'sweep', 'twist']) c[k] = damp(c[k], t[k], S.wing, dt);
    for (const k of ['tailSpread', 'tailPitch', 'tailYaw']) c[k] = damp(c[k], t[k], S.tail, dt);
    for (const k of ['neckPuff', 'crop', 'fluff']) c[k] = damp(c[k], t[k], S.puff, dt);
    for (const k of ['lid', 'beak', 'toeCurl']) c[k] = damp(c[k], t[k], 18, dt);

    // ---- 躯干 ----
    let bodyY = c.bodyHeight, bodyPitch = c.bodyPitch, bodyRoll = c.bodyRoll;
    // 呼吸
    this.breath.phase += TAU * this.breath.rate * dt;
    const breathV = Math.sin(this.breath.phase) * this.breath.depth;
    // 步行时的左右摇摆（重心移向支撑脚）
    const walking = this.legMode === 'ground' && this.walkSpeed > 0.03;
    this.stanceRoll = damp(this.stanceRoll, this._stanceRollTarget(), 10, dt);
    bodyRoll += this.stanceRoll;
    if (walking) bodyY -= 0.002 * Math.abs(Math.sin(this.time * 9));
    // 抖羽
    let shakeRoll = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.sin((0.7 - this.shakeT) / 0.7 * Math.PI);
      shakeRoll = Math.sin(this.time * 70) * 0.12 * k;
    }
    // 振翅时躯干随下扑上下起伏
    let flapAngle = 0, flex = 0, twist = c.twist;
    const F = this.flap;
    if (F.active) {
      F.phase += TAU * F.freq * dt;
      const s = Math.sin(F.phase);
      const cphase = Math.cos(F.phase);
      flapAngle = F.bias + F.amp * s * (1 - F.glide);
      flex = F.flexAmt * Math.max(0, cphase) * (1 - F.glide);
      twist += (cphase < 0 ? -0.22 : 0.18) * F.amp * (1 - F.glide);
      bodyY += -0.004 * s * F.amp * (1 - F.glide);
      // 翼尖在背上方相碰：起飞拍翅声
      if (F.clap && this.flap.lastSin < 0.98 && s >= 0.98 && F.amp + F.bias > 1.05) this.emit('clap');
      if (this.flap.lastSin > -0.9 && s <= -0.9) this.emit('downstroke');
      F.lastSin = s;
    }
    m.body.position.set(0, bodyY, c.bodyForward);
    m.body.rotation.set(bodyPitch, 0, bodyRoll + shakeRoll, 'YXZ');
    m.setFluff(c.fluff + (this.shakeT > 0 ? 0.6 : 0), breathV);

    // ---- 翅膀 ----
    const shellFold = (fold) => fold;
    m.setWing(0, {
      fold: F.active ? Math.max(0, c.foldL * 0.2) : shellFold(c.foldL), flap: flapAngle, flex, twist,
      raise: c.raiseL, droop: c.droop, spread: c.spread + (F.active ? flex * 0.3 : 0), sweep: c.sweep,
    });
    m.setWing(1, {
      fold: F.active ? Math.max(0, c.foldR * 0.2) : shellFold(c.foldR), flap: flapAngle, flex, twist,
      raise: c.raiseR, droop: c.droop, spread: c.spread + (F.active ? flex * 0.3 : 0), sweep: c.sweep,
    });

    // ---- 尾 ----
    m.setTail({ spread: c.tailSpread, pitch: c.tailPitch, yaw: c.tailYaw + shakeRoll * 2 });

    // ---- 头颈 ----
    m.root.updateMatrixWorld(true);
    this._updateHead(dt, walking);
    m.neckPuff = c.neckPuff;
    m.cropInflate = c.crop;
    if (this.swallow > 0) {
      this.swallow = Math.max(0, this.swallow - dt * 1.6);
      m.neckSwallow = 1 - this.swallow;
    } else m.neckSwallow = 0;

    // ---- 眼睑 / 喙 ----
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink = 0.14;
      this.blinkT = rand(2, 6);
    }
    let lid = c.lid;
    if (this.blink > 0) {
      this.blink -= dt;
      lid = Math.max(lid, Math.sin(clamp(1 - this.blink / 0.14, 0, 1) * Math.PI));
    }
    let beak = c.beak;
    if (this.peckState) {
      const p = this.peckState.t / this.peckState.dur;
      // 鸽子在啄击的最后阶段会闭眼
      if (p > 0.25 && p < 0.6) lid = Math.max(lid, 0.85);
      if (p > 0.3 && p < 0.55) beak = Math.max(beak, 0.35);
    }
    if (this.nibble > 0) beak = Math.max(beak, 0.3 + 0.3 * Math.sin(this.time * 28));
    m.setEyelids(lid);
    m.setBeak(beak);

    // ---- 腿 ----
    m.root.updateMatrixWorld(true);
    this._updateLegs(dt);

    if (render) m.finalize();
  }

  _stanceRollTarget() {
    if (this.legMode !== 'ground') return 0;
    const [a, b] = this.feet;
    if (a.swing) return -0.06; // 左脚抬起 → 重心移向右脚（-X）
    if (b.swing) return 0.06;
    return 0;
  }

  // ---------------------------------------------------------------------------- 头部
  _updateHead(dt, walking) {
    const m = this.m, c = this.c;
    // 东张西望：鸽子双眼位于头侧，常以快速转头（扫视）切换注视的眼睛
    let yaw = c.headYaw, pitch = c.headPitch, roll = c.headRoll;
    if (this.lookAround && !this.peckState) {
      this.look.t -= dt;
      if (this.look.t <= 0) {
        this.look.t = rand(0.4, 2.2);
        const r = Math.random();
        if (r < 0.45) { this.look.yaw = rand(-0.9, 0.9); this.look.roll = 0; this.look.pitch = rand(-0.15, 0.2); }
        else if (r < 0.65) { this.look.yaw = rand(-0.5, 0.5); this.look.roll = rand(-0.7, 0.7); this.look.pitch = -0.2; } // 侧头仰望天空
        else { this.look.yaw = 0; this.look.roll = 0; this.look.pitch = 0; }
      }
    } else {
      this.look.yaw = 0; this.look.roll = 0; this.look.pitch = 0;
    }
    this._lookYaw = damp(this._lookYaw ?? 0, this.look.yaw, 22, dt);
    this._lookRoll = damp(this._lookRoll ?? 0, this.look.roll, 18, dt);
    this._lookPitch = damp(this._lookPitch ?? 0, this.look.pitch, 18, dt);
    yaw += this._lookYaw; roll += this._lookRoll; pitch += this._lookPitch;

    // 根空间中的头部目标位置
    const target = _v.copy(c.head);
    // 理羽轻啄
    if (this.nibble > 0) {
      target.x += Math.sin(this.time * 23) * 0.003 * this.nibble;
      target.z += Math.sin(this.time * 17 + 1) * 0.003 * this.nibble;
    }

    // ---- 啄击 ----
    if (this.peckState) {
      const P = this.peckState;
      P.t += dt;
      const p = clamp(P.t / P.dur, 0, 1);
      // 0–0.4 向下冲；0.4–0.55 接触；0.55–1 抬起
      const k = p < 0.4 ? smoothstep(0, 0.4, p) : p < 0.55 ? 1 : 1 - smoothstep(0.55, 1, p);
      const tgtLocal = this.m.root.worldToLocal(_v2.copy(P.target));
      // 头部枢轴应位于喙尖目标上方、略后
      const pivot = _v3.set(tgtLocal.x, tgtLocal.y + 0.024, tgtLocal.z - 0.03);
      target.lerp(pivot, k);
      pitch = lerp(pitch, 1.2, k);
      yaw = lerp(yaw, Math.atan2(tgtLocal.x, Math.max(0.02, tgtLocal.z)) * 0.6, k);
      roll = lerp(roll, 0, k);
      if (!P.contact && p >= 0.45) {
        P.contact = true;
        this.emit('peck', { target: P.target, eat: P.eat });
      }
      if (P.t >= P.dur) this.peckState = null;
      this.bob.phase = 'free';
    }

    // ---- 点头行走：头部在空间中“定住”，身体前移后头部快速前冲 ----
    let local = target;
    if (walking && this.headBob && !this.peckState) {
      const B = this.bob;
      const neutral = target;
      if (B.phase === 'free') {
        B.phase = 'hold';
        B.hold.copy(neutral);
        this.m.root.localToWorld(B.hold);
      }
      if (B.phase === 'hold') {
        local = this.m.root.worldToLocal(_v2.copy(B.hold));
        local.y = neutral.y;
        local.x = neutral.x;
        if (local.z < neutral.z - 0.024 || local.z > neutral.z + 0.04) {
          B.phase = 'thrust';
          B.t = 0;
          B.start.copy(local);
        }
      }
      if (B.phase === 'thrust') {
        B.t += dt / 0.085;
        const k = smoothstep(0, 1, Math.min(1, B.t));
        local = _v2.copy(B.start).lerp(_v3.copy(neutral).setZ(neutral.z + 0.018), k);
        if (B.t >= 1) {
          B.phase = 'hold';
          B.hold.copy(local);
          this.m.root.localToWorld(B.hold);
        }
      }
    } else {
      this.bob.phase = 'free';
    }

    // 转换到躯干空间
    const body = this.m.body;
    body.updateMatrix();
    _m.copy(body.matrix).invert();
    this.m.head.position.copy(local).applyMatrix4(_m);
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _q2.copy(body.quaternion).invert();
    this.m.head.quaternion.copy(_q2.multiply(_q));
  }

  // ---------------------------------------------------------------------------- 腿
  _updateLegs(dt) {
    const m = this.m;
    const mode = this.legMode;
    const curl = this.c.toeCurl;
    if (mode === 'air') {
      // 飞行：双脚收向后方，趾蜷曲
      for (let i = 0; i < 2; i++) {
        m.setLegAngles(i, 1.4, 0.35, 0);
        m.setToeCurl(i, 1);
        m.levelFoot(i, 1.9);
        this.feet[i].init = false;
      }
      return;
    }
    if (mode === 'land') {
      // 降落：双腿前伸准备着地
      for (let i = 0; i < 2; i++) {
        m.setLegAngles(i, -0.35, -0.55, 0);
        m.setToeCurl(i, 0.1);
        m.levelFoot(i, -0.3);
        this.feet[i].init = false;
      }
      return;
    }
    const root = m.root;
    const rootYaw = root.rotation.y;
    // 第一遍：计算每只脚的理想落脚点与偏差
    const lead = clamp(this.localVel.z * 0.09, -0.03, 0.05);
    let worst = -1, worstErr = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const side = i === 0 ? 1 : -1;
      f.ideal = f.ideal || V3();
      f.ideal.set(side * 0.021, 0, 0.006 + lead + this.c.bodyForward);
      root.localToWorld(f.ideal);
      f.ideal.y = this.groundY(f.ideal.x, f.ideal.z) + 0.0024;
      if (mode === 'oneLeg' && i === 1) continue;
      if (!f.init) {
        f.planted.copy(f.ideal);
        f.yaw = rootYaw + side * 0.12;
        f.init = true;
        f.swing = false;
      }
      const d = Math.hypot(f.planted.x - f.ideal.x, f.planted.z - f.ideal.z);
      const yawErr = Math.abs(Math.atan2(Math.sin(f.yaw - rootYaw - side * 0.12), Math.cos(f.yaw - rootYaw - side * 0.12)));
      const err = Math.max(d / 0.026, yawErr / 0.5);
      if (err > worstErr) { worstErr = err; worst = i; }
    }
    // 两脚交替：只有在两脚都着地时才允许抬起偏差最大的那只
    if (mode !== 'sit' && worst >= 0 && worstErr > 1 && !this.feet[0].swing && !this.feet[1].swing) {
      const f = this.feet[worst];
      f.swing = true;
      f.s = 0;
      f.from.copy(f.planted);
      f.dur = clamp(0.13 - this.walkSpeed * 0.06, 0.08, 0.13);
      this.emit('step', { foot: worst });
    }
    // 第二遍：摆动与 IK
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const side = i === 0 ? 1 : -1;
      if (mode === 'oneLeg' && i === 1) {
        // 单脚站立休息：另一只脚收进腹羽
        m.setLegAngles(i, 0.2, -2.3, 0);
        m.setToeCurl(i, 1);
        m.levelFoot(i, 0.5);
        f.init = false;
        continue;
      }
      let pos = f.planted;
      if (f.swing) {
        f.s += dt / f.dur;
        const k = Math.min(1, f.s);
        f.to.copy(f.ideal);
        pos = _v2.copy(f.from).lerp(f.to, smoothstep(0, 1, k));
        pos.y += Math.sin(k * Math.PI) * 0.016;
        f.yaw = dampAngle(f.yaw, rootYaw + side * 0.12, 20, dt);
        if (f.s >= 1) {
          f.swing = false;
          f.planted.copy(f.to);
        }
      }
      m.solveLegIK(i, pos, f.yaw);
      m.setToeCurl(i, f.swing ? 0.5 + curl * 0.5 : curl);
    }
  }
}
