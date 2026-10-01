import * as THREE from 'three';
import { PigeonModel } from './PigeonModel.js';
import { PigeonAnimator } from './PigeonAnimator.js';
import { Brain } from './Brain.js';
import { BIO, FLIGHT_SCALE } from '../config.js';
import { clamp, lerp, damp, dampAngle, wrapAngle, rand, gaussian, smoothstep, TAU } from '../utils/math.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _v = V3(), _v2 = V3(), _v3 = V3();

let NEXT_ID = 1;
const _sphere = new THREE.Sphere(new THREE.Vector3(), 0.45);

// =====================================================================================
//  鸽子个体：生理状态 + 感知 + 运动（步行 / 飞行 / 停栖）+ 行为决策（Brain）
// =====================================================================================
export class Pigeon {
  constructor(flock, cfg) {
    this.id = NEXT_ID++;
    this.flock = flock;
    this.world = flock.world;
    this.name = cfg.name;
    this.sex = cfg.sex;
    this.morph = cfg.morph;
    this.juvenile = !!cfg.juvenile;
    this.ageDays = cfg.ageDays ?? Math.round(rand(300, 1600));
    this.bold = cfg.bold ?? rand(0.3, 0.8);       // 胆量：影响惊飞距离
    this.socialTrait = cfg.social ?? rand(0.4, 0.8);
    const sizeBase = this.sex === 'male' ? 1.04 : 0.97;
    this.size = (cfg.size ?? sizeBase * rand(0.96, 1.04)) * (this.juvenile ? 0.92 : 1);
    this.massKg = (this.sex === 'male' ? 0.34 : 0.3) * this.size ** 3;

    this.model = new PigeonModel({ morph: this.morph, sex: this.sex, seed: this.id * 31 + 7, size: this.size });
    if (this.juvenile) {
      // 幼鸽：颈部几乎没有金属光泽，虹膜偏暗，蜡膜小
      this.model.neckMaterial.iridescence = 0.15;
      this.model.eyeMaterial.color.set('#7a6a60');
    }
    this.anim = new PigeonAnimator(this.model);
    this.anim.groundY = (x, z) => this.surfaceY;
    this.world.scene.add(this.model.root);

    // ---- 运动状态 ----
    this.pos = V3();
    this.yaw = 0;
    this.vel = V3();          // 世界速度
    this.speed = 0;           // 地面速度
    this.mode = 'ground';     // ground | air | perch
    this.surfaceY = 0;        // 当前站立表面高度
    this.perch = null;
    this.moveTarget = null;
    this.moveSpeed = BIO.walkSpeed;
    this.arriveRadius = 0.05;
    this.flight = null;

    // ---- 生理 ----
    this.nutrition = rand(0.45, 0.75);   // 体内能量储备（0–1）
    this.cropG = rand(0, 4);             // 嗉囊内食物（克）
    this.hydration = rand(0.5, 0.85);
    this.energy = rand(0.7, 0.95);       // 精力（1 = 充分休息）
    this.hygiene = rand(0.55, 0.9);      // 羽毛整洁度
    this.fear = 0;
    this.lonely = 0;
    this.heat = 0;                       // 热应激
    this.cold = 0;
    this.breedDrive = this.sex === 'male' ? rand(0.2, 0.5) : rand(0.1, 0.3);
    this.heartRate = 200;
    this.respRate = 30;
    this.bodyTemp = BIO.bodyTemp;
    this.wet = 0;

    // ---- 统计 ----
    this.stats = { eatenG: 0, seeds: 0, drankMl: 0, flights: 0, flownM: 0, steps: 0, pecks: 0, coos: 0, preenS: 0, sleepH: 0 };

    // ---- 社会关系 ----
    this.mate = null;
    this.pair = null;
    this.rank = rand(0, 1);  // 优势等级（争夺食物时）
    this.homePerch = null;   // 习惯的过夜位置（鸽子有很强的恋巢/恋栖性）

    // ---- 感知缓存 ----
    this.perceived = { threat: null, threatDist: Infinity, neighbors: [], food: null, foodDist: Infinity };
    this._perceiveT = rand(0, 0.25);
    this.carrying = null;  // 衔着的细枝
    this.requests = {};    // 来自其他个体的社交请求（求偶、亲吻、换班、群飞）
    this.pendingFear = null;

    this.brain = new Brain(this);
    this.thought = '';
    this.log = [];
  }

  // ------------------------------------------------------------------ 放置
  placeOnGround(x, z, yaw = rand(0, TAU)) {
    this.mode = 'ground';
    this.perch = null;
    this.pos.set(x, 0, z);
    this.surfaceY = this.world.groundY(x, z);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.anim.legMode = 'ground';
    this.anim.reset();
    this.anim.snap();
    this._applyRoot();
  }

  placeOnPerch(perch) {
    this.mode = 'perch';
    if (this.perch && this.perch !== perch && this.perch.occupant === this) this.perch.occupant = null;
    this.perch = perch;
    perch.occupant = this;
    this.pos.copy(perch.pos);
    this.surfaceY = perch.pos.y;
    this.yaw = perch.yaw;
    this.vel.set(0, 0, 0);
    this.anim.legMode = 'ground';
    this.anim.reset();
    this.anim.snap();
    this._applyRoot();
  }

  leavePerch() {
    if (this.perch && this.perch.occupant === this) this.perch.occupant = null;
    this.perch = null;
  }

  _applyRoot() {
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.set(0, this.yaw, 0);
  }

  get forward() {
    return _v3.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  get headWorld() {
    return this.model.head.getWorldPosition(new THREE.Vector3());
  }

  say(text) {
    this.thought = text;
  }

  addLog(text) {
    const day = this.flock.day;
    this.log.unshift(`${day.clockString} ${text}`);
    if (this.log.length > 30) this.log.length = 30;
  }

  // ------------------------------------------------------------------ 主循环
  update(dt, ctx) {
    this._updatePhysiology(dt, ctx);
    this._perceiveT -= dt;
    if (this._perceiveT <= 0) {
      this._perceiveT = 0.25;
      this._perceive(ctx);
    }
    this.brain.update(dt, ctx);
    if (this.mode === 'air') this._updateFlight(dt, ctx);
    else this._updateGround(dt, ctx);
    this._applyRoot();
    // 动画
    const fwd = this.forward;
    this.anim.walkSpeed = this.mode === 'air' ? 0 : this.speed;
    this.anim.localVel.set(0, 0, this.mode === 'air' ? 0 : this.speed);
    // 视锥外的鸽子跳过网格重建；远处的鸽子隔帧重建
    let render = ctx.render !== false;
    if (render && ctx.frustum) {
      _sphere.center.copy(this.pos);
      _sphere.center.y += 0.12;
      if (!ctx.frustum.intersectsSphere(_sphere)) render = false;
      else if (ctx.camPos) {
        // 距离分级：8 m 内每帧，8–25 m 隔一帧，更远每三帧重建一次
        const d2 = ctx.camPos.distanceToSquared(this.pos);
        const every = d2 < 64 ? 1 : d2 < 625 ? 2 : 3;
        this._lod = ((this._lod || 0) + 1) % every;
        render = this._lod === 0;
      }
    }
    this.anim.update(dt, render);
    for (const e of this.anim.events) this._onAnimEvent(e);
    void fwd;
  }

  // ------------------------------------------------------------------ 生理
  _updatePhysiology(dt, ctx) {
    const h = ctx.dh; // 本帧经过的游戏小时
    const day = ctx.day;
    const flying = this.mode === 'air';
    const sleeping = this.brain.current?.name === 'sleep';
    const resting = sleeping || this.brain.current?.name === 'rest';
    // 代谢：基础代谢按“游戏小时”计；具体活动（飞行、步行）按其真实持续秒数计，
    // 因为动作本身是以真实速度播放的（一次 10 秒的飞行不应算作 20 分钟的飞行）。
    // 飞行的耗能约为静息的 10 倍以上。
    const walking = this.speed > 0.05 && !flying;
    const baseBurn = (sleeping ? 0.02 : 0.04) + this.cold * 0.02;
    this.nutrition = clamp(this.nutrition - baseBurn * h - (flying ? 0.0022 : walking ? 0.00015 : 0) * dt, 0, 1);
    // 嗉囊：暂存食物，再逐渐送入腺胃与砂囊消化
    if (this.cropG > 0) {
      const g = Math.min(this.cropG, BIO.digestGPerHour * h * (sleeping ? 0.6 : 1));
      this.cropG -= g;
      this.nutrition = clamp(this.nutrition + g / 26, 0, 1);
    }
    // 水分：干燥的谷物会加快失水；炎热时更多
    this.hydration = clamp(this.hydration - (0.045 + this.heat * 0.05) * h - (flying ? 0.0012 : 0) * dt, 0, 1);
    // 精力：白天消耗，睡眠恢复
    if (sleeping) this.energy = clamp(this.energy + 0.11 * h, 0, 1);
    else if (resting) this.energy = clamp(this.energy + 0.05 * h + 0.002 * dt, 0, 1);
    else this.energy = clamp(this.energy - 0.03 * h - (flying ? 0.0016 : 0) * dt, 0, 1);
    if (sleeping) this.stats.sleepH += h;
    // 羽毛清洁度
    this.hygiene = clamp(this.hygiene - 0.03 * h - (flying ? 0.0005 : 0) * dt, 0, 1);
    this.wet = Math.max(0, this.wet - dt * 0.05);
    // 同伴惊飞引起的连锁恐惧（略有延迟）
    if (this.pendingFear && this.flock.time >= this.pendingFear.at) {
      this.fear = Math.max(this.fear, this.pendingFear.value);
      this.alarmChain = this.pendingFear.chain;
      this.alarmThreat = this.pendingFear.threat;
      this.pendingFear = null;
    }
    // 恐惧随时间快速衰减（真实秒）
    this.fear = Math.max(0, this.fear - dt * 0.12 * (0.5 + this.bold));
    // 体温调节：低温时蓬羽，高温时张口散热、垂翅
    const T = day.temperature;
    this.cold = smoothstep(14, 6, T) + (this.wet > 0.3 ? 0.3 : 0);
    this.heat = smoothstep(27, 33, T) * (day.sunStrength > 0.4 ? 1 : 0.5);
    // 繁殖驱力：日照时长增加时升高（城市鸽子几乎全年繁殖）
    if (!this.juvenile) this.breedDrive = clamp(this.breedDrive + (this.sex === 'male' ? 0.05 : 0.035) * h * day.daylight, 0, 1);
    // 孤独感：远离同伴时上升（鸽子是高度群居的鸟）
    const nearby = this.perceived.neighbors.length;
    this.lonely = clamp(this.lonely + (nearby === 0 ? 0.2 : -0.6) * h * this.socialTrait, 0, 1);

    // 心率、呼吸、体温（用于信息面板）
    const exert = flying ? (this.flight?.phase === 'takeoff' ? 1 : 0.8) : this.speed > 0.4 ? 0.3 : this.speed > 0.05 ? 0.15 : 0;
    const hrTarget = sleeping ? 140 : lerp(190, 620, exert) + this.fear * 120;
    this.heartRate = damp(this.heartRate, hrTarget + Math.sin(performance.now() * 0.002 + this.id) * 4, 1.5, dt);
    const rrTarget = sleeping ? 22 : lerp(30, 165, exert) + this.heat * 80 + this.fear * 20;
    this.respRate = damp(this.respRate, rrTarget, 1.2, dt);
    this.bodyTemp = damp(this.bodyTemp, (sleeping ? 40.6 : 41.4) + exert * 1.2, 0.3, dt);
    this.anim.breath.rate = this.respRate / 60;
    this.anim.breath.depth = lerp(0.01, 0.025, exert) + this.heat * 0.01;
  }

  // ------------------------------------------------------------------ 感知
  _perceive(ctx) {
    const P = this.perceived;
    // 威胁：人、小孩、游隼。鸽子视野接近 340°，对快速接近的物体格外警觉。
    P.threat = null;
    P.threatDist = Infinity;
    let threatLevel = 0;
    for (const th of ctx.threats) {
      const d = th.position.distanceTo(this.pos);
      let level = 0;
      if (th.kind === 'falcon') {
        level = d < 45 ? 1.2 : 0;
      } else if (th.kind === 'scare') {
        level = smoothstep(9, 2.5, d) * (1.15 - this.bold * 0.3) * (this.mode === 'perch' ? 0.3 : 1);
      } else {
        const fid = lerp(BIO.flightInitiationDist[1], BIO.flightInitiationDist[0], this.bold) * (th.kind === 'child' ? 1.7 : 1);
        // 静止或缓慢的人威胁更小；朝自己走来的人更可怕
        let approach = 0.5;
        if (th.vel) {
          const to = _v.copy(this.pos).sub(th.position).setY(0).normalize();
          approach = clamp(th.vel.dot(to) / 1.2, 0, 1.4);
        }
        level = th.kind === 'feeder' ? 0 : smoothstep(fid * 2.2, fid * 0.6, d) * (0.45 + approach * 0.6);
        if (this.mode === 'perch') level *= 0.15;
      }
      if (level > threatLevel) { threatLevel = level; P.threat = th; P.threatDist = d; }
    }
    if (threatLevel > 0) this.fear = Math.max(this.fear, threatLevel);

    // 邻居
    P.neighbors.length = 0;
    for (const o of this.flock.pigeons) {
      if (o === this) continue;
      const d = o.pos.distanceTo(this.pos);
      if (d < 4) P.neighbors.push({ p: o, d });
    }
    P.neighbors.sort((a, b) => a.d - b.d);

    // 食物：在地面时搜索附近颗粒
    if (this.mode === 'ground') {
      const f = this.world.food.nearest(this.pos, 6, this);
      P.food = f;
      P.foodDist = f ? Math.hypot(f.pos.x - this.pos.x, f.pos.z - this.pos.z) : Infinity;
    } else {
      P.food = null;
      P.foodDist = Infinity;
    }
  }

  // ------------------------------------------------------------------ 地面运动
  walkTo(target, speed = BIO.walkSpeed, arrive = 0.05) {
    if (!this.moveTarget) this.moveTarget = V3();
    this.moveTarget.set(target.x, 0, target.z);
    this.moveSpeed = speed;
    this.arriveRadius = arrive;
    return Math.hypot(target.x - this.pos.x, target.z - this.pos.z);
  }

  stop() {
    this.moveTarget = null;
  }

  turnTowards(target, dt, rate = 5) {
    const a = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    this.yaw = dampAngle(this.yaw, a, rate, dt);
    return Math.abs(wrapAngle(a - this.yaw));
  }

  _updateGround(dt, ctx) {
    this.surfaceY = this.mode === 'perch' && this.perch ? this.perch.pos.y : this.world.groundY(this.pos.x, this.pos.z);
    let desired = 0;
    if (this.moveTarget && this.mode === 'ground') {
      const dx = this.moveTarget.x - this.pos.x, dz = this.moveTarget.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < this.arriveRadius) {
        this.moveTarget = null;
      } else {
        let sx = dx / dist, sz = dz / dist;
        // 与同伴保持个体距离
        for (const n of this.perceived.neighbors) {
          if (n.d > 0.3 || n.p.mode !== 'ground') continue;
          const ox = this.pos.x - n.p.pos.x, oz = this.pos.z - n.p.pos.z;
          const w = (0.3 - n.d) / 0.3;
          sx += (ox / (n.d + 1e-3)) * w * 0.8;
          sz += (oz / (n.d + 1e-3)) * w * 0.8;
        }
        // 绕开障碍
        for (const o of this.world.obstacles) {
          const ox = this.pos.x - o.x, oz = this.pos.z - o.z;
          const od = Math.hypot(ox, oz);
          if (od < o.r + 0.5) { const w = (o.r + 0.5 - od) / 0.5; sx += (ox / od) * w * 1.5; sz += (oz / od) * w * 1.5; }
        }
        const a = Math.atan2(sx, sz);
        this.yaw = dampAngle(this.yaw, a, 7, dt);
        const align = Math.max(0, Math.cos(wrapAngle(a - this.yaw)));
        desired = this.moveSpeed * align * smoothstep(0, 0.15, dist);
      }
    }
    this.speed = damp(this.speed, desired, 8, dt);
    if (this.mode === 'ground' && this.speed > 1e-3) {
      this.pos.x += Math.sin(this.yaw) * this.speed * dt;
      this.pos.z += Math.cos(this.yaw) * this.speed * dt;
      this.world.clampToBounds(this.pos, 0.2);
      this.stats.steps += (this.speed * dt) / 0.06;
    }
    // 防止与障碍物重叠
    for (const o of this.world.obstacles) {
      const ox = this.pos.x - o.x, oz = this.pos.z - o.z;
      const od = Math.hypot(ox, oz);
      if (od < o.r && this.mode === 'ground') { this.pos.x = o.x + (ox / od) * o.r; this.pos.z = o.z + (oz / od) * o.r; }
    }
    this.pos.y = this.surfaceY;
    this.vel.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
  }

  // ------------------------------------------------------------------ 飞行
  // target: { pos: Vector3, perch?: perch, kind: 'ground'|'perch'|'circle', center, radius, alt, duration }
  takeOff(target, { alarm = false, clap = true, display = false } = {}) {
    if (this.mode === 'perch') this.leavePerch();
    this.mode = 'air';
    this.moveTarget = null;
    this.stats.flights++;
    const startY = this.pos.y;
    const dist = Math.hypot(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
    const cruiseAlt = target.kind === 'circle' ? target.alt
      : Math.max(startY + (dist < 4 ? 0.8 : 2.5), (target.pos?.y ?? 0) + (dist < 4 ? 0.8 : 2.2), dist < 4 ? 0.9 : Math.min(14, 3 + dist * 0.35));
    this.flight = {
      phase: 'takeoff', t: 0, target, alarm, display, cruiseAlt, clapsLeft: clap ? (alarm ? 3 : 2) : 0,
      glideT: 0, speed: 0, done: false, landed: false, circleT: 0,
    };
    // 起飞初速度：向上并向前跃起
    const dir = _v.set(target.pos.x - this.pos.x, 0, target.pos.z - this.pos.z);
    if (dir.lengthSq() < 1e-4) dir.copy(this.forward);
    dir.normalize();
    this.vel.set(dir.x * 1.2, alarm ? 3.2 : 2.2, dir.z * 1.2);
    if (this.mode === 'air' && this.perch === null && startY > 1) this.vel.y = 0.8;
    this.anim.legMode = 'air';
    this.anim.startFlap({ freq: BIO.flapHzTakeoff * (alarm ? 1.1 : 1), amp: 1.15, bias: 0.15, flexAmt: 0.6, clap: clap });
    this.anim.set({ foldL: 0, foldR: 0, tailSpread: 0.9, tailPitch: 0.1 });
    this.flock.sound?.takeoff(this, alarm);
    this.addLog(alarm ? '受惊起飞' : '起飞');
  }

  get flying() {
    return this.mode === 'air';
  }

  _updateFlight(dt, ctx) {
    const F = this.flight;
    if (!F) return;
    F.t += dt;
    const T = F.target;
    const cruise = BIO.cruiseSpeed * FLIGHT_SCALE * (F.alarm ? 1.25 : 1);
    const tgtPos = this._tgtPos || (this._tgtPos = V3());
    let desiredSpeed = cruise;
    let desiredY = F.cruiseAlt;
    const anim = this.anim;

    if (T.kind === 'circle') {
      // 群飞盘旋：鸽群绕着家（楼房）大圈飞行
      F.circleT += dt;
      const ang = Math.atan2(this.pos.z - T.center.z, this.pos.x - T.center.x) + 0.6 * (T.dir || 1);
      tgtPos.set(T.center.x + Math.cos(ang) * T.radius, T.alt + Math.sin(F.circleT * 0.4 + this.id) * 1.5, T.center.z + Math.sin(ang) * T.radius);
      desiredY = tgtPos.y;
      if (F.circleT > T.duration && T.then) {
        // 盘旋结束后转向降落目标
        F.target = T.then;
        F.cruiseAlt = Math.max(T.then.pos.y + 2.5, 5);
        F.phase = 'cruise';
      }
    } else {
      tgtPos.copy(T.pos);
    }
    const toX = tgtPos.x - this.pos.x, toZ = tgtPos.z - this.pos.z;
    const horiz = Math.hypot(toX, toZ);
    const landing = T.kind !== 'circle';

    // ---- 阶段切换 ----
    if (F.phase === 'takeoff' && (F.t > 0.7 || this.pos.y > (T.pos?.y ?? 0) + 1.2)) F.phase = 'cruise';
    const approachDist = Math.max(2.2, (this.pos.y - (T.pos?.y ?? 0)) * 1.6);
    if (landing && F.phase === 'cruise' && horiz < approachDist + 1.5) F.phase = 'approach';
    if (landing && F.phase === 'approach' && horiz < 0.9 && this.pos.y - tgtPos.y < 0.8) F.phase = 'land';

    // ---- 期望速度 ----
    if (F.phase === 'takeoff') {
      desiredSpeed = cruise * 0.45;
      desiredY = this.pos.y + 2;
    } else if (F.phase === 'cruise') {
      desiredY = F.cruiseAlt;
      if (landing && horiz < 12) desiredY = lerp(tgtPos.y + 1.2, F.cruiseAlt, smoothstep(approachDist, 12, horiz));
    } else if (F.phase === 'approach') {
      desiredSpeed = lerp(1.6, cruise * 0.75, smoothstep(0.8, approachDist + 1.5, horiz));
      desiredY = tgtPos.y + lerp(0.15, 1.4, smoothstep(0.5, approachDist + 1.5, horiz));
    } else if (F.phase === 'land') {
      desiredSpeed = Math.min(1.2, horiz * 2.5);
      desiredY = tgtPos.y;
    }
    // 不能穿过楼房：低于屋顶时远离墙面
    const wallLimit = this.world.wallZ + 0.25;

    // 水平方向
    const dir = _v.set(toX, 0, toZ);
    if (horiz > 1e-3) dir.divideScalar(horiz);
    // 群体飞行：与同伴保持间距、对齐
    if (F.flockId) {
      const mates = this.flock.pigeons.filter((p) => p !== this && p.flight && p.flight.flockId === F.flockId);
      const sep = _v3.set(0, 0, 0);
      for (const m of mates) {
        const d = m.pos.distanceTo(this.pos);
        if (d < 1.2 && d > 1e-3) sep.add(_v2.copy(this.pos).sub(m.pos).multiplyScalar((1.2 - d) / d));
      }
      dir.addScaledVector(sep.setY(0), 0.6);
      if (dir.lengthSq() > 1e-6) dir.normalize();
    }
    const vy = clamp((desiredY - this.pos.y) * 1.6, -4.5, F.phase === 'takeoff' ? 4 : 3);
    const dv = _v3.set(dir.x * desiredSpeed, vy, dir.z * desiredSpeed);
    const accel = F.phase === 'land' ? 6 : F.phase === 'takeoff' ? 5 : 2.5;
    const prevVel = this.vel.clone();
    this.vel.lerp(dv, 1 - Math.exp(-accel * dt));
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < this.world.roofY + 1 && this.pos.z < wallLimit) this.pos.z = wallLimit;
    this.pos.y = Math.max(this.pos.y, this.world.groundY(this.pos.x, this.pos.z));
    this.stats.flownM += this.vel.length() * dt;

    // ---- 姿态：朝向、侧倾、俯仰 ----
    const hs = Math.hypot(this.vel.x, this.vel.z);
    let roll = 0;
    if (hs > 0.3) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      const yawRate = wrapAngle(targetYaw - this.yaw) / Math.max(dt, 1e-3);
      this.yaw = dampAngle(this.yaw, targetYaw, 6, dt);
      roll = clamp(-yawRate * hs * 0.012, -0.9, 0.9);
    } else if (landing) {
      this.turnTowards(T.perch ? _v3.copy(T.pos).add(new THREE.Vector3(Math.sin(T.perch.yaw), 0, Math.cos(T.perch.yaw))) : tgtPos, dt, 3);
    }
    const climb = Math.atan2(this.vel.y, Math.max(hs, 0.5));
    let bodyPitch = clamp(-climb * 0.6, -0.5, 0.5);
    void prevVel;

    // ---- 翅膀 ----
    if (F.phase === 'takeoff') {
      anim.startFlap({ freq: BIO.flapHzTakeoff, amp: 1.15, bias: 0.15, flexAmt: 0.6, clap: F.clapsLeft > 0 });
      anim.set({ tailSpread: 0.9, tailPitch: 0.15, spread: 1.05, sweep: 0 });
      bodyPitch = -0.55;
    } else if (F.phase === 'cruise') {
      // 平飞：振翅与短暂滑翔交替；炫耀飞行时双翅上举成 V 形滑翔
      F.glideT -= dt;
      const gliding = F.glideT > 0;
      if (F.glideT < -rand(2.5, 5) && !F.alarm) F.glideT = F.display ? rand(1.5, 2.5) : rand(0.6, 1.4);
      const descending = this.vel.y < -0.8;
      anim.startFlap({
        freq: BIO.flapHzCruise + (F.alarm ? 1 : 0), amp: gliding || descending ? 0 : 0.78, bias: gliding ? (F.display ? 0.5 : 0.12) : 0.08,
        flexAmt: 0.45, clap: false, glide: gliding || descending ? 1 : 0,
      });
      anim.set({ tailSpread: 0.15 + Math.abs(roll) * 0.4, tailPitch: 0, spread: 1, sweep: gliding ? 0.15 : 0.05, tailYaw: -roll * 0.2 });
    } else if (F.phase === 'approach') {
      anim.startFlap({ freq: 7.5, amp: horiz < 2.2 ? 0.95 : 0.25, bias: 0.15, flexAmt: 0.5, clap: false, glide: horiz < 2.2 ? 0 : 0.8 });
      anim.set({ tailSpread: 0.75, tailPitch: -0.1, spread: 1.05, sweep: -0.12 });
      bodyPitch = lerp(-0.7, bodyPitch, smoothstep(0.8, 3, horiz));
      if (horiz < 1.6) anim.legMode = 'land';
    } else if (F.phase === 'land') {
      // 拉平：身体上仰、尾羽全张作为减速板、双腿前伸
      anim.startFlap({ freq: 8.5, amp: 1.05, bias: 0.2, flexAmt: 0.55, clap: false, glide: 0 });
      anim.set({ tailSpread: 1, tailPitch: -0.25, spread: 1.1, sweep: -0.25 });
      anim.legMode = 'land';
      bodyPitch = -0.95;
      const dy = this.pos.y - tgtPos.y;
      const dh = Math.hypot(tgtPos.x - this.pos.x, tgtPos.z - this.pos.z);
      if ((dy < 0.06 && dh < 0.25) || F.t > 30) this._touchDown(T);
    }
    anim.set({ bodyPitch: bodyPitch, bodyRoll: roll, bodyHeight: 0.1, head: new THREE.Vector3(0, 0.125, 0.105), headPitch: -0.05 - bodyPitch * 0.9, headYaw: 0, headRoll: -roll * 0.8 });
    anim.speed.body = F.phase === 'land' ? 6 : 4;
    anim.lookAround = false;
    if (F.alarm && F.t > 8 && T.kind !== 'circle') F.alarm = false;
  }

  _touchDown(T) {
    const F = this.flight;
    this.anim.stopFlap();
    this.anim.legMode = 'ground';
    this.anim.speed.body = 8;
    this.anim.lookAround = true;
    this.anim.set({ foldL: 1, foldR: 1, tailSpread: 0.2, spread: 1, sweep: 0, tailYaw: 0, bodyRoll: 0, bodyPitch: -0.38, head: new THREE.Vector3(0, 0.18, 0.074), headPitch: 0.15 });
    this.vel.set(0, 0, 0);
    if (T.perch) {
      if (T.perch.occupant && T.perch.occupant !== this) {
        // 栖位被占：重新找一个
        const alt = this.world.freePerch(this.pos, [T.perch.kind], this);
        if (alt) { F.target = { pos: alt.pos.clone(), perch: alt, kind: 'perch' }; F.phase = 'approach'; return; }
      }
      this.placeOnPerchSoft(T.perch);
    } else {
      this.mode = 'ground';
      this.pos.y = this.world.groundY(this.pos.x, this.pos.z);
      this.surfaceY = this.pos.y;
    }
    for (const f of this.anim.feet) f.init = false;
    F.landed = true;
    F.done = true;
    this.flight = null;
    this.speed = 0;
    this.flock.sound?.land(this);
    this.addLog(T.perch ? '落在' + ({ ledge: '窗台', roof: '屋檐', lamp: '路灯', nest: '巢' }[T.perch.kind] || '高处') : '降落在地面');
  }

  placeOnPerchSoft(perch) {
    this.mode = 'perch';
    this.perch = perch;
    perch.occupant = this;
    this.pos.copy(perch.pos);
    this.surfaceY = perch.pos.y;
  }

  // ------------------------------------------------------------------ 动画事件
  _onAnimEvent(e) {
    if (e.type === 'peck') {
      this.stats.pecks++;
      const tgt = e.data.target;
      if (e.data.eat && this._peckFood && this._peckFood.alive) {
        const f = this._peckFood;
        const d = Math.hypot(f.pos.x - tgt.x, f.pos.z - tgt.z);
        if (d < 0.02) {
          // 吞下：鸽子不咀嚼，整粒吞入嗉囊
          const g = f.grams;
          this.world.food.remove(f);
          this.cropG = Math.min(BIO.cropCapacityG, this.cropG + g);
          this.stats.eatenG += g;
          this.stats.seeds++;
          this.anim.swallow = 1;
          this._peckFood = null;
          this._ateOne = true;
        }
      }
    } else if (e.type === 'clap') {
      if (this.flight && this.flight.clapsLeft > 0) {
        this.flight.clapsLeft--;
        this.flock.sound?.clap(this);
      }
    } else if (e.type === 'downstroke') {
      if (this.flight && (this.flight.phase === 'takeoff' || this.flight.phase === 'land')) this.flock.sound?.flap(this);
    }
  }

  dispose() {
    this.world.scene.remove(this.model.root);
    this.model.dispose();
  }
}
