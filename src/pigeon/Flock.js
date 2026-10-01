import * as THREE from 'three';
import { Pigeon } from './Pigeon.js';
import { BIO, FLOCK_SETUP } from '../config.js';
import { rand, pick, chance, clamp, dist2D } from '../utils/math.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// =====================================================================================
//  配对与繁殖：鸽子实行终生一夫一妻制。
//  求偶 → 结对 → 选巢址 → 筑巢 → 产卵（2 枚，间隔约 44 小时）→ 双亲轮流孵卵 17–19 天
//  → 乳鸽出壳、以鸽乳哺育 → 约 4 周后出飞；亲鸟常在乳鸽未离巢时就开始下一窝。
// =====================================================================================
export class Pair {
  constructor(flock, male, female) {
    this.flock = flock;
    this.male = male;
    this.female = female;
    male.mate = female;
    female.mate = male;
    male.pair = female.pair = this;
    this.stage = 'bonded';
    this.site = null;
    this.eggs = [];            // 产卵时刻（游戏小时，绝对值）
    this.squabs = [];          // { age(天), fed(0–1) }
    this.hatchAt = null;
    this.bondAt = flock.absHours;
    this.justBonded = true;
    this.lastBilling = flock.time;
    this.broods = 0;
  }

  get eggCount() {
    return this.eggs.length;
  }

  // 孵卵分工：雄鸽约 10:00–16:30，雌鸽负责其余时间（包括整夜）
  shiftOwner(hour) {
    return hour >= BIO.maleShift[0] && hour < BIO.maleShift[1] ? this.male : this.female;
  }

  isMyShift(hour) {
    return false;
  }

  youngestAge() {
    return this.squabs.length ? Math.min(...this.squabs.map((s) => s.age)) : 99;
  }

  get stageLabel() {
    return {
      courting: '求偶中', bonded: '已结对', nesting: '筑巢中', incubating: '孵卵中', brooding: '育雏中',
    }[this.stage] || this.stage;
  }

  // dh：经过的游戏小时
  advance(dh) {
    const F = this.flock;
    const now = F.absHours;
    if (this.stage === 'bonded') {
      const site = F.world.nestSites.find((s) => !s.owner);
      if (site) {
        site.owner = this;
        this.site = site;
        this.stage = 'nesting';
        F.event(`${this.male.name} 与 ${this.female.name} 选定了窗台壁龛作为巢址`);
      }
    }
    if (this.stage === 'nesting' && this.site) {
      // 巢材足够且结对超过约 1 天 → 产下第一枚卵
      if (this.site.nest.material >= 0.7 && now - this.bondAt > 20 && this.eggs.length === 0 && (this.squabs.length === 0 || this.youngestAge() > 14)) {
        this.eggs.push(now);
        this.stage = this.squabs.length ? 'brooding' : 'incubating';
        this.site.nest.setEggs(1);
        F.event(`${this.female.name} 产下了第一枚卵`);
      }
    }
    if (this.eggs.length === 1 && now - this.eggs[0] >= BIO.layingIntervalH) {
      this.eggs.push(now);
      this.site.nest.setEggs(2);
      this.hatchAt = now + 17.5 * 24;
      F.event(`${this.female.name} 产下了第二枚卵，正式开始轮流孵卵（约 17–19 天）`);
    }
    if (this.hatchAt && now >= this.hatchAt && this.eggs.length) {
      const n = this.eggs.length;
      this.eggs = [];
      this.hatchAt = null;
      this.site.nest.setEggs(0);
      for (let i = 0; i < n; i++) this.squabs.push({ age: 0, fed: 0.6, born: now });
      this.stage = 'brooding';
      F.event(`${this.male.name} 和 ${this.female.name} 的乳鸽破壳了！双亲开始分泌鸽乳`);
    }
    if (this.squabs.length) {
      for (const s of this.squabs) {
        s.age += dh / 24;
        // 夜间不喂食，消耗较慢
        s.fed = clamp(s.fed - dh * (F.day.isNight ? 0.02 : 0.07), 0, 1);
      }
      // 出飞：约 4 周大的乳鸽离巢，加入鸽群
      const fledged = this.squabs.filter((s) => s.age >= 28);
      for (const s of fledged) {
        F.fledge(this, s);
      }
      this.squabs = this.squabs.filter((s) => s.age < 28);
      if (!this.squabs.length && !this.eggs.length && this.stage === 'brooding') {
        this.stage = 'nesting';
        this.bondAt = now - 21;
      }
    }
    if (this.site) this.site.nest.setSquabs([this.squabs[0]?.age ?? null, this.squabs[1]?.age ?? null]);
    // 结对的鸽子常常亲吻
    if (F.time - this.lastBilling > rand(90, 160) && F.day.daylight > 0.5) {
      const m = this.male, f = this.female;
      if (m.mode === f.mode && m.pos.distanceTo(f.pos) < 2 && m.mode !== 'air' && !['incubate', 'flee', 'roost', 'sleep'].includes(m.brain.current?.name) && !['incubate', 'flee', 'roost', 'sleep'].includes(f.brain.current?.name)) {
        this.lastBilling = F.time;
        m.requests.billing = { from: f, until: F.time + 2 };
        f.requests.billing = { from: m, until: F.time + 2 };
      }
    }
    this.justBonded = false;
  }
}

export class Flock {
  constructor(world, day) {
    this.world = world;
    this.day = day;
    this.pigeons = [];
    this.pairs = [];
    this.time = 0;          // 真实秒
    this.events = [];
    this.acc = new Map();   // 求偶接受度
    this.sound = null;
    this.feeder = null;
    this.groupFlightT = 40;
    this.flockSeq = 0;
    this._twigGeo = new THREE.CylinderGeometry(0.0022, 0.0018, 0.11, 4).rotateZ(Math.PI / 2);
    this._twigMat = new THREE.MeshStandardMaterial({ color: '#8a6a45', roughness: 1 });
    this.nameIdx = 0;
  }

  get absHours() {
    return this.day.day * 24 + this.day.hour;
  }

  event(text) {
    this.events.unshift({ time: `第${this.day.day}天 ${this.day.clockString}`, text });
    if (this.events.length > 60) this.events.length = 60;
    this.onEvent?.(text);
  }

  spawnInitial() {
    const W = this.world;
    for (const cfg of FLOCK_SETUP) {
      const p = new Pigeon(this, cfg);
      this.pigeons.push(p);
    }
    const byName = (n) => this.pigeons.find((p) => p.name === n);
    // 初始状态：两对已结对的伴侣
    const a = new Pair(this, byName('灰灰'), byName('小雪'));
    a.site = W.nestSites[1]; a.site.owner = a; a.stage = 'nesting'; a.site.nest.setMaterial(0.42); a.bondAt = this.absHours - 30;
    const b = new Pair(this, byName('斑斑'), byName('阿红'));
    b.site = W.nestSites[2]; b.site.owner = b; b.stage = 'incubating'; b.site.nest.setMaterial(1);
    b.eggs = [this.absHours - 17 * 24, this.absHours - 17 * 24 + 44]; b.site.nest.setEggs(2);
    b.hatchAt = this.absHours + 14; // 明天凌晨前后破壳
    this.pairs.push(a, b);
    for (const pr of this.pairs) pr.justBonded = false;
    // 摆放：白天在地面，靠近广场中央
    for (const p of this.pigeons) {
      const pos = W.randomGroundPoint(V3(1, 0, 3), 4);
      p.placeOnGround(pos.x, pos.z);
      p.homePerch = W.freePerch(V3(rand(-12, 12), 9, -12.8), ['ledge'], p);
      if (p.homePerch) p.homePerch.homeOf = p;
    }
    // 正在孵卵的那一对：根据时间让轮值者在巢里
    const sitter = b.shiftOwner(this.day.hour);
    sitter.placeOnPerch(b.site.spots[0]);
  }

  // ------------------------------------------------------------------ 每帧
  update(dt, ctx) {
    this.time += dt;
    ctx.time = this.time;
    for (const p of this.pigeons) p.update(dt, ctx);
    for (const pr of this.pairs) pr.advance(ctx.dh);
    // 自发的群飞（鸽子每天会绕巢区盘旋数次，早晨尤其频繁）
    this.groupFlightT -= dt * (ctx.day.timeScale > 1 ? ctx.day.timeScale * 0.5 : 1);
    if (this.groupFlightT <= 0) {
      this.groupFlightT = rand(80, 160) / (ctx.day.hour < 10 ? 1.6 : 1);
      if (ctx.day.daylight > 0.6 && !ctx.day.isDusk) this.startGroupFlight();
    }
  }

  // ------------------------------------------------------------------ 社会行为
  // 惊飞的连锁反应：起飞时的拍翅声是同伴的警报信号。
  // 传播有层数限制，每只鸽子在一次受惊后有一段“不应期”，避免互相反复惊扰。
  alarm(source, threat, chain = 0) {
    if (chain >= 2) return;
    for (const p of this.pigeons) {
      if (p === source) continue;
      if (this.time - (p.lastAlarm ?? -99) < 12) continue;
      const d = p.pos.distanceTo(source.pos);
      const range = threat?.kind === 'falcon' ? 60 : 7;
      if (d < range) {
        const v = (threat?.kind === 'falcon' ? 0.95 : 0.78 - d * 0.035) * (chain ? 0.85 : 1);
        if (v > (p.pendingFear?.value ?? 0)) p.pendingFear = { value: v, at: this.time + rand(0.05, 0.45), chain: chain + 1, threat };
      }
    }
  }

  startGroupFlight(leader = null) {
    const W = this.world;
    const candidates = this.pigeons.filter((p) => p.mode !== 'air' && !['incubate', 'feedSquab', 'flee', 'sleep', 'roost', 'billing'].includes(p.brain.current?.name) && p.nutrition > 0.25);
    if (candidates.length < 3) return false;
    leader = leader || pick(candidates);
    const center = V3(rand(-3, 3), 0, rand(-4, 2));
    const radius = rand(9, 13), alt = rand(8, 13), duration = rand(14, 24), dir = chance(0.5) ? 1 : -1;
    const landOnRoof = chance(0.35);
    const landCenter = W.randomGroundPoint(V3(rand(-4, 6), 0, rand(0, 6)), 2);
    let n = 0;
    for (const p of candidates) {
      if (p !== leader && p.pos.distanceTo(leader.pos) > 12 && !chance(0.4)) continue;
      let then;
      if (landOnRoof) {
        const perch = W.freePerch(V3(center.x + rand(-4, 4), 15, -13), ['roof'], p);
        then = { pos: perch.pos.clone(), perch, kind: 'perch' };
      } else {
        const g = landCenter.clone().add(V3(rand(-1.4, 1.4), 0, rand(-1.4, 1.4)));
        W.clampToBounds(g, 0.5);
        then = { pos: g, kind: 'ground' };
      }
      p.requests.groupFlight = {
        until: this.time + rand(0.2, 1.5),
        target: { kind: 'circle', center, radius: radius + rand(-1, 1), alt: alt + rand(-1, 1), duration, dir, then },
      };
      n++;
    }
    this.event(`鸽群起飞，绕着楼房盘旋（${n} 只）`);
    return true;
  }

  // 求偶进展：雄鸽持续炫耀会逐渐提高雌鸽的接受度
  courtshipProgress(m, f, dt) {
    if (m.mate === f) {
      if (chance(dt * 0.15) && !f.requests.billing) {
        m.requests.billing = { from: f, until: this.time + 2 };
        f.requests.billing = { from: m, until: this.time + 2 };
        if (m.pair) m.pair.lastBilling = this.time;
      }
      return;
    }
    if (f.mate || m.mate) return;
    const key = `${m.id}-${f.id}`;
    const v = (this.acc.get(key) || 0) + dt * 0.035 * (0.4 + f.breedDrive) * (0.6 + m.size * 0.4);
    this.acc.set(key, v);
    if (v >= 1) {
      const pr = new Pair(this, m, f);
      this.pairs.push(pr);
      this.event(`💞 ${m.name} 与 ${f.name} 结为伴侣（鸽子通常终生一夫一妻）`);
      m.addLog(`与 ${f.name} 结为伴侣`);
      f.addLog(`与 ${m.name} 结为伴侣`);
      m.requests.billing = { from: f, until: this.time + 2 };
      f.requests.billing = { from: m, until: this.time + 2 };
    }
  }

  acceptance(m, f) {
    if (m.mate === f) return 1;
    return this.acc.get(`${m.id}-${f.id}`) || 0;
  }

  // 鸽子会被正在觅食的同伴和撒食的人吸引（社会性觅食 / 局部增强）
  attractiveFeedingSpot(p) {
    if (this.feeder?.active && this.feeder.lastThrow && performance.now() - this.feeder.lastThrow.time < 90000) {
      return this.feeder.lastThrow.pos;
    }
    const dense = this.world.food.densestSpot(30);
    if (dense && dense.n >= 4) return dense.pos;
    const feeders = this.pigeons.filter((o) => o !== p && o.mode === 'ground' && o.brain.current?.name === 'forage');
    if (feeders.length >= 2) {
      const c = V3();
      for (const o of feeders) c.add(o.pos);
      return c.divideScalar(feeders.length);
    }
    return null;
  }

  carryTwig(p) {
    if (p.carrying) return;
    const m = new THREE.Mesh(this._twigGeo, this._twigMat);
    m.position.set(0, -0.0015, 0.012);
    m.rotation.y = 0.15;
    m.castShadow = true;
    p.model.beak.add(m);
    p.carrying = m;
  }

  dropTwig(p) {
    if (!p.carrying) return;
    p.carrying.parent?.remove(p.carrying);
    p.carrying = null;
  }

  // 乳鸽出飞，成为鸽群的新成员
  fledge(pair, squab) {
    if (this.pigeons.length >= 16) {
      this.event(`${pair.male.name} 家的一只幼鸽出飞后加入了别处的鸽群`);
      return;
    }
    const names = ['小灰', '豆豆', '团团', '阿斑', '米粒', '芝麻', '咕咕', '小白', '灰豆'];
    const name = names[this.nameIdx++ % names.length] + (this.nameIdx > names.length ? this.nameIdx : '');
    const morph = chance(0.5) ? pair.male.morph : pair.female.morph;
    const p = new Pigeon(this, { name, sex: chance(0.5) ? 'male' : 'female', morph, juvenile: true, ageDays: 28 });
    this.pigeons.push(p);
    const spot = pair.site.spots[1].occupant ? this.world.freePerch(pair.site.pos, ['ledge'], p) : pair.site.spots[1];
    p.placeOnPerch(spot);
    p.homePerch = this.world.freePerch(pair.site.pos, ['ledge'], p);
    p.nutrition = 0.7;
    this.event(`🐣 ${name}（${pair.male.name} 与 ${pair.female.name} 的孩子）离巢出飞，加入鸽群`);
    this.onNewPigeon?.(p);
  }

  // 时间跳跃：快速推进繁殖进程，并按时间重新摆放鸽子
  onTimeJump(hours) {
    const W = this.world;
    const steps = Math.ceil(hours / 2);
    for (let i = 0; i < steps; i++) {
      for (const pr of this.pairs) {
        pr.advance(hours / steps);
        if (pr.stage === 'nesting' && pr.site) pr.site.nest.setMaterial(pr.site.nest.material + 0.25 * (hours / steps) / 12);
        for (const s of pr.squabs) s.fed = Math.max(s.fed, 0.6);
      }
    }
    const night = this.day.isNight;
    for (const p of this.pigeons) {
      p.brain.forceEnd();
      if (p.flight) p.flight = null;
      p.anim.stopFlap();
      p.nutrition = night ? rand(0.55, 0.75) : rand(0.35, 0.6);
      p.hydration = rand(0.5, 0.8);
      p.energy = night ? rand(0.25, 0.4) : rand(0.6, 0.9);
      p.fear = 0;
      p.leavePerch();
      const pr = p.pair;
      if (pr && pr.site && (pr.stage === 'incubating' || pr.stage === 'brooding') && pr.shiftOwner(this.day.hour) === p) {
        p.placeOnPerch(pr.site.spots[0]);
      } else if (night) {
        let perch = p.homePerch && !p.homePerch.occupant ? p.homePerch : W.freePerch(V3(rand(-12, 12), 9, -13), ['ledge'], p);
        p.placeOnPerch(perch);
      } else {
        const pos = W.randomGroundPoint(V3(1, 0, 3), 5);
        p.placeOnGround(pos.x, pos.z);
      }
    }
  }
}
