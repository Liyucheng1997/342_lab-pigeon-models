import * as THREE from 'three';
import { applyPose, POSES, PREEN_SPOTS } from './Poses.js';
import { BIO } from '../config.js';
import { clamp, lerp, rand, randInt, pick, chance, smoothstep, wrapAngle, dist2D } from '../utils/math.js';

// =====================================================================================
//  行为库。每个行为：
//    static score(p, ctx)  —— 根据鸽子当前的需求与环境给出效用值
//    start / update(dt) / stop —— 具体执行（update 返回 true 表示完成）
//  行为的选择由 Brain 完成（效用 AI + 惯性 + 随机扰动）。
// =====================================================================================

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _v = V3();

// ---------------------------------------------------------------- 导航：步行或飞行到目标
export class Nav {
  constructor(p, target, { speed = BIO.walkSpeed, flyIfFarther = 7, arrive = 0.06, alarm = false, display = false } = {}) {
    this.p = p;
    this.target = target;           // { pos, perch?, kind }
    this.speed = speed;
    this.flyIfFarther = flyIfFarther;
    this.arrive = arrive;
    this.alarm = alarm;
    this.display = display;
    this.flying = false;
    this.t = 0;
  }

  update(dt) {
    const p = this.p, T = this.target;
    this.t += dt;
    if (p.mode === 'air') {
      if (!this.flying && p.flight) p.flight.target = T; // 空中改变目标
      this.flying = true;
      return 'running';
    }
    if (this.flying) {
      // 已落地
      this.flying = false;
      this.flewOnce = true;
      if (T.kind === 'circle') return 'arrived';
      if (T.perch) return p.perch === T.perch ? 'arrived' : 'failed';
    }
    if (T.kind === 'circle') {
      p.takeOff(T, { alarm: this.alarm, display: this.display });
      this.flying = true;
      return 'running';
    }
    if (T.perch) {
      if (p.mode === 'perch' && p.perch === T.perch) return 'arrived';
      p.takeOff(T, { alarm: this.alarm, display: this.display });
      this.flying = true;
      return 'running';
    }
    // 地面目标
    if (p.mode === 'perch') {
      p.takeOff({ pos: T.pos.clone().setY(0), kind: 'ground' }, { alarm: this.alarm, display: this.display });
      this.flying = true;
      return 'running';
    }
    const d = dist2D(p.pos, T.pos);
    // 已经飞过一次的，落地后剩下的短距离步行过去
    if (d > this.flyIfFarther && (!this.flewOnce || d > 5)) {
      p.takeOff({ pos: T.pos.clone().setY(0), kind: 'ground' }, { alarm: this.alarm, display: this.display });
      this.flying = true;
      return 'running';
    }
    if (d <= this.arrive) {
      p.stop();
      return 'arrived';
    }
    p.walkTo(T.pos, this.speed, this.arrive * 0.8);
    if (this.t > 40) return 'failed';
    return 'running';
  }
}

// ---------------------------------------------------------------- 基类
export class Behavior {
  static key = 'base';
  static label = '';
  static modes = ['ground', 'perch'];
  constructor(p, ctx) {
    this.p = p;
    this.ctx = ctx;
    this.t = 0;
    this.maxT = 30;
  }
  get name() { return this.constructor.key; }
  get label() { return this.constructor.label; }
  get interruptible() { return true; }
  start() {}
  update() { return true; }
  stop() {}
  pose(name, extra) { applyPose(this.p.anim, name, extra); }
}

const daylightOf = (ctx) => ctx.day.daylight;

// ================================================================= 站立张望
export class Idle extends Behavior {
  static key = 'idle';
  static label = '站立张望';
  static score(p) { return 0.14 + (p.mode === 'perch' ? 0.08 : 0); }
  start() {
    this.maxT = rand(2.5, 7);
    this.pose(this.p.mode === 'perch' && chance(0.3) ? 'oneLeg' : 'stand');
    if (this.p.anim.t.lid > 0.5) this.p.anim.set({ lid: 0 });
    this.p.anim.lookAround = true;
    this.p.say(pick(['四处张望，用一侧的眼睛打量周围', '歪头看看天空有没有猛禽', '安静地站着，观察同伴']));
  }
  update(dt) {
    this.p.stop();
    return this.t > this.maxT;
  }
}

// ================================================================= 闲逛（靠拢鸽群）
export class Wander extends Behavior {
  static key = 'wander';
  static label = '踱步';
  static modes = ['ground'];
  static score(p) { return 0.1 + p.lonely * 0.9; }
  start() {
    const p = this.p;
    let target;
    const others = p.flock.pigeons.filter((o) => o !== p && o.mode === 'ground');
    if (p.lonely > 0.3 && others.length) {
      // 向鸽群中心靠拢
      const c = V3();
      for (const o of others) c.add(o.pos);
      c.divideScalar(others.length);
      target = c.add(V3(rand(-0.8, 0.8), 0, rand(-0.8, 0.8)));
      p.say('离同伴太远了，走回鸽群里');
    } else {
      target = p.world.randomGroundPoint(p.pos, 2.5);
      p.say('慢悠悠地踱步，一步一点头');
    }
    p.world.clampToBounds(target, 0.5);
    this.nav = new Nav(p, { pos: target, kind: 'ground' }, { flyIfFarther: 12 });
    this.pose('walk');
  }
  update(dt) {
    const r = this.nav.update(dt);
    return r !== 'running' || this.t > 25;
  }
}

// ================================================================= 觅食
export class Forage extends Behavior {
  static key = 'forage';
  static label = '觅食';
  static modes = ['ground'];
  static score(p, ctx) {
    const hunger = 1 - p.nutrition;
    const crop = p.cropG / BIO.cropCapacityG;
    let s = (hunger - 0.2) * 1.8 - crop * 1.4;
    // 机会主义：眼前就有食物时，即使不太饿也会顺便啄几口
    if (p.perceived.food) s += p.perceived.foodDist < 1.5 ? 0.5 * (1 - crop) : 0.22;
    if (crop > 0.92) s -= 1;
    return Math.max(0, s) * (0.25 + 0.75 * daylightOf(ctx));
  }
  start() {
    this.food = null;
    this.state = 'seek';
    this.searchT = 0;
    this.maxT = rand(25, 50);
    this.pose('walk');
    this.p.anim.lookAround = true;
  }
  _release() {
    if (this.food && this.food.claimedBy === this.p) this.food.claimedBy = null;
    this.food = null;
  }
  stop() {
    this._release();
    this.p.anim.lookAround = true;
  }
  update(dt, ctx) {
    const p = this.p;
    const crop = p.cropG / BIO.cropCapacityG;
    if (crop > 0.95 || (p.nutrition > 0.92 && crop > 0.4)) { p.say('嗉囊装满了，不吃了'); return true; }
    if (this.t > this.maxT) return true;

    // 远处有大量食物（老人撒的谷子、成群觅食的同伴）→ 走过去或飞过去
    if (!this.food && this.state === 'seek') {
      const f = p.perceived.food;
      if (f && (!f.claimedBy || f.claimedBy === p)) {
        this.food = f;
        f.claimedBy = p;
        this.state = 'approach';
      } else {
        const spot = p.flock.attractiveFeedingSpot(p);
        if (spot && dist2D(spot, p.pos) > 5) {
          this.nav = new Nav(p, { pos: spot.clone(), kind: 'ground' }, { flyIfFarther: 8, speed: BIO.hurrySpeed * 0.8 });
          this.state = 'travel';
          p.say('看见那边有同伴在吃东西，赶过去');
        } else {
          this.state = 'search';
          this.searchT = 0;
          this.searchTarget = p.world.randomGroundPoint(p.pos, 1.5);
          this.peckT = rand(0.5, 1.5);
          p.say('低着头在地面搜寻食物，偶尔啄几下砂砾');
        }
      }
    }
    if (this.state === 'travel') {
      const r = this.nav.update(dt);
      if (r !== 'running') { this.state = 'seek'; this.pose('walk'); }
      return false;
    }
    if (this.state === 'search') {
      this.searchT += dt;
      this.pose('forage');
      p.walkTo(this.searchTarget, BIO.walkSpeed * 0.7, 0.05);
      this.peckT -= dt;
      if (this.peckT <= 0 && !p.anim.pecking) {
        this.peckT = rand(0.6, 2);
        const g = V3(rand(-0.03, 0.03), 0.002, 0.085).applyAxisAngle(V3(0, 1, 0), p.yaw).add(p.pos);
        p.anim.peck(g, { eat: false });
        // 偶尔找到天然的碎屑；同时会吞下少量砂砾帮助砂囊研磨食物
        if (chance(0.22)) {
          p.cropG = Math.min(BIO.cropCapacityG, p.cropG + 0.15);
          p.stats.eatenG += 0.15;
          p.anim.swallow = 1;
        }
      }
      if (p.perceived.food && p.perceived.foodDist < 4) { this.state = 'seek'; this.pose('walk'); }
      if (!p.moveTarget || this.searchT > 4) {
        this.searchTarget = p.world.randomGroundPoint(p.pos, 1.5);
        this.searchT = 0;
      }
      return false;
    }
    if (this.state === 'approach') {
      const f = this.food;
      if (!f || !f.alive) { this._release(); this.state = 'seek'; return false; }
      // 头部朝向食物：脚停在食物后方约 8 cm 处
      const d = dist2D(p.pos, f.pos);
      const ang = Math.abs(wrapAngle(Math.atan2(f.pos.x - p.pos.x, f.pos.z - p.pos.z) - p.yaw));
      if (d > 0.11 || ang > 0.5) {
        const stand = _v.copy(f.pos).sub(p.pos).setY(0);
        const len = stand.length();
        stand.multiplyScalar(Math.max(0, len - 0.085) / Math.max(len, 1e-4)).add(p.pos);
        p.walkTo(len > 0.11 ? stand : f.pos, d > 1.5 ? BIO.hurrySpeed : BIO.walkSpeed, 0.02);
        if (len <= 0.11) p.turnTowards(f.pos, dt, 8);
        this.pose(d < 0.6 ? 'forage' : 'walk');
        p.say(d > 1.5 ? '发现食物！快步走过去' : '盯准一粒谷子');
        // 争夺：附近有低等级的同伴也在抢 → 啄赶 / 扬翅威胁
        const rival = p.perceived.neighbors.find((n) => n.d < 0.22 && n.p.brain.current?.name === 'forage' && n.p.mode === 'ground');
        if (rival && p.rank > rival.p.rank + 0.2 && chance(0.02)) {
          p.anim.peck(rival.p.headWorld, { eat: false, duration: 0.25 });
          p.anim.set(rival.p.pos.x - p.pos.x > 0 ? { raiseL: 0.35 } : { raiseR: 0.35 });
          rival.p.fear = Math.max(rival.p.fear, 0.3);
          rival.p.brain.nudge = { from: p, until: ctx.time + 1 };
          p.say('啄开抢食的同伴（等级较高）');
          setTimeout(() => p.anim.set({ raiseL: 0, raiseR: 0 }), 400);
        }
        return false;
      }
      p.stop();
      if (!p.anim.pecking) {
        p._peckFood = f;
        p.anim.peck(f.pos, { eat: true, duration: rand(0.26, 0.36) });
        this.state = 'pecking';
        p.say('啄食——啄击最后一瞬会闭上眼睛');
      }
      return false;
    }
    if (this.state === 'pecking') {
      if (!p.anim.pecking) {
        if (this.food && this.food.alive && p._peckFood === this.food) {
          // 没啄中，再来一次
          this.state = 'approach';
        } else {
          this.food = null;
          this.state = 'seek';
        }
      }
      return false;
    }
    return false;
  }
}

// ================================================================= 饮水（吸吮式）
export class Drink extends Behavior {
  static key = 'drink';
  static label = '饮水';
  static modes = ['ground', 'perch'];
  static score(p, ctx) {
    const thirst = 1 - p.hydration;
    return Math.max(0, thirst * 1.6 - 0.25 + (p.cropG > 6 ? 0.15 : 0) + p.heat * 0.4) * (0.2 + 0.8 * daylightOf(ctx));
  }
  start() {
    const p = this.p;
    this.edge = p.world.poolEdgePoint(p.mode === 'ground' ? p.pos : V3(rand(-5, 5), 0, rand(-2, 6)), 0.06);
    this.nav = new Nav(p, { pos: this.edge, kind: 'ground' }, { flyIfFarther: 9, arrive: 0.07 });
    this.state = 'go';
    this.sips = 0;
    this.pose('walk');
    p.say('口渴了，去水洼喝水');
  }
  stop() {
    this.p.anim.headBob = true;
  }
  update(dt, ctx) {
    const p = this.p, W = p.world;
    if (this.state === 'go') {
      const r = this.nav.update(dt);
      if (r === 'arrived') { this.state = 'face'; }
      else if (r === 'failed') return true;
      return false;
    }
    const center = V3(W.pool.x, 0, W.pool.z);
    if (this.state === 'face') {
      const err = p.turnTowards(center, dt, 6);
      this.pose('stand');
      if (err < 0.1) { this.state = 'down'; this.tt = 0; }
      return false;
    }
    // 鸽子把喙插入水中像吸管一样连续吸水，不需要像大多数鸟那样仰头吞咽
    const reach = V3(0, W.pool.waterY - 0.004, 0.115);
    if (this.state === 'down' || this.state === 'sip') {
      this.pose('stand', {
        bodyPitch: -0.12, bodyHeight: 0.095,
        head: V3(0, reach.y + 0.026, reach.z - 0.03), headPitch: 1.22, headYaw: 0, headRoll: 0,
        tailPitch: 0.05,
      });
      p.anim.lookAround = false;
      p.anim.headBob = false;
      this.tt += dt;
      if (this.state === 'down' && this.tt > 0.4) { this.state = 'sip'; this.tt = 0; this.dur = rand(2.5, 5); this.pulse = 0; }
      if (this.state === 'sip') {
        this.pulse -= dt;
        if (this.pulse <= 0) {
          this.pulse = 0.55;
          p.anim.swallow = 1; // 喉部有节奏地抽动
          const tip = V3(0, 0, 0.115).applyAxisAngle(V3(0, 1, 0), p.yaw).add(p.pos);
          W.ripple(tip.x, tip.z, 0.06);
        }
        const ml = BIO.sipMlPerSecond * dt;
        p.hydration = Math.min(1, p.hydration + ml * 0.045);
        p.stats.drankMl += ml;
        p.say('喙浸在水里连续吸水（鸽子特有的饮水方式）');
        if (this.tt > this.dur) {
          this.sips++;
          this.state = 'up';
          this.tt = 0;
          this.pose('stand');
          p.anim.lookAround = true;
        }
      }
      return false;
    }
    if (this.state === 'up') {
      this.tt += dt;
      if (this.tt > rand(0.8, 1.6)) {
        if (p.hydration < 0.9 && this.sips < 3) { this.state = 'down'; this.tt = 0; }
        else return true;
      }
    }
    return false;
  }
}

// ================================================================= 理羽
export class Preen extends Behavior {
  static key = 'preen';
  static label = '理羽';
  static score(p) {
    return Math.max(0, (1 - p.hygiene) * 1.25 - 0.05 + p.wet * 1.4 + (p.wantPreen ? 0.8 : 0) - p.fear * 2);
  }
  start() {
    this.queue = [];
    const n = randInt(4, 8);
    for (let i = 0; i < n; i++) this.queue.push(pick(PREEN_SPOTS));
    this.cur = null;
    this.spotT = 0;
    this.p.stop();
    this.p.anim.lookAround = false;
    this.p.anim.headBob = false;
    this.p.wantPreen = false;
  }
  stop() {
    const a = this.p.anim;
    a.nibble = 0;
    a.lookAround = true;
    a.headBob = true;
    a.set({ raiseL: 0, raiseR: 0, foldL: 1, foldR: 1, headYaw: 0, headRoll: 0 });
  }
  update(dt) {
    const p = this.p, a = p.anim;
    this.spotT -= dt;
    if (this.spotT <= 0) {
      this.cur = this.queue.shift();
      if (!this.cur) {
        this.stop();
        if (chance(0.5)) a.shake();
        return true;
      }
      this.spotT = rand(1.6, 3.2);
      const s = this.cur;
      this.pose('stand', {
        fluff: 0.35, head: s.head, headYaw: s.yaw, headPitch: s.pitch, headRoll: s.roll,
        raiseL: s.raiseL || 0, raiseR: s.raiseR || 0, foldL: s.foldL ?? 1, foldR: s.foldR ?? 1,
      });
      p.say(`用喙梳理${s.name}，把羽小钩重新扣合`);
    }
    a.nibble = 1;
    p.hygiene = Math.min(1, p.hygiene + dt * 0.012);
    p.wet = Math.max(0, p.wet - dt * 0.02);
    p.stats.preenS += dt;
    return false;
  }
}

// ================================================================= 水浴
export class Bathe extends Behavior {
  static key = 'bathe';
  static label = '水浴';
  static modes = ['ground', 'perch'];
  static score(p, ctx) {
    if (ctx.day.temperature < 13) return 0;
    const bathing = p.flock.pigeons.filter((o) => o.brain.current?.name === 'bathe').length;
    if (bathing >= 3) return 0;
    return Math.max(0, (1 - p.hygiene) * 1.0 - 0.3 + p.heat * 0.5) * daylightOf(ctx) * (p.wet > 0.2 ? 0 : 1);
  }
  start() {
    const p = this.p, W = p.world;
    const a = rand(0, Math.PI * 2), r = rand(0.2, 0.6);
    this.spot = V3(W.pool.x + Math.cos(a) * r, 0, W.pool.z + Math.sin(a) * r);
    this.nav = new Nav(p, { pos: this.spot, kind: 'ground' }, { flyIfFarther: 9, arrive: 0.1 });
    this.state = 'go';
    this.pose('walk');
    p.say('天气不错，去水洼洗个澡');
  }
  stop() {
    this.p.anim.set({ raiseL: 0, raiseR: 0, foldL: 1, foldR: 1, droop: 0 });
  }
  update(dt) {
    const p = this.p, W = p.world;
    if (this.state === 'go') {
      const r = this.nav.update(dt);
      if (r === 'arrived') { this.state = 'bath'; this.tt = 0; this.dur = rand(6, 11); }
      else if (r === 'failed') return true;
      return false;
    }
    if (this.state === 'bath') {
      this.tt += dt;
      // 蹲进水里，蓬起羽毛，双翅反复拍打溅水，身体左右侧倾
      const ph = this.tt * 7;
      const flutter = Math.sin(ph);
      this.pose('sit', {
        bodyHeight: 0.07, fluff: 1, bodyRoll: Math.sin(this.tt * 2.2) * 0.25,
        raiseL: 0.25 + 0.3 * Math.max(0, flutter), raiseR: 0.25 + 0.3 * Math.max(0, -flutter),
        foldL: 0.45 + 0.3 * Math.abs(flutter), foldR: 0.45 + 0.3 * Math.abs(flutter),
        head: V3(0, 0.12 + 0.02 * Math.sin(this.tt * 3), 0.07), headPitch: 0.6 + 0.4 * Math.sin(this.tt * 3),
        tailSpread: 0.6,
      });
      p.anim.speed.wing = 25;
      if (Math.random() < dt * 8) {
        const s = p.pos.clone().add(V3(rand(-0.12, 0.12), 0.05, rand(-0.12, 0.12)));
        W.splash(s, 4, 0.8);
        W.ripple(s.x, s.z, 0.2);
      }
      p.wet = Math.min(1, p.wet + dt * 0.15);
      p.hygiene = Math.min(1, p.hygiene + dt * 0.03);
      p.say('在水里扑腾，抖动翅膀把水溅到全身');
      if (this.tt > this.dur) {
        p.anim.speed.wing = 14;
        this.state = 'out';
        this.out = p.world.poolEdgePoint(p.pos, 0.3);
        this.nav = new Nav(p, { pos: this.out, kind: 'ground' }, { flyIfFarther: 99 });
        this.pose('walk', { fluff: 0.8, droop: 0.2 });
      }
      return false;
    }
    if (this.state === 'out') {
      const r = this.nav.update(dt);
      if (r !== 'running') {
        p.anim.shake();
        p.wantPreen = true;
        p.say('出水后抖一抖羽毛，接下来要好好理羽');
        return true;
      }
    }
    return false;
  }
}

// ================================================================= 日光浴
export class Sunbathe extends Behavior {
  static key = 'sunbathe';
  static label = '日光浴';
  static modes = ['ground'];
  static score(p, ctx) {
    const d = ctx.day;
    const timeOk = d.hour < 11 || d.hour > 15 ? 1 : 0.35;
    return d.sunStrength * (p.cold * 0.9 + 0.15 + p.wet * 0.5) * timeOk * (p.fear > 0.2 ? 0 : 1);
  }
  start() {
    this.maxT = rand(10, 22);
    const sun = this.ctx.day.sunDir;
    this.side = (Math.sin(Math.atan2(sun.x, sun.z) - this.p.yaw) > 0) ? 1 : -1;
    this.p.stop();
    this.p.say('侧卧着张开一侧翅膀晒太阳，让阳光照进羽毛');
  }
  stop() {
    this.p.anim.set({ raiseL: 0, raiseR: 0, foldL: 1, foldR: 1, bodyRoll: 0, tailSpread: 0.05 });
  }
  update(dt) {
    const s = this.side;
    const k = smoothstep(0, 1.5, this.t) * (1 - smoothstep(this.maxT - 1.5, this.maxT, this.t));
    this.pose('sit', {
      bodyHeight: 0.06, bodyRoll: s * 0.55 * k, fluff: 0.8,
      raiseL: s > 0 ? 0.75 * k : 0, foldL: s > 0 ? 1 - 0.75 * k : 1,
      raiseR: s < 0 ? 0.75 * k : 0, foldR: s < 0 ? 1 - 0.75 * k : 1,
      tailSpread: 0.85 * k, head: V3(s * 0.02, 0.135, 0.06), headRoll: s * 0.5 * k, lid: 0.6 * k,
    });
    this.p.anim.legMode = 'sit';
    this.p.cold = Math.max(0, this.p.cold - dt * 0.02);
    this.p.wet = Math.max(0, this.p.wet - dt * 0.03);
    if (this.t > this.maxT) { this.p.anim.legMode = 'ground'; return true; }
    return false;
  }
}

// ================================================================= 小憩
export class Rest extends Behavior {
  static key = 'rest';
  static label = '小憩';
  static score(p, ctx) {
    const h = ctx.day.hour;
    return Math.max(0, (1 - p.energy) * 0.9 + (h > 11.5 && h < 14 ? 0.32 : 0) + (p.cropG / BIO.cropCapacityG) * 0.25 - p.fear * 2 - p.lonely * 0.3);
  }
  start() {
    this.maxT = rand(14, 35);
    this.oneLeg = chance(0.35);
    this.p.stop();
    this.p.say(this.oneLeg ? '单脚站立打盹，另一只脚缩进腹羽保暖' : '蹲伏下来，蓬起羽毛休息，眼睛半闭');
  }
  stop() {
    this.p.anim.legMode = 'ground';
  }
  update(dt) {
    const p = this.p;
    if (this.oneLeg) { this.pose('oneLeg'); p.anim.legMode = 'oneLeg'; }
    else { this.pose('sit', { lid: 0.55 + 0.4 * Math.max(0, Math.sin(this.t * 0.4)) }); p.anim.legMode = 'sit'; }
    p.anim.lookAround = chance(0.5);
    if (this.t > this.maxT) { p.anim.legMode = 'ground'; p.anim.shake(); return true; }
    return false;
  }
}

// ================================================================= 伸展
export class Stretch extends Behavior {
  static key = 'stretch';
  static label = '伸展';
  static score(p) { return p.brain.since('stretch') > 60 ? 0.12 + (p.brain.lastKey === 'rest' || p.brain.lastKey === 'sleep' ? 0.6 : 0) : 0; }
  start() {
    this.kind = chance(0.5) ? 'both' : chance(0.5) ? 'L' : 'R';
    this.maxT = 2.6;
    this.p.stop();
    this.p.say(this.kind === 'both' ? '双翅高举伸个懒腰' : '一侧翅膀连同同侧的腿向后伸展');
  }
  stop() { this.p.anim.set({ raiseL: 0, raiseR: 0, foldL: 1, foldR: 1, sweep: 0 }); }
  update() {
    const k = Math.sin(clamp(this.t / this.maxT, 0, 1) * Math.PI);
    if (this.kind === 'both') this.pose('stand', { raiseL: 1.1 * k, raiseR: 1.1 * k, foldL: 1 - 0.7 * k, foldR: 1 - 0.7 * k, headPitch: 0.4 });
    else if (this.kind === 'L') this.pose('stand', { raiseL: -0.25 * k, foldL: 1 - 0.9 * k, sweep: 0.5 * k, tailSpread: 0.7 * k, bodyRoll: 0.08 * k });
    else this.pose('stand', { raiseR: -0.25 * k, foldR: 1 - 0.9 * k, sweep: 0.5 * k, tailSpread: 0.7 * k, bodyRoll: -0.08 * k });
    return this.t > this.maxT;
  }
}

// ================================================================= 咕咕叫（栖鸣 / 巢鸣）
export class Coo extends Behavior {
  static key = 'coo';
  static label = '咕咕鸣叫';
  static score(p) {
    if (p.sex !== 'male' || p.juvenile || p.brain.since('coo') < 25) return 0;
    return p.breedDrive * 0.35 + (p.mode === 'perch' ? 0.15 : 0);
  }
  start() {
    this.n = randInt(2, 4);
    this.k = 0;
    this.next = 0.3;
    this.p.stop();
    this.p.say(this.p.mode === 'perch' ? '在栖处鼓起嗉囊“咕——噜——咕”地宣示领地' : '鼓起颈部发出低沉的咕咕声');
  }
  update(dt) {
    const p = this.p;
    this.next -= dt;
    const phase = clamp(1 - this.next / 1.6, 0, 1);
    const inflate = Math.sin(phase * Math.PI);
    this.pose('stand', { neckPuff: 0.6 + inflate * 0.4, crop: inflate, head: V3(0, 0.17 - inflate * 0.02, 0.07), headPitch: 0.3 + inflate * 0.3, tailSpread: 0.25 });
    p.anim.lookAround = false;
    if (this.next <= 0) {
      if (this.k >= this.n) { p.anim.lookAround = true; return true; }
      this.k++;
      this.next = 1.6;
      p.stats.coos++;
      p.flock.sound?.coo(p, 'perch');
    }
    return false;
  }
}

// ================================================================= 求偶（雄鸽：鞠躬咕咕、转圈、追逐）
export class Court extends Behavior {
  static key = 'court';
  static label = '求偶炫耀';
  static modes = ['ground'];
  static target(p) {
    if (p.mate) return p.mate.mode === 'ground' && dist2D(p.mate.pos, p.pos) < 6 ? p.mate : null;
    let best = null, bd = 6;
    for (const n of p.perceived.neighbors) {
      const o = n.p;
      if (o.sex !== 'female' || o.mate || o.juvenile || o.mode !== 'ground') continue;
      if (n.d < bd) { bd = n.d; best = o; }
    }
    return best;
  }
  static score(p, ctx) {
    if (p.sex !== 'male' || p.juvenile || p.brain.since('court') < 30) return 0;
    if (!Court.target(p)) return 0;
    const hunger = 1 - p.nutrition;
    const bonded = p.pair && p.pair.stage !== 'courting' ? 0.4 : 1;
    return Math.max(0, p.breedDrive * 1.35 * bonded - hunger * 0.45 - p.fear) * daylightOf(ctx);
  }
  start() {
    this.f = Court.target(this.p);
    this.maxT = rand(12, 24);
    this.bowT = 0;
    this.spin = 0;
    this.mode = 'approach';
    this.p.say(`看上了${this.f?.name}，开始求偶`);
    this.p.addLog(`向 ${this.f?.name} 求偶`);
  }
  stop() {
    this.p.anim.set({ neckPuff: 0, crop: 0, tailSpread: 0.05, tailPitch: 0.22 });
    this.p.anim.lookAround = true;
  }
  update(dt, ctx) {
    const p = this.p, f = this.f;
    if (!f || f.mode !== 'ground') return true;
    f.requests.courted = { from: p, until: ctx.time + 1.0 };
    const d = dist2D(p.pos, f.pos);
    const puff = { neckPuff: 1, crop: 0.8, tailSpread: 0.85, tailPitch: -0.3, fluff: 0.35 };
    if (d > 0.4) {
      // 追逐（“驱赶”）：鼓颈快步跟随雌鸽
      p.walkTo(f.pos, BIO.walkSpeed * 1.4, 0.3);
      this.pose('walk', puff);
      p.say(`鼓起颈羽，拖着展开的尾羽紧跟 ${f.name}`);
    } else {
      p.stop();
      this.bowT += dt;
      const cyc = (this.bowT % 1.7) / 1.7;
      // 鞠躬咕咕：头低下，同时发出“咕噜咕”声，再抬起
      const bow = Math.sin(cyc * Math.PI);
      if (this.spin > 0) {
        p.yaw += dt * 3.2 * this.spinDir;
        this.spin -= dt * 3.2;
      } else {
        p.turnTowards(f.pos, dt, 6);
        if (chance(dt * 0.25)) { this.spin = Math.PI * 2; this.spinDir = chance(0.5) ? 1 : -1; }
      }
      this.pose('stand', {
        ...puff, bodyPitch: -0.3 + bow * 0.25, head: V3(0, 0.185 - bow * 0.06, 0.08 + bow * 0.02), headPitch: 0.1 + bow * 0.9,
      });
      p.anim.lookAround = false;
      if (cyc < this._lastCyc) { p.flock.sound?.coo(p, 'bow'); p.stats.coos++; }
      this._lastCyc = cyc;
      p.say(this.spin > 0 ? '原地转圈炫耀' : `对着 ${f.name} 鞠躬咕咕`);
      p.flock.courtshipProgress(p, f, dt);
    }
    if (p.pair && p.pair.female === f && p.pair.justBonded) return true;
    return this.t > this.maxT;
  }
}

// ================================================================= 雌鸽对求偶的回应
export class BeCourted extends Behavior {
  static key = 'beCourted';
  static label = '回应求偶';
  static modes = ['ground'];
  static score(p, ctx) {
    const r = p.requests.courted;
    if (!r || r.until < ctx.time) return 0;
    return 0.9 + (p.mate === r.from ? 0.4 : 0) - (1 - p.nutrition) * 0.5;
  }
  start() { this.p.stop(); this.walkAwayT = rand(1, 4); }
  update(dt, ctx) {
    const p = this.p;
    const r = p.requests.courted;
    if (!r || r.until < ctx.time) return true;
    const m = r.from;
    const acc = p.flock.acceptance(m, p);
    this.walkAwayT -= dt;
    if (acc < 0.6 && this.walkAwayT < 0) {
      // 欲拒还迎：走开几步
      const away = p.pos.clone().sub(m.pos).setY(0).normalize().multiplyScalar(0.5).add(p.pos);
      p.walkTo(away, BIO.walkSpeed, 0.05);
      this.pose('walk');
      if (this.walkAwayT < -1.2) this.walkAwayT = rand(2, 5);
      p.say(`${m.name} 在追求我……先走开几步`);
    } else {
      p.stop();
      p.turnTowards(m.pos, dt, 4);
      this.pose('stand', { headPitch: 0.25, fluff: acc * 0.3 });
      p.say(acc > 0.6 ? `对 ${m.name} 有好感，站着看他表演` : `打量着 ${m.name}`);
    }
    return false;
  }
}

// ================================================================= 亲吻（喂吻 billing）
export class Billing extends Behavior {
  static key = 'billing';
  static label = '亲吻（喂吻）';
  static modes = ['ground', 'perch'];
  static score(p, ctx) {
    const r = p.requests.billing;
    return r && r.until > ctx.time ? 2.2 : 0;
  }
  start() {
    this.m = this.p.requests.billing.from;
    this.p.requests.billing = null;
    this.maxT = 6;
    this.p.say(`与伴侣 ${this.m.name} 亲吻：雌鸽把喙伸进雄鸽口中`);
    this.p.addLog(`与 ${this.m.name} 亲吻`);
  }
  stop() { this.p.anim.lookAround = true; }
  update(dt, ctx) {
    const p = this.p, m = this.m;
    if (!m || m.mode !== p.mode) return true;
    const d = dist2D(p.pos, m.pos);
    if (d > 0.17 && p.mode === 'ground') {
      const mid = p.pos.clone().lerp(m.pos, 0.5);
      p.walkTo(mid, BIO.walkSpeed, 0.07);
      this.pose('walk');
    } else {
      p.stop();
      p.turnTowards(m.pos, dt, 8);
      // 雌鸽头部更低、喙插入雄鸽喙中；双方有节奏地上下抽动
      const female = p.sex === 'female';
      const pump = Math.sin(this.t * 9) * 0.006;
      const reach = clamp(d * 0.5 - 0.03, 0, 0.06);
      this.pose('stand', {
        head: V3(0, (female ? 0.165 : 0.178) + pump * (female ? 1 : -1), 0.074 + reach), headPitch: female ? 0.55 : -0.1, headYaw: 0,
        neckPuff: female ? 0.2 : 0.7, fluff: 0.2, beak: female ? 0.1 : 0.45,
      });
      p.anim.lookAround = false;
      p.anim.headBob = false;
    }
    if (this.t > this.maxT) {
      p.anim.headBob = true;
      return true;
    }
    return false;
  }
}

// ================================================================= 筑巢
export class NestBuild extends Behavior {
  static key = 'nestBuild';
  static label = '衔枝筑巢';
  static score(p, ctx) {
    const pr = p.pair;
    if (!pr || pr.stage !== 'nesting' || !pr.site || p.sex !== 'male') return 0;
    if (pr.site.nest.material >= 1) return 0;
    return Math.max(0, 1.0 - (1 - p.nutrition) * 0.8) * daylightOf(ctx);
  }
  start() {
    this.state = 'findTwig';
    this.p.say('去花坛边找合适的细枝');
  }
  stop() {
    const p = this.p;
    if (this.twig && this.twig.claimedBy === p) this.twig.claimedBy = null;
    if (p.carrying) p.flock.dropTwig(p);
  }
  update(dt, ctx) {
    const p = this.p, W = p.world, site = p.pair?.site;
    if (!site) return true;
    if (this.state === 'findTwig') {
      if (p.carrying) { this.state = 'bring'; return false; }
      this.twig = W.nearestTwig(p.pos, p);
      if (!this.twig) return true;
      this.twig.claimedBy = p;
      const stand = this.twig.pos.clone().add(V3(rand(-0.05, 0.05), 0, -0.09).applyAxisAngle(V3(0, 1, 0), rand(0, 6)));
      this.nav = new Nav(p, { pos: stand, kind: 'ground' }, { flyIfFarther: 8, arrive: 0.06 });
      this.state = 'goTwig';
      this.pose('walk');
      return false;
    }
    if (this.state === 'goTwig') {
      const r = this.nav.update(dt);
      if (r === 'failed') return true;
      if (r === 'arrived') {
        p.turnTowards(this.twig.pos, dt, 8);
        if (!p.anim.pecking) { p.anim.peck(this.twig.pos, { eat: false, duration: 0.4 }); this.state = 'pick'; this.tt = 0; }
      }
      return false;
    }
    if (this.state === 'pick') {
      this.tt += dt;
      if (this.tt > 0.25 && !p.carrying) {
        W.takeTwig(this.twig);
        p.flock.carryTwig(p);
        p.say('衔起一根细枝，飞回巢里');
      }
      if (this.tt > 0.6) { this.state = 'bring'; }
      return false;
    }
    if (this.state === 'bring') {
      this.nav = this.nav && this.nav.target.perch === site.spots[1] ? this.nav : new Nav(p, { pos: site.spots[1].pos.clone(), perch: site.spots[1], kind: 'perch' });
      const r = this.nav.update(dt);
      if (r === 'arrived') {
        this.state = 'give';
        this.tt = 0;
        p.say(p.mate && p.mate.perch === site.spots[0] ? `把细枝交给坐在巢里的 ${p.mate.name}` : '把细枝放进巢里');
      } else if (r === 'failed') return true;
      return false;
    }
    if (this.state === 'give') {
      this.tt += dt;
      p.turnTowards(site.pos, dt, 6);
      this.pose('stand', { head: V3(-0.02, 0.15, 0.1), headPitch: 0.8 });
      if (this.tt > 1.2) {
        p.flock.dropTwig(p, site);
        site.nest.setMaterial(site.nest.material + 0.07);
        p.stats.twigs = (p.stats.twigs || 0) + 1;
        return true;
      }
    }
    return false;
  }
}

// ================================================================= 坐巢（雌鸽整理巢材 / 双亲孵卵、暖雏）
export class Incubate extends Behavior {
  static key = 'incubate';
  static label = '孵卵';
  static score(p, ctx) {
    const pr = p.pair;
    if (!pr || !pr.site) return 0;
    const site = pr.site;
    if (pr.stage === 'nesting') return p.sex === 'female' && pr.male?.brain.current?.name === 'nestBuild' ? 0.8 * daylightOf(ctx) : 0;
    const needs = pr.stage === 'incubating' || (pr.stage === 'brooding' && pr.youngestAge() < 7);
    if (!needs) return 0;
    const mine = pr.shiftOwner(ctx.day.hour) === p;
    const partnerOn = site.spots[0].occupant && site.spots[0].occupant !== p;
    if (mine) return (ctx.day.isNight ? 3.6 : 2.4) - (1 - p.nutrition) * 0.6;
    return partnerOn ? 0 : 1.4; // 伴侣不在时补位，蛋不能长时间失温
  }
  get interruptible() { return false; }
  start() {
    const site = this.p.pair.site;
    this.nav = new Nav(this.p, { pos: site.spots[0].pos.clone(), perch: site.spots[0], kind: 'perch' });
    this.state = 'go';
    this.p.say('去巢里换班');
  }
  stop() {}
  update(dt, ctx) {
    const p = this.p, pr = p.pair;
    if (!pr || !pr.site) return true;
    if (this.state === 'go') {
      const sp = pr.site.spots[0];
      if (sp.occupant && sp.occupant !== p && p.mode !== 'air') {
        // 伴侣还在巢里：先停在旁边，等对方离开（换班）
        if (pr.site.spots[1].occupant === p || p.perch === pr.site.spots[1]) {
          p.say('站在巢边等待换班');
          sp.occupant.requests.leaveNest = { from: p, until: ctx.time + 2 };
          return this.t > 25;
        }
        this.nav = new Nav(p, { pos: pr.site.spots[1].pos.clone(), perch: pr.site.spots[1], kind: 'perch' });
      }
      const r = this.nav.update(dt);
      if (r === 'arrived' && p.perch === pr.site.spots[0]) { this.state = 'sit'; this.tt = 0; p.addLog(pr.stage === 'nesting' ? '坐巢整理巢材' : '开始孵卵'); }
      else if (r === 'failed') return true;
      else if (r === 'arrived' && p.perch === pr.site.spots[1] && !sp.occupant) {
        this.nav = new Nav(p, { pos: sp.pos.clone(), perch: sp, kind: 'perch' });
        // 在窗台上走过去：直接换位
        p.leavePerch();
        p.placeOnPerchSoft(sp);
      }
      return false;
    }
    // 坐在巢上：身体压低，蓬松腹羽覆盖卵（孵卵斑直接贴着卵）
    this.tt += dt;
    const night = ctx.day.isNight;
    this.pose('incubate', night ? { lid: 1, fluff: 0.8, head: V3(0, 0.14, 0.04), headPitch: 0.5 } : { lid: Math.max(0, Math.sin(this.tt * 0.3)) * 0.5 });
    p.anim.lookAround = !night;
    p.anim.legMode = 'sit';
    if (pr.stage === 'nesting') {
      p.say('坐在巢中，把伴侣衔来的细枝塞到身体周围');
      if (chance(dt * 0.4)) p.anim.peck(p.pos.clone().add(V3(rand(-0.06, 0.06), 0.01, 0.06).applyAxisAngle(V3(0, 1, 0), p.yaw)), { eat: false });
    } else if (night) {
      p.say(pr.stage === 'incubating' ? '整夜伏在卵上，边睡边孵（夜班由雌鸽负责）' : '夜里伏在乳鸽身上为它们保暖');
    } else if (pr.stage === 'incubating') {
      p.say(`孵卵中（${pr.eggCount} 枚卵）——${p.sex === 'male' ? '雄鸽负责白天这一班' : '雌鸽负责傍晚到次日上午'}`);
      if (chance(dt * 0.05)) { p.anim.legMode = 'ground'; this.pose('stand', { headPitch: 0.9 }); p.say('起身用喙翻动卵，使其受热均匀'); }
    } else {
      p.say('伏在乳鸽身上为它们保暖');
    }
    const r = p.requests.leaveNest;
    const shiftOver = pr.stage !== 'nesting' && pr.shiftOwner(ctx.day.hour) !== p && r && r.until > ctx.time;
    const nestDone = pr.stage === 'nesting' && pr.male?.brain.current?.name !== 'nestBuild' && this.tt > 10;
    if (shiftOver || nestDone || (pr.stage === 'brooding' && pr.youngestAge() >= 7)) {
      p.anim.legMode = 'ground';
      p.requests.leaveNest = null;
      // 让出巢位，移到旁边
      p.leavePerch();
      p.placeOnPerchSoft(pr.site.spots[1].occupant ? p.world.freePerch(p.pos, ['ledge'], p) || pr.site.spots[1] : pr.site.spots[1]);
      p.addLog('换班离巢');
      return true;
    }
    if ((1 - p.nutrition) > 0.85 || (1 - p.hydration) > 0.9) { p.anim.legMode = 'ground'; return true; }
    return false;
  }
}

// ================================================================= 哺育（鸽乳）
export class FeedSquab extends Behavior {
  static key = 'feedSquab';
  static label = '哺育乳鸽';
  static score(p, ctx) {
    const pr = p.pair;
    if (!pr || pr.stage !== 'brooding' || !pr.squabs.length) return 0;
    const hungry = pr.squabs.some((s) => s.fed < 0.5);
    if (!hungry || p.cropG < 1.5) return 0;
    return 1.5 * daylightOf(ctx) + 0.3;
  }
  start() {
    const site = this.p.pair.site;
    const spot = site.spots[0].occupant && site.spots[0].occupant !== this.p ? site.spots[1] : site.spots[0];
    this.nav = new Nav(this.p, { pos: spot.pos.clone(), perch: spot, kind: 'perch' });
    this.state = 'go';
    this.p.say('嗉囊里有食物了，回巢喂乳鸽');
  }
  stop() { this.p.anim.headBob = true; this.p.anim.set({ crop: 0 }); }
  update(dt) {
    const p = this.p, pr = p.pair;
    if (!pr) return true;
    if (this.state === 'go') {
      const r = this.nav.update(dt);
      if (r === 'arrived') { this.state = 'feed'; this.tt = 0; this.idx = pr.squabs.findIndex((s) => s.fed < 0.5); }
      else if (r === 'failed') return true;
      return false;
    }
    this.tt += dt;
    const sq = pr.squabs[this.idx] || pr.squabs[0];
    if (!sq) return true;
    p.turnTowards(pr.site.pos, dt, 5);
    // 乳鸽把喙伸进亲鸟口角，亲鸟有节奏地收缩嗉囊，反哺“鸽乳”与软化的谷物
    const pump = Math.sin(this.tt * 6);
    this.pose('stand', { head: V3(0, 0.12 + pump * 0.008, 0.1), headPitch: 0.9, crop: 0.5 + 0.5 * Math.max(0, pump), neckPuff: 0.3, bodyPitch: -0.2 });
    p.anim.headBob = false;
    pr.site.nest.beg(this.idx < 0 ? 0 : this.idx, 1);
    const g = Math.min(p.cropG, dt * 0.4);
    p.cropG -= g;
    sq.fed = Math.min(1, sq.fed + g * 0.35);
    p.say(sq.age < 10 ? '反哺鸽乳（嗉囊上皮分泌的富含蛋白与脂肪的“乳”）' : '反哺软化后的谷粒');
    if (this.tt > 8 || sq.fed >= 1 || p.cropG <= 0.1) { p.addLog('喂了一次乳鸽'); return true; }
    return false;
  }
}

// ================================================================= 互相理羽
export class Allopreen extends Behavior {
  static key = 'allopreen';
  static label = '互相理羽';
  static modes = ['ground', 'perch'];
  static score(p, ctx) {
    if (!p.mate || p.brain.since('allopreen') < 60) return 0;
    const d = p.mate.pos.distanceTo(p.pos);
    if (d > 0.6 || p.mate.mode !== p.mode) return 0;
    return 0.35;
  }
  start() { this.maxT = rand(4, 8); this.p.say(`给伴侣 ${this.p.mate.name} 梳理头颈部的羽毛（自己够不到的地方）`); }
  update(dt) {
    const p = this.p, m = p.mate;
    if (!m) return true;
    p.stop();
    p.turnTowards(m.pos, dt, 6);
    const d = Math.min(0.12, dist2D(p.pos, m.pos) - 0.06);
    this.pose('stand', { head: V3(0, 0.19, 0.074 + Math.max(0, d)), headPitch: 0.6, headYaw: 0.3 * Math.sin(this.t * 2) });
    p.anim.nibble = 0.7;
    p.anim.lookAround = false;
    if (this.t > this.maxT) { p.anim.nibble = 0; p.anim.lookAround = true; return true; }
    return false;
  }
}

// ================================================================= 警觉
export class Alert extends Behavior {
  static key = 'alert';
  static label = '警觉';
  static score(p) {
    return p.fear > 0.22 && p.fear < 0.62 ? 1.4 + p.fear : 0;
  }
  start() { this.p.stop(); this.p.addLog('警觉'); }
  update(dt) {
    const p = this.p;
    const th = p.perceived.threat;
    // 伸长脖子、贴紧羽毛，用一侧眼睛盯着威胁
    this.pose('alert');
    p.anim.lookAround = false;
    if (th) {
      const a = Math.atan2(th.position.x - p.pos.x, th.position.z - p.pos.z) - p.yaw;
      p.anim.set({ headYaw: clamp(wrapAngle(a) - Math.sign(wrapAngle(a)) * 0.9, -1.4, 1.4), headRoll: th.kind === 'falcon' ? 0.6 : 0 });
      p.say(th.kind === 'falcon' ? '天上有猛禽的影子！侧头盯着' : `${th.label}在靠近，伸长脖子盯着`);
      // 慢慢走开，保持距离
      if (p.mode === 'ground' && th.kind !== 'falcon' && p.fear > 0.35) {
        const away = p.pos.clone().sub(th.position).setY(0).normalize().multiplyScalar(1.2).add(p.pos);
        p.world.clampToBounds(away, 0.5);
        p.walkTo(away, BIO.hurrySpeed, 0.1);
        this.pose('walk', { fluff: -0.35, head: V3(0, 0.19, 0.08) });
      }
    }
    if (p.fear < 0.15 || this.t > 10) { p.anim.lookAround = true; return true; }
    return false;
  }
}

// ================================================================= 惊飞
export class Flee extends Behavior {
  static key = 'flee';
  static label = '惊飞';
  static score(p) { return p.fear >= 0.62 ? 3 + p.fear : 0; }
  get interruptible() { return false; }
  start() {
    const p = this.p;
    const direct = p.perceived.threat;
    const th = direct || p.alarmThreat || null;
    const chain = direct ? 0 : (p.alarmChain || 1);
    p.lastAlarm = p.flock.time;
    let target;
    if (th?.kind === 'falcon' || chance(0.55) || p.mode === 'perch') {
      // 逃往高处：窗台 / 屋檐（祖先在悬崖上躲避天敌）
      const perch = p.world.freePerch(p.pos, ['ledge', 'roof'], p);
      target = perch && perch !== p.perch ? { pos: perch.pos.clone(), perch, kind: 'perch' } : null;
    }
    if (!target) {
      let away = th ? p.pos.clone().sub(th.position).setY(0).normalize().multiplyScalar(rand(8, 14)).add(p.pos) : p.world.randomGroundPoint();
      p.world.clampToBounds(away, 1);
      // 被墙角逼住时，换一个足够远的落点
      for (let k = 0; k < 10 && (dist2D(away, p.pos) < 5 || (th && dist2D(away, th.position) < 5)); k++) away = p.world.randomGroundPoint();
      target = { pos: away, kind: 'ground' };
    }
    // 鸽群中一只惊飞会引发连锁反应
    p.flock.alarm(p, th, chain);
    if (th?.kind === 'falcon') {
      // 遇到游隼：鸽群紧密地高速盘旋，然后落到屋檐上
      const roof = p.world.freePerch(p.pos, ['roof'], p);
      target = { kind: 'circle', center: V3(0, 0, -2), radius: rand(9, 12), alt: rand(10, 16), duration: rand(8, 12), dir: 1, pos: V3(), then: roof ? { pos: roof.pos.clone(), perch: roof, kind: 'perch' } : { pos: p.world.randomGroundPoint(), kind: 'ground' } };
    }
    this.nav = new Nav(p, target, { alarm: true, flyIfFarther: 0 });
    if (p.mode === 'air' && p.flight) { p.flight.target = target; p.flight.alarm = true; }
    p.say(th?.kind === 'falcon' ? '游隼！全群急速起飞、紧密成团盘旋' : direct ? `${th?.label ?? '危险'}太近了！拍着翅膀“啪啪”惊飞` : '同伴突然惊飞，跟着一起飞走');
    if (p.flight) p.flight.flockId = th?.kind === 'falcon' ? 'falcon' : null;
    p.alarmThreat = null;
  }
  update(dt) {
    const r = this.nav.update(dt);
    if (this.p.flight && this.p.perceived.threat?.kind === 'falcon') this.p.flight.flockId = 'falcon';
    if (r !== 'running') { this.p.fear = Math.min(this.p.fear, 0.3); return true; }
    return this.t > 60;
  }
}

// ================================================================= 群飞盘旋
export class GroupFlight extends Behavior {
  static key = 'groupFlight';
  static label = '群飞盘旋';
  static score(p, ctx) {
    const r = p.requests.groupFlight;
    return r && r.until > ctx.time && !p.pair?.isMyShift?.(ctx.day.hour) ? 2.0 : 0;
  }
  get interruptible() { return false; }
  start() {
    const p = this.p;
    const g = p.requests.groupFlight;
    p.requests.groupFlight = null;
    this.target = { ...g.target, pos: V3() };
    this.nav = new Nav(p, this.target, { flyIfFarther: 0, display: p.sex === 'male' });
    p.say('跟着鸽群起飞，绕着楼房一圈圈地盘旋');
    p.addLog('群飞盘旋');
  }
  update(dt) {
    const r = this.nav.update(dt);
    if (this.p.flight) this.p.flight.flockId = 'rounds';
    return r !== 'running' || this.t > 90;
  }
}

// ================================================================= 离开栖处
export class LeavePerch extends Behavior {
  static key = 'leavePerch';
  static label = '飞下栖处';
  static modes = ['perch'];
  static score(p, ctx) {
    if (ctx.day.isNight || ctx.day.hour > 17.3 || ctx.day.hour < 5.8) return 0;
    if (p.pair?.site?.spots.includes(p.perch) && Incubate.score(p, ctx) > 1) return 0;
    const hunger = 1 - p.nutrition, thirst = 1 - p.hydration;
    const groundFlock = p.flock.pigeons.filter((o) => o.mode === 'ground').length;
    return (hunger * 1.3 + thirst * 0.9 + groundFlock * 0.06 + (p.flock.feeder?.active ? 0.5 : 0) + p.lonely * 0.4) * daylightOf(ctx) - p.fear;
  }
  start() {
    const p = this.p;
    let spot = p.flock.attractiveFeedingSpot(p);
    if (!spot) spot = p.world.randomGroundPoint();
    spot = spot.clone().add(V3(rand(-0.8, 0.8), 0, rand(-0.8, 0.8)));
    p.world.clampToBounds(spot, 0.6);
    if (p.world.blocked(spot.x, spot.z, 0.2)) spot = p.world.randomGroundPoint();
    this.nav = new Nav(p, { pos: spot, kind: 'ground' }, { flyIfFarther: 0 });
    p.say(p.flock.feeder?.active ? '老人来撒食了！飞下去' : '从高处飞下来，去广场上找吃的');
  }
  update(dt) {
    const r = this.nav.update(dt);
    return r !== 'running' || this.t > 40;
  }
}

// ================================================================= 归巢（黄昏回到过夜的栖处）
export class Roost extends Behavior {
  static key = 'roost';
  static label = '归巢';
  static modes = ['ground', 'perch'];
  static score(p, ctx) {
    const d = ctx.day;
    if (p.mode === 'perch' && (p.perch === p.homePerch || p.perch?.kind === 'nest')) return 0;
    if (d.isNight) return 2.6;
    if (d.hour > 17.3) return 1.3 + (d.hour - 17.3) * 0.9;
    return p.energy < 0.12 ? 0.9 : 0;
  }
  get interruptible() { return false; }
  start() {
    const p = this.p;
    let perch = p.homePerch && (!p.homePerch.occupant || p.homePerch.occupant === p) ? p.homePerch : null;
    if (p.pair?.site && p.pair.stage !== 'courting') {
      const sp = p.pair.site.spots;
      perch = !sp[0].occupant || sp[0].occupant === p ? (p.pair.stage === 'nesting' ? sp[1] : perch || sp[1]) : sp[1].occupant ? perch : sp[1];
    }
    if (!perch) perch = p.world.freePerch(p.pos, ['ledge'], p);
    if (!p.homePerch && perch && perch.kind === 'ledge') p.homePerch = perch;
    this.perch = perch;
    this.nav = new Nav(p, { pos: perch.pos.clone(), perch, kind: 'perch' });
    p.say('天快黑了，飞回窗台上习惯的位置过夜');
    p.addLog('归巢');
  }
  update(dt) {
    const r = this.nav.update(dt);
    if (r === 'failed') { this.p.homePerch = null; return true; }
    return r !== 'running';
  }
}

// ================================================================= 睡眠
export class Sleep extends Behavior {
  static key = 'sleep';
  static label = '睡眠';
  static modes = ['perch', 'ground'];
  static score(p, ctx) {
    const d = ctx.day;
    if (d.isNight || d.hour > 19) return p.mode === 'perch' ? 3.2 : 0.2;
    return p.mode === 'perch' && p.energy < 0.18 ? 0.9 : 0;
  }
  get interruptible() { return true; }
  start() {
    this.oneLeg = chance(0.4);
    this.p.stop();
    this.p.addLog('入睡');
  }
  stop() { this.p.anim.legMode = 'ground'; }
  update(dt, ctx) {
    const p = this.p;
    // 睡觉时把头缩进肩羽、蓬起全身羽毛保温，常单脚站立
    this.pose(this.oneLeg ? 'oneLeg' : 'sleep', { lid: 1, fluff: 1, head: V3(0, 0.138, 0.032), headPitch: 0.6 });
    p.anim.legMode = this.oneLeg ? 'oneLeg' : 'sit';
    p.anim.lookAround = false;
    p.say(this.oneLeg ? '单脚站着睡觉，头缩进蓬松的颈羽里' : '伏在窗台上睡觉，羽毛蓬成一个球');
    if (!ctx.day.isNight && ctx.day.hour > 5 && ctx.day.hour < 12 && p.energy > 0.6) { p.anim.lookAround = true; p.anim.legMode = 'ground'; p.anim.shake(); return true; }
    return false;
  }
}
// 被驱赶时的短暂躲闪
export class Dodge extends Behavior {
  static key = 'dodge';
  static label = '躲闪';
  static modes = ['ground'];
  static score(p, ctx) { return p.brain.nudge && p.brain.nudge.until > ctx.time ? 2 : 0; }
  start() {
    const p = this.p, from = p.brain.nudge.from;
    p.brain.nudge = null;
    const away = p.pos.clone().sub(from.pos).setY(0).normalize().multiplyScalar(0.35).add(p.pos);
    this.target = away;
    p.say(`被 ${from.name} 啄了一下，赶紧让开`);
  }
  update(dt) {
    this.p.walkTo(this.target, BIO.hurrySpeed, 0.05);
    this.pose('walk', { fluff: -0.2 });
    return this.t > 1.2;
  }
}

export const BEHAVIORS = [
  Idle, Wander, Forage, Drink, Preen, Bathe, Sunbathe, Rest, Stretch, Coo, Court, BeCourted, Billing,
  NestBuild, Incubate, FeedSquab, Allopreen, Alert, Flee, GroupFlight, LeavePerch, Roost, Sleep, Dodge,
];
