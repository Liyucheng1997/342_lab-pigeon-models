import * as THREE from 'three';
import { rand, clamp, lerp, damp, dampAngle, pick, chance } from '../utils/math.js';

// =====================================================================================
//  广场上的其他角色：喂鸽子的老人、路人、追鸽子的小孩、游隼（鸽子的主要天敌）
//  这些角色对鸽子而言是“刺激”：食物来源或威胁。
// =====================================================================================

function makeHuman({ coat = '#5b6b7a', pants = '#3a3f47', skin = '#e2b999', hat = null, scale = 1 } = {}) {
  const g = new THREE.Group();
  const M = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
  const coatM = M(coat), pantsM = M(pants), skinM = M(skin), shoeM = M('#2a2522');
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 4, 10), coatM);
  torso.position.y = 1.18;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), skinM);
  head.position.y = 1.62;
  g.add(torso, head);
  if (hat) {
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 12), M(hat));
    h.position.y = 1.71;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.015, 16), M(hat));
    brim.position.y = 1.67;
    g.add(h, brim);
  }
  const limb = (r, len, mat) => {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat);
    m.position.y = -len / 2 - r;
    m.castShadow = true;
    pivot.add(m);
    return pivot;
  };
  const legL = limb(0.07, 0.72, pantsM), legR = limb(0.07, 0.72, pantsM);
  legL.position.set(0.09, 0.92, 0); legR.position.set(-0.09, 0.92, 0);
  const armL = limb(0.05, 0.5, coatM), armR = limb(0.05, 0.5, coatM);
  armL.position.set(0.22, 1.42, 0); armR.position.set(-0.22, 1.42, 0);
  for (const leg of [legL, legR]) {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.22), shoeM);
    shoe.position.set(0, -0.93, 0.05);
    shoe.castShadow = true;
    leg.add(shoe);
  }
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), skinM);
  hand.position.y = -0.62;
  armR.add(hand);
  g.add(legL, legR, armL, armR);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.scale.setScalar(scale);
  return { group: g, legL, legR, armL, armR, torso, head, hand };
}

// ---------------------------------------------------------------- 喂鸽子的老人
export class Feeder {
  constructor(world, bench) {
    this.world = world;
    this.bench = bench;
    this.h = makeHuman({ coat: '#6b5a48', pants: '#3b3a3a', hat: '#4a4a52' });
    this.scene = world.scene;
    this.scene.add(this.h.group);
    this.state = 'away';     // away | arriving | sitting | leaving
    this.pos = new THREE.Vector3(bench.x - 14, 0, bench.z + 3);
    this.yaw = 0;
    this.throwT = 0;
    this.sessionT = 0;
    this.throwAnim = 0;
    this.walkPhase = 0;
    this.h.group.visible = false;
    this.label = '喂鸽子的老人';
    this.kind = 'feeder';
    this.radius = 0.6;  // 对鸽子的威慑半径（老人很熟悉，鸽子几乎不怕）
  }

  // 老人在 7:30–10:00 与 15:00–17:00 来广场喂鸽子
  wantsToBeHere(hour) {
    return (hour > 7.5 && hour < 10) || (hour > 15 && hour < 17);
  }

  callNow() {
    this.forced = 60;
  }

  update(dt, day) {
    const h = this.h;
    const seat = new THREE.Vector3(this.bench.x + Math.sin(this.bench.yaw) * 0.04, 0, this.bench.z + Math.cos(this.bench.yaw) * 0.04);
    const want = this.wantsToBeHere(day.hour) || (this.forced > 0);
    if (this.forced > 0) this.forced -= dt;
    if (this.state === 'away' && want) {
      this.state = 'arriving';
      this.pos.set(this.bench.x - 15, 0, this.bench.z + 4);
      h.group.visible = true;
    }
    if (this.state === 'sitting' && !want) this.state = 'leaving';
    let moving = false;
    if (this.state === 'arriving' || this.state === 'leaving') {
      const target = this.state === 'arriving' ? seat : new THREE.Vector3(this.bench.x - 16, 0, this.bench.z + 4);
      const d = target.clone().sub(this.pos);
      d.y = 0;
      const dist = d.length();
      if (dist < 0.05) {
        if (this.state === 'arriving') { this.state = 'sitting'; this.sessionT = 0; }
        else { this.state = 'away'; h.group.visible = false; }
      } else {
        const step = Math.min(dist, 0.9 * dt);
        this.pos.addScaledVector(d.normalize(), step);
        this.yaw = dampAngle(this.yaw, Math.atan2(d.x, d.z), 6, dt);
        moving = true;
      }
    }
    // 动画
    if (moving) {
      this.walkPhase += dt * 6;
      const s = Math.sin(this.walkPhase);
      h.legL.rotation.x = s * 0.5; h.legR.rotation.x = -s * 0.5;
      h.armL.rotation.x = -s * 0.4; h.armR.rotation.x = s * 0.4;
      h.group.position.copy(this.pos);
      h.group.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.03;
      h.torso.position.y = 1.18;
    } else if (this.state === 'sitting') {
      this.yaw = dampAngle(this.yaw, this.bench.yaw, 4, dt);
      h.group.position.set(seat.x, -0.42, seat.z);
      h.legL.rotation.x = -1.45; h.legR.rotation.x = -1.45;
      // 撒食：右臂向前挥出
      this.throwT -= dt;
      if (this.throwT <= 0) {
        this.throwT = rand(7, 16);
        this.throwAnim = 1;
        this._thrown = false;
      }
      if (this.throwAnim > 0) {
        this.throwAnim = Math.max(0, this.throwAnim - dt * 1.4);
        const k = 1 - this.throwAnim;
        h.armR.rotation.x = -Math.sin(k * Math.PI) * 1.6;
        if (!this._thrown && k > 0.55) {
          this._thrown = true;
          const hand = new THREE.Vector3();
          h.hand.getWorldPosition(hand);
          const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
          const center = seat.clone().addScaledVector(fwd, rand(1.4, 2.6)).add(new THREE.Vector3(rand(-0.8, 0.8), 0, 0));
          this.world.food.scatter(hand, center, Math.floor(rand(40, 80)), rand(0.6, 1.1), pick(['seed', 'seed', 'corn', 'crumb', 'pea']));
          this.lastThrow = { pos: center, time: performance.now() };
        }
      } else {
        h.armR.rotation.x = damp(h.armR.rotation.x, -0.5, 4, dt);
      }
      h.armL.rotation.x = -0.6;
    }
    h.group.rotation.y = this.yaw;
  }

  get position() {
    return this.h.group.position;
  }

  get active() {
    return this.state !== 'away';
  }
}

// ---------------------------------------------------------------- 路人 / 小孩
export class Pedestrian {
  constructor(world, child = false) {
    this.world = world;
    this.child = child;
    const coats = ['#a33b3b', '#2f5d8a', '#c79a3b', '#3c7a52', '#6a4c8a', '#d06a8a'];
    this.h = makeHuman({ coat: pick(coats), pants: pick(['#2a2f3a', '#4a4036', '#2e3d55']), skin: pick(['#e2b999', '#c99a76', '#f0cfb4']), scale: child ? 0.62 : rand(0.95, 1.08) });
    world.scene.add(this.h.group);
    this.h.group.visible = false;
    this.active = false;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.yaw = 0;
    this.phase = 0;
    this.speed = 1.2;
    this.kind = child ? 'child' : 'pedestrian';
    this.label = child ? '追鸽子的小孩' : '路人';
    this.radius = child ? 4.5 : 2.6;
    this.chaseT = 0;
  }

  spawn(flock) {
    const b = this.world.bounds;
    const side = Math.floor(rand(0, 3));
    const edge = () => {
      if (side === 0) return new THREE.Vector3(b.minX - 3, 0, rand(b.minZ + 3, b.maxZ));
      if (side === 1) return new THREE.Vector3(b.maxX + 3, 0, rand(b.minZ + 3, b.maxZ));
      return new THREE.Vector3(rand(b.minX, b.maxX), 0, b.maxZ + 4);
    };
    this.pos.copy(edge());
    this.target.set(-this.pos.x + rand(-4, 4), 0, side === 2 ? b.minZ + rand(1, 3) : rand(b.minZ + 2, b.maxZ));
    if (side === 2) this.target.x = rand(b.minX, b.maxX);
    this.speed = this.child ? 2.6 : rand(1.0, 1.4);
    this.active = true;
    this.h.group.visible = true;
    this.flock = flock;
    this.chaseT = this.child ? rand(8, 14) : 0;
  }

  update(dt) {
    if (!this.active) return;
    // 小孩会冲向鸽群
    if (this.child && this.chaseT > 0 && this.flock) {
      this.chaseT -= dt;
      const grounded = this.flock.pigeons.filter((p) => p.mode === 'ground');
      if (grounded.length) {
        let best = null, bd = Infinity;
        for (const p of grounded) { const d = p.pos.distanceTo(this.pos); if (d < bd) { bd = d; best = p; } }
        this.target.set(best.pos.x, 0, best.pos.z);
      }
      if (this.chaseT <= 0) {
        const b = this.world.bounds;
        this.target.set(rand(b.minX, b.maxX), 0, b.maxZ + 5);
      }
    }
    const d = this.target.clone().sub(this.pos);
    d.y = 0;
    const dist = d.length();
    if (dist < 0.3) {
      if (this.child && this.chaseT > 0) return;
      this.active = false;
      this.h.group.visible = false;
      return;
    }
    d.normalize();
    // 绕开障碍物
    for (const o of this.world.obstacles) {
      const ox = this.pos.x - o.x, oz = this.pos.z - o.z;
      const od = Math.hypot(ox, oz);
      if (od < o.r + 0.8) { d.x += (ox / od) * 0.8; d.z += (oz / od) * 0.8; }
    }
    d.normalize();
    this.pos.addScaledVector(d, this.speed * dt);
    this.yaw = dampAngle(this.yaw, Math.atan2(d.x, d.z), 8, dt);
    this.phase += dt * this.speed * 5;
    const s = Math.sin(this.phase);
    const h = this.h;
    const amp = this.child ? 0.9 : 0.55;
    h.legL.rotation.x = s * amp; h.legR.rotation.x = -s * amp;
    h.armL.rotation.x = -s * amp * 0.8; h.armR.rotation.x = s * amp * 0.8;
    if (this.child && this.chaseT > 0) { h.armL.rotation.z = 0.8; h.armR.rotation.z = -0.8; }
    else { h.armL.rotation.z = 0; h.armR.rotation.z = 0; }
    h.group.position.copy(this.pos);
    h.group.position.y = Math.abs(Math.cos(this.phase)) * 0.04;
    h.group.rotation.y = this.yaw;
    this.vel = d.multiplyScalar(this.speed);
  }

  get position() {
    return this.pos;
  }
}

// ---------------------------------------------------------------- 游隼
// 游隼是城市鸽群最主要的天敌，俯冲速度可超过 300 km/h。
export class Falcon {
  constructor(world) {
    this.world = world;
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: '#3b4049', roughness: 0.8 });
    const light = new THREE.MeshStandardMaterial({ color: '#d9d2c2', roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10).scale(0.06, 0.06, 0.2), dark);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10).scale(0.055, 0.05, 0.16), light);
    belly.position.set(0, -0.015, 0.02);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), dark);
    head.position.set(0, 0.02, 0.19);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.04, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#e8c33a' }));
    beak.position.set(0, 0.01, 0.24);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.01, 0.18), dark);
    tail.position.set(0, 0, -0.26);
    g.add(body, belly, head, beak, tail);
    const wingGeo = new THREE.BufferGeometry();
    // 尖长的镰刀形翅膀
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.08, 0.5, 0, -0.12, 0.05, 0, -0.1, 0.5, 0, -0.12, 0.25, 0, -0.02, 0, 0, 0.08], 3));
    wingGeo.computeVertexNormals();
    const wm = new THREE.MeshStandardMaterial({ color: '#4a505b', side: THREE.DoubleSide, roughness: 0.8 });
    this.wingL = new THREE.Mesh(wingGeo, wm);
    this.wingR = new THREE.Mesh(wingGeo, wm);
    this.wingR.scale.x = -1;
    g.add(this.wingL, this.wingR);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.scale.setScalar(1.15);
    g.visible = false;
    world.scene.add(g);
    this.group = g;
    this.active = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.state = 'idle';
    this.t = 0;
    this.kind = 'falcon';
    this.label = '游隼';
    this.radius = 30;
  }

  spawn(flock) {
    this.flock = flock;
    this.active = true;
    this.group.visible = true;
    this.state = 'circle';
    this.t = 0;
    this.center = new THREE.Vector3(rand(-6, 6), 45, rand(-4, 6));
    this.pos.copy(this.center).add(new THREE.Vector3(30, 5, 0));
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const prev = this.pos.clone();
    if (this.state === 'circle') {
      const a = this.t * 0.35;
      const target = this.center.clone().add(new THREE.Vector3(Math.cos(a) * 18, Math.sin(this.t * 0.5) * 2, Math.sin(a) * 18));
      this.pos.lerp(target, 1 - Math.exp(-dt * 1.5));
      this.wingL.rotation.z = Math.sin(this.t * 5) * 0.25;
      if (this.t > 7) {
        this.state = 'stoop';
        const prey = this.flock?.pigeons.filter((p) => p.mode !== 'perch').sort(() => Math.random() - 0.5)[0] || this.flock?.pigeons[0];
        this.prey = prey;
        this.t = 0;
      }
    } else if (this.state === 'stoop') {
      // 收拢翅膀高速俯冲
      const tgt = this.prey ? this.prey.pos.clone().add(new THREE.Vector3(0, 0.3, 0)) : new THREE.Vector3(0, 1, 0);
      const d = tgt.sub(this.pos);
      const dist = d.length();
      this.vel.lerp(d.normalize().multiplyScalar(38), 1 - Math.exp(-dt * 3));
      this.pos.addScaledVector(this.vel, dt);
      this.wingL.rotation.z = -0.3;
      if (dist < 1.2 || this.pos.y < 1.2 || this.t > 6) {
        // 被鸽群的急转躲开，拉起离开
        this.state = 'leave';
        this.t = 0;
        this.vel.y = Math.abs(this.vel.y) * 0.3 + 8;
      }
    } else if (this.state === 'leave') {
      this.vel.y += 6 * dt;
      this.vel.multiplyScalar(1 - dt * 0.2);
      this.pos.addScaledVector(this.vel, dt);
      this.wingL.rotation.z = Math.sin(this.t * 7) * 0.5;
      if (this.t > 6) { this.active = false; this.group.visible = false; this.state = 'idle'; }
    }
    this.wingR.rotation.z = -this.wingL.rotation.z;
    const v = this.pos.clone().sub(prev);
    if (v.lengthSq() > 1e-6) {
      this.group.position.copy(this.pos);
      this.group.lookAt(this.pos.clone().add(v));
    }
  }

  get position() {
    return this.pos;
  }
}
