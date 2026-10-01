import * as THREE from 'three';
import { rand, clamp, lerp } from '../utils/math.js';

// 鸽巢：鸽子的巢很简陋——雄鸽衔来细枝，雌鸽坐在原地把枝条塞到身体周围，形成浅盘。
// 一窝两枚白色卵，孵化后的雏鸽（乳鸽）由双亲用“鸽乳”哺育。
export class Nest {
  constructor(scene, pos) {
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    scene.add(this.group);
    this.material = 0; // 0..1
    this.twigs = [];
    const twigMat = new THREE.MeshStandardMaterial({ color: '#8b6a47', roughness: 1 });
    const geo = new THREE.CylinderGeometry(0.003, 0.0025, 0.13, 4);
    geo.rotateZ(Math.PI / 2);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + rand(-0.2, 0.2);
      const r = rand(0.05, 0.085);
      const t = new THREE.Mesh(geo, twigMat);
      t.position.set(Math.cos(a) * r, 0.004 + (i % 3) * 0.004, Math.sin(a) * r);
      t.rotation.set(rand(-0.1, 0.1), -a + Math.PI / 2 + rand(-0.4, 0.4), rand(-0.1, 0.1));
      t.castShadow = true;
      t.visible = false;
      this.group.add(t);
      this.twigs.push(t);
    }
    // 卵：白色，约 4 × 3 cm
    const eggGeo = new THREE.SphereGeometry(1, 16, 12);
    eggGeo.scale(0.0145, 0.0145, 0.02);
    const eggMat = new THREE.MeshPhysicalMaterial({ color: '#f6f3ec', roughness: 0.35, clearcoat: 0.3 });
    this.eggs = [0, 1].map((i) => {
      const e = new THREE.Mesh(eggGeo, eggMat);
      e.position.set(i ? 0.014 : -0.014, 0.016, i ? -0.006 : 0.006);
      e.rotation.y = i ? 0.6 : -0.3;
      e.castShadow = true;
      e.visible = false;
      this.group.add(e);
      return e;
    });
    this.squabs = [0, 1].map((i) => this._makeSquab(i));
    this.eggCount = 0;
  }

  _makeSquab(i) {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: '#e7b89a', roughness: 0.8 });
    const down = new THREE.MeshStandardMaterial({ color: '#f0d870', roughness: 1 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10).scale(0.03, 0.026, 0.036), down);
    body.position.y = 0.026;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), skin);
    head.position.set(0, 0.05, 0.032);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.007, 0.022, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#5a4a44', roughness: 0.6 }));
    beak.position.set(0, 0.046, 0.054);
    const wingL = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6).scale(0.006, 0.014, 0.022), down);
    wingL.position.set(0.028, 0.03, 0);
    const wingR = wingL.clone();
    wingR.position.x = -0.028;
    for (const m of [body, head, beak, wingL, wingR]) { m.castShadow = true; g.add(m); }
    g.position.set(i ? 0.03 : -0.03, 0, i ? -0.01 : 0.01);
    g.rotation.y = i ? 0.5 : -0.4;
    g.visible = false;
    this.group.add(g);
    return { group: g, body, head, beak, wingL, wingR, down, skin, age: 0, begging: 0 };
  }

  setMaterial(v) {
    this.material = clamp(v, 0, 1);
    const n = Math.round(this.material * this.twigs.length);
    this.twigs.forEach((t, i) => (t.visible = i < n));
  }

  setEggs(n) {
    this.eggCount = n;
    this.eggs.forEach((e, i) => (e.visible = i < n));
  }

  // ages: 每只雏鸽的日龄（null 表示不存在）
  setSquabs(ages) {
    this.squabs.forEach((s, i) => {
      const age = ages[i];
      if (age == null) { s.group.visible = false; return; }
      s.group.visible = true;
      s.age = age;
      // 0–30 日龄：体型由约 15 g 长到接近成鸟；黄色绒羽逐渐被灰色羽毛取代
      const k = clamp(age / 28, 0, 1);
      s.group.scale.setScalar(lerp(0.55, 2.1, Math.pow(k, 0.7)));
      s.down.color.set('#f0d870').lerp(new THREE.Color('#8c95a3'), clamp((age - 8) / 14, 0, 1));
      s.skin.color.set('#e7b89a').lerp(new THREE.Color('#7b8392'), clamp((age - 10) / 12, 0, 1));
    });
  }

  beg(i, v = 1) {
    this.squabs[i].begging = Math.max(this.squabs[i].begging, v);
  }

  get worldPos() {
    return this.group.position;
  }

  update(dt) {
    const t = performance.now() * 0.001;
    for (const s of this.squabs) {
      if (!s.group.visible) continue;
      s.begging = Math.max(0, s.begging - dt * 0.5);
      // 雏鸽乞食：抖动翅膀、伸头
      const b = s.begging;
      s.wingL.rotation.z = Math.sin(t * 22) * 0.6 * b;
      s.wingR.rotation.z = -Math.sin(t * 22) * 0.6 * b;
      s.head.position.y = 0.05 + b * 0.012 + Math.sin(t * 1.3 + s.age) * 0.002;
      s.beak.position.y = s.head.position.y - 0.004;
      s.body.scale.y = 1 + Math.sin(t * 2.5) * 0.03;
    }
  }
}
