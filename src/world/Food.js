import * as THREE from 'three';
import { rand, randInt } from '../utils/math.js';

// 地面上的食物颗粒（谷粒、面包屑），带空间哈希便于鸽子快速查找附近食物
const MAX = 1500;
const CELL = 1.0;

export class Food {
  constructor(scene) {
    this.items = [];
    this.free = [];
    this.grid = new Map();
    this.airborne = [];
    const geo = new THREE.SphereGeometry(1, 7, 5);
    geo.scale(0.0045, 0.0028, 0.0065);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const color = new THREE.Color();
    for (let i = 0; i < MAX; i++) {
      this.items.push({ i, alive: false, pos: new THREE.Vector3(), grams: 0.25, kind: 'seed', claimedBy: null, cell: null });
      this.free.push(MAX - 1 - i);
      this.mesh.setColorAt(i, color.set('#c9a24a'));
      this._hide(i);
    }
    this.mesh.instanceColor.needsUpdate = true;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
    this.totalEaten = 0;
    this.count = 0;
  }

  _hide(i) {
    this._m = this._m || new THREE.Matrix4();
    this._m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, this._m);
  }

  _key(x, z) {
    return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  }

  _place(item) {
    const key = this._key(item.pos.x, item.pos.z);
    item.cell = key;
    let arr = this.grid.get(key);
    if (!arr) this.grid.set(key, (arr = []));
    arr.push(item);
    const kinds = { seed: ['#c9a24a', 1], corn: ['#e3b13a', 1.5], crumb: ['#d9bf8c', 1.8], pea: ['#8a9a4a', 1.3] };
    const [hex, sc] = kinds[item.kind] || kinds.seed;
    this._e.set(0, rand(0, Math.PI * 2), 0);
    this._q.setFromEuler(this._e);
    this._s.setScalar(sc * rand(0.85, 1.15));
    this._m.compose(item.pos, this._q, this._s);
    this.mesh.setMatrixAt(item.i, this._m);
    this.mesh.setColorAt(item.i, new THREE.Color(hex));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  // 直接在地面放置
  spawnAt(x, z, kind = 'seed', y = 0.003) {
    const idx = this.free.pop();
    if (idx === undefined) return null;
    const it = this.items[idx];
    it.alive = true;
    it.kind = kind;
    it.grams = { seed: 0.2, corn: 0.3, crumb: 0.35, pea: 0.25 }[kind] ?? 0.2;
    it.claimedBy = null;
    it.pos.set(x, y, z);
    this._place(it);
    this.count++;
    return it;
  }

  // 撒一把：颗粒以抛物线飞出后落地
  scatter(from, center, n = 60, radius = 0.8, kind = 'seed') {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = center.x + Math.cos(a) * r, tz = center.z + Math.sin(a) * r;
      const T = rand(0.45, 0.8);
      const vel = new THREE.Vector3((tx - from.x) / T, 0, (tz - from.z) / T);
      vel.y = (0 - from.y + 0.5 * 9.8 * T * T) / T;
      this.airborne.push({ pos: from.clone(), vel, kind, t: 0 });
    }
  }

  // 自然散落的食物（面包屑、草籽等）
  sprinkleNatural(bounds, n = 6) {
    for (let k = 0; k < n; k++) {
      const x = rand(bounds.minX + 1, bounds.maxX - 1);
      const z = rand(bounds.minZ + 1, bounds.maxZ - 1);
      const cnt = randInt(1, 4);
      for (let j = 0; j < cnt; j++) this.spawnAt(x + rand(-0.15, 0.15), z + rand(-0.15, 0.15), Math.random() < 0.5 ? 'crumb' : 'seed');
    }
  }

  update(dt) {
    // 地上积攒太多时，部分食物会被麻雀吃掉或被清洁工扫走
    if (this.count > 450 && Math.random() < dt * 4) {
      const alive = this.items.filter((it) => it.alive && !it.claimedBy);
      if (alive.length) this.remove(alive[Math.floor(Math.random() * alive.length)]);
    }
    if (!this.airborne.length) return;
    const m = this._m;
    let k = 0;
    for (const a of this.airborne) {
      a.vel.y -= 9.8 * dt;
      a.pos.addScaledVector(a.vel, dt);
      if (a.pos.y <= 0.003) {
        this.spawnAt(a.pos.x, a.pos.z, a.kind);
      } else {
        this.airborne[k++] = a;
      }
    }
    this.airborne.length = k;
    void m;
  }

  remove(item) {
    if (!item.alive) return;
    item.alive = false;
    const arr = this.grid.get(item.cell);
    if (arr) {
      const j = arr.indexOf(item);
      if (j >= 0) arr.splice(j, 1);
    }
    item.claimedBy = null;
    this._hide(item.i);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.free.push(item.i);
    this.count--;
  }

  // 查找半径内最近的、未被其他鸽子锁定的食物
  nearest(pos, radius, self = null) {
    let best = null, bestD = radius * radius;
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const r = Math.ceil(radius / CELL);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const arr = this.grid.get(`${cx + i},${cz + j}`);
        if (!arr) continue;
        for (const it of arr) {
          if (it.claimedBy && it.claimedBy !== self) continue;
          const dx = it.pos.x - pos.x, dz = it.pos.z - pos.z;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = it; }
        }
      }
    }
    return best;
  }

  // 统计半径内的食物数量（用于判断“食物富集区”）
  countNear(pos, radius) {
    let n = 0;
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const r = Math.ceil(radius / CELL);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const arr = this.grid.get(`${cx + i},${cz + j}`);
        if (!arr) continue;
        for (const it of arr) if (Math.hypot(it.pos.x - pos.x, it.pos.z - pos.z) < radius) n++;
      }
    }
    return n;
  }

  // 返回食物最密集的位置（视觉上鸽子能远远看到成群的同伴和散落的食物）
  densestSpot(sampleN = 40) {
    let best = null, bestN = 0;
    const alive = this.items.filter((i) => i.alive);
    for (let k = 0; k < Math.min(sampleN, alive.length); k++) {
      const it = alive[Math.floor(Math.random() * alive.length)];
      const n = this.countNear(it.pos, 1.2);
      if (n > bestN) { bestN = n; best = it.pos; }
    }
    return best ? { pos: best.clone(), n: bestN } : null;
  }
}
