import * as THREE from 'three';
import { getTextures } from '../utils/textures.js';
import { rand, clamp, smoothstep, lerp } from '../utils/math.js';
import { Food } from './Food.js';
import { Nest } from './Nest.js';

// =====================================================================================
//  城市广场环境
//  原鸽的祖先栖息在海边和山地的悬崖上，城市建筑的窗台、檐口与之相似，
//  因此城市成了家鸽最理想的“人造悬崖”。
// =====================================================================================

const WALL_Z = -13;          // 楼房立面
const LEDGES = [5.0, 9.0];   // 窗台/腰线高度
const ROOF_Y = 15.0;

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.bounds = { minX: -14, maxX: 14, minZ: -11.8, maxZ: 12 };
    this.obstacles = [];
    this.perches = [];
    this.nestSites = [];
    this.twigs = [];
    this.wallZ = WALL_Z;
    this.roofY = ROOF_Y;
    this.pool = { x: 5.5, z: 3.5, r: 1.25, waterY: 0.012 };
    this.focus = new THREE.Vector3();
    this.tex = getTextures();

    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildBuilding();
    this._buildPool();
    this._buildFurniture();
    this._buildTwigs();
    this._buildBackdrop();
    this.food = new Food(scene);
  }

  // ------------------------------------------------------------------ 天空
  _buildSky() {
    const geo = new THREE.SphereGeometry(450, 32, 16);
    this.skyUniforms = {
      top: { value: new THREE.Color('#3f7fd0') },
      horizon: { value: new THREE.Color('#b9d4ea') },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color('#fff2d0') },
      night: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: this.skyUniforms,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float night;
        varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(horizon, top, pow(h, 0.55));
          if (vDir.y < 0.0) col = horizon * 0.85;
          float sd = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += sunColor * (pow(sd, 900.0) * 6.0 + pow(sd, 12.0) * 0.25) * (1.0 - night);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    // 星空
    const n = 1200;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const y = Math.abs(u) * 0.95 + 0.05;
      pos.set([Math.cos(a) * r * 400, y * 400, Math.sin(a) * r * 400], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.scene.add(this.stars);
    this.scene.fog = new THREE.Fog('#b9d4ea', 60, 300);
  }

  _buildLights() {
    this.sun = new THREE.DirectionalLight('#fff3dc', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 120;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.01;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight('#cfe0ff', '#8a7a62', 0.7);
    this.scene.add(this.hemi);
    this.lampLights = [];
  }

  // ------------------------------------------------------------------ 地面
  _buildGround() {
    const paving = this.tex.paving;
    paving.repeat.set(28, 28);
    const g = new THREE.PlaneGeometry(64, 64);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ map: paving, roughness: 0.92, color: '#e6e1d7' });
    this.ground = new THREE.Mesh(g, mat);
    this.ground.receiveShadow = true;
    this.ground.name = 'ground';
    this.scene.add(this.ground);
    // 远处的地面
    const far = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#6f7a63', roughness: 1 }));
    far.position.y = -0.02;
    far.receiveShadow = false;
    this.scene.add(far);
    // 广场边缘的路缘石
    const curbMat = new THREE.MeshStandardMaterial({ color: '#b9b2a6', roughness: 0.9 });
    for (const [x, z, w, d] of [[0, 15.5, 34, 0.5], [-17, 1.5, 0.5, 28], [17, 1.5, 0.5, 28]]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, d), curbMat);
      c.position.set(x, 0.075, z);
      c.receiveShadow = true;
      c.castShadow = true;
      this.scene.add(c);
    }
  }

  // ------------------------------------------------------------------ 楼房（人造悬崖）
  _buildBuilding() {
    const brick = this.tex.brick.clone();
    brick.needsUpdate = true;
    brick.repeat.set(30, 13);
    const wallMat = new THREE.MeshStandardMaterial({ map: brick, roughness: 0.95 });
    const W = 40, H = ROOF_Y, D = 8;
    const b = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), wallMat);
    b.position.set(0, H / 2, WALL_Z - D / 2);
    b.receiveShadow = true;
    b.castShadow = true;
    this.scene.add(b);
    const stone = new THREE.MeshStandardMaterial({ color: '#d8d0c2', roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: '#3a322b', roughness: 0.95 });
    const glassMat = new THREE.MeshStandardMaterial({ color: '#33414f', roughness: 0.15, metalness: 0.6, emissive: '#000000' });
    this.windowMat = glassMat;
    // 腰线/窗台：鸽子停栖、过夜的地方
    for (const y of LEDGES) {
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(W, 0.14, 0.36), stone);
      ledge.position.set(0, y - 0.07, WALL_Z + 0.18);
      ledge.castShadow = true;
      ledge.receiveShadow = true;
      this.scene.add(ledge);
      for (let x = -15.6; x <= 15.6; x += 0.48) {
        this.perches.push({ pos: new THREE.Vector3(x, y, WALL_Z + 0.2), yaw: 0, kind: 'ledge', occupant: null, level: y });
      }
    }
    // 屋顶檐口与女儿墙
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, 0.6), stone);
    cornice.position.set(0, ROOF_Y - 0.15, WALL_Z + 0.25);
    cornice.castShadow = true;
    this.scene.add(cornice);
    for (let x = -15.5; x <= 15.5; x += 0.5) {
      this.perches.push({ pos: new THREE.Vector3(x, ROOF_Y, WALL_Z + 0.3), yaw: 0, kind: 'roof', occupant: null, level: ROOF_Y });
    }
    // 窗户
    const winGeo = new THREE.PlaneGeometry(1.5, 2.2);
    for (const [y, h] of [[2.2, 2.8], [6.8, 2.2], [11.2, 2.2]]) {
      for (let x = -15; x <= 15; x += 3.4) {
        const w = new THREE.Mesh(y < 3 ? new THREE.PlaneGeometry(2.4, h) : winGeo, glassMat);
        w.position.set(x, y + 0.2, WALL_Z + 0.012);
        this.scene.add(w);
        const frame = new THREE.Mesh(new THREE.BoxGeometry(y < 3 ? 2.6 : 1.7, 0.08, 0.1), stone);
        frame.position.set(x, y + 0.2 + h / 2 + 0.04, WALL_Z + 0.05);
        this.scene.add(frame);
      }
    }
    // 壁龛（鸽子筑巢的半隐蔽处）
    const nichePositions = [-10.2, -3.4, 3.4, 10.2];
    for (const x of nichePositions) {
      const niche = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 0.04), dark);
      niche.position.set(x, LEDGES[0] + 0.31, WALL_Z + 0.005);
      this.scene.add(niche);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.05, 6, 16, Math.PI), stone);
      arch.position.set(x, LEDGES[0] + 0.62, WALL_Z + 0.04);
      this.scene.add(arch);
      const site = { pos: new THREE.Vector3(x, LEDGES[0], WALL_Z + 0.16), yaw: 0, owner: null, nest: null };
      // 巢位：中间为坐巢的位置，旁边为伴侣站立/换班的位置
      site.spots = [
        { pos: new THREE.Vector3(x, LEDGES[0] + 0.004, WALL_Z + 0.17), yaw: 0, kind: 'nest', occupant: null, level: LEDGES[0], site },
        { pos: new THREE.Vector3(x + 0.27, LEDGES[0], WALL_Z + 0.2), yaw: -0.5, kind: 'nest', occupant: null, level: LEDGES[0], site },
      ];
      site.nest = new Nest(this.scene, site.pos);
      this.nestSites.push(site);
      // 壁龛位置不再作为普通栖位
      for (const p of this.perches) if (p.level === LEDGES[0] && Math.abs(p.pos.x - x) < 0.5) p.reserved = true;
    }
  }

  // ------------------------------------------------------------------ 水洼
  _buildPool() {
    const P = this.pool;
    const shape = new THREE.Shape();
    const N = 48;
    const rad = (a) => P.r * (1 + 0.08 * Math.sin(a * 3 + 1) + 0.05 * Math.sin(a * 5 + 2));
    this.poolRadius = rad;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = rad(a);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const wetGeo = new THREE.ShapeGeometry(shape, 24);
    wetGeo.scale(1.18, 1.18, 1);
    wetGeo.rotateX(-Math.PI / 2);
    const wet = new THREE.Mesh(wetGeo, new THREE.MeshStandardMaterial({ color: '#6e6a62', roughness: 0.45, transparent: true, opacity: 0.55, depthWrite: false }));
    wet.position.set(P.x, 0.003, P.z);
    wet.receiveShadow = true;
    this.scene.add(wet);
    const geo = new THREE.ShapeGeometry(shape, 24);
    geo.rotateX(-Math.PI / 2);
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: '#51626b', roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.78,
      clearcoat: 1, clearcoatRoughness: 0.02,
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.set(P.x, P.waterY, P.z);
    this.water.receiveShadow = true;
    this.scene.add(this.water);
    // 涟漪
    this.ripples = [];
    const rg = new THREE.RingGeometry(0.9, 1, 32).rotateX(-Math.PI / 2);
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      this.scene.add(m);
      this.ripples.push({ mesh: m, t: 1 });
    }
    // 水花
    const dropGeo = new THREE.SphereGeometry(0.006, 5, 4);
    this.drops = new THREE.InstancedMesh(dropGeo, new THREE.MeshStandardMaterial({ color: '#dfefff', roughness: 0.1, transparent: true, opacity: 0.8 }), 200);
    this.drops.frustumCulled = false;
    this.dropData = [];
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 200; i++) { this.drops.setMatrixAt(i, zero); this.dropData.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3() }); }
    this.scene.add(this.drops);
  }

  inPool(x, z, margin = 0) {
    const dx = x - this.pool.x, dz = z - this.pool.z;
    const a = Math.atan2(dz, dx);
    return Math.hypot(dx, dz) < this.poolRadius(a) - margin;
  }

  // 水边的点：从水洼中心沿给定方向
  poolEdgePoint(fromPos, inset = 0.08) {
    const a = Math.atan2(fromPos.z - this.pool.z, fromPos.x - this.pool.x);
    const r = this.poolRadius(a) + inset;
    return new THREE.Vector3(this.pool.x + Math.cos(a) * r, 0, this.pool.z + Math.sin(a) * r);
  }

  ripple(x, z, size = 0.15) {
    const r = this.ripples.find((q) => q.t >= 1);
    if (!r) return;
    r.t = 0;
    r.size = size;
    r.mesh.position.set(x, this.pool.waterY + 0.001, z);
    r.mesh.visible = true;
  }

  splash(pos, n = 10, power = 0.8) {
    for (const d of this.dropData) {
      if (n <= 0) break;
      if (d.alive) continue;
      d.alive = true;
      d.pos.copy(pos);
      d.vel.set(rand(-0.6, 0.6) * power, rand(0.6, 1.4) * power, rand(-0.6, 0.6) * power);
      n--;
    }
  }

  // ------------------------------------------------------------------ 长椅、树、路灯
  _buildFurniture() {
    const wood = new THREE.MeshStandardMaterial({ color: '#7a5634', roughness: 0.8 });
    const iron = new THREE.MeshStandardMaterial({ color: '#2d3034', roughness: 0.5, metalness: 0.6 });
    this.benches = [];
    for (const [x, z, yaw] of [[-4.5, 6.5, Math.PI], [-9, 6.5, Math.PI], [9.5, 8, Math.PI * 0.9]]) {
      const g = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const slat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.04, 0.12), wood);
        slat.position.set(0, 0.45, -0.15 + k * 0.15);
        g.add(slat);
      }
      for (let k = 0; k < 2; k++) {
        const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.035), wood);
        back.position.set(0, 0.62 + k * 0.16, -0.24);
        back.rotation.x = -0.15;
        g.add(back);
      }
      for (const sx of [-0.8, 0.8]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.5), iron);
        leg.position.set(sx, 0.225, -0.05);
        g.add(leg);
      }
      g.position.set(x, 0, z);
      g.rotation.y = yaw;
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(g);
      this.benches.push({ x, z, yaw, group: g, seat: new THREE.Vector3(x, 0.47, z) });
      this.obstacles.push({ x, z, r: 0.95 });
    }
    // 花坛与树
    const soil = new THREE.MeshStandardMaterial({ color: '#4a3b2a', roughness: 1 });
    const planter = new THREE.MeshStandardMaterial({ color: '#a59d90', roughness: 0.9 });
    const bark = new THREE.MeshStandardMaterial({ color: '#5a4636', roughness: 1 });
    const leaves = new THREE.MeshStandardMaterial({ color: '#4f7a3a', roughness: 0.9, flatShading: true });
    this.trees = [];
    for (const [x, z, s] of [[-11.5, -5.5, 1.1], [11.5, -5.5, 1.0], [-12, 9.5, 1.2], [12.5, 10, 0.95]]) {
      const pl = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.45, 2.2), planter);
      pl.position.set(x, 0.225, z);
      pl.castShadow = pl.receiveShadow = true;
      const so = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.05, 2.0), soil);
      so.position.set(x, 0.44, z);
      so.receiveShadow = true;
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.18 * s, 3.2 * s, 8), bark);
      tr.position.set(x, 0.45 + 1.6 * s, z);
      tr.castShadow = true;
      this.scene.add(pl, so, tr);
      const crown = new THREE.Group();
      for (let k = 0; k < 7; k++) {
        const f = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.8, 1.3) * s, 1), leaves);
        f.position.set(rand(-0.9, 0.9) * s, rand(-0.3, 0.8) * s, rand(-0.9, 0.9) * s);
        f.castShadow = true;
        f.receiveShadow = true;
        crown.add(f);
      }
      crown.position.set(x, 0.45 + 3.6 * s, z);
      this.scene.add(crown);
      this.trees.push({ x, z, crown });
      this.obstacles.push({ x, z, r: 1.45 });
    }
    // 路灯
    const bulbMat = new THREE.MeshStandardMaterial({ color: '#fff6e0', emissive: '#ffd98a', emissiveIntensity: 0 });
    this.bulbMat = bulbMat;
    this.lampGlows = [];
    for (const [x, z] of [[-7, -3], [7, -3], [-3, 11], [3.5, 11]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 4, 8), iron);
      post.position.set(x, 2, z);
      post.castShadow = true;
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.16, 0.3, 8), iron);
      head.position.set(x, 4.1, z);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), bulbMat);
      bulb.position.set(x, 3.9, z);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.glow, color: '#ffd28a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.setScalar(2.2);
      glow.position.set(x, 3.9, z);
      this.scene.add(post, head, bulb, glow);
      this.lampGlows.push(glow);
      this.obstacles.push({ x, z, r: 0.3 });
      // 路灯顶部也可以停鸽子
      this.perches.push({ pos: new THREE.Vector3(x, 4.25, z), yaw: rand(0, 6), kind: 'lamp', occupant: null, level: 4.25 });
    }
    for (const [x, z] of [[-5, 2], [6, 6]]) {
      const l = new THREE.PointLight('#ffcf8a', 0, 16, 1.6);
      l.position.set(x, 3.9, z);
      this.scene.add(l);
      this.lampLights.push(l);
    }
  }

  // ------------------------------------------------------------------ 筑巢材料（细枝）
  _buildTwigs() {
    const geo = new THREE.CylinderGeometry(0.0025, 0.002, 0.14, 4);
    geo.rotateZ(Math.PI / 2);
    this.twigMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#8a6a45', roughness: 1 }), 80);
    this.twigMesh.castShadow = true;
    this.twigMesh.frustumCulled = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < 80; i++) {
      const tree = this.trees[i % this.trees.length];
      // 细枝散落在花坛周围的地面上
      const a = rand(0, Math.PI * 2), r = rand(1.5, 3.2);
      const pos = new THREE.Vector3(tree.x + Math.cos(a) * r, 0.003, tree.z + Math.sin(a) * r);
      pos.x = clamp(pos.x, this.bounds.minX, this.bounds.maxX);
      pos.z = clamp(pos.z, this.bounds.minZ, this.bounds.maxZ);
      q.setFromEuler(new THREE.Euler(0, rand(0, Math.PI), 0));
      m.compose(pos, q, s);
      this.twigMesh.setMatrixAt(i, m);
      this.twigs.push({ i, pos, taken: false, claimedBy: null });
    }
    this.scene.add(this.twigMesh);
  }

  takeTwig(tw) {
    tw.taken = true;
    tw.claimedBy = null;
    this.twigMesh.setMatrixAt(tw.i, new THREE.Matrix4().makeScale(0, 0, 0));
    this.twigMesh.instanceMatrix.needsUpdate = true;
  }

  // 细枝会随时间重新出现（风吹落的新枝）
  regrowTwigs() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    for (const tw of this.twigs) {
      if (tw.taken && Math.random() < 0.3) {
        tw.taken = false;
        q.setFromEuler(new THREE.Euler(0, rand(0, Math.PI), 0));
        m.compose(tw.pos, q, s);
        this.twigMesh.setMatrixAt(tw.i, m);
      }
    }
    this.twigMesh.instanceMatrix.needsUpdate = true;
  }

  nearestTwig(pos, self) {
    let best = null, bd = Infinity;
    for (const tw of this.twigs) {
      if (tw.taken || (tw.claimedBy && tw.claimedBy !== self)) continue;
      const d = Math.hypot(tw.pos.x - pos.x, tw.pos.z - pos.z);
      if (d < bd) { bd = d; best = tw; }
    }
    return best;
  }

  // ------------------------------------------------------------------ 远景
  _buildBackdrop() {
    const mats = ['#a49c90', '#8f969c', '#b5a691', '#9a8f86'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
    const add = (x, z, w, h, d) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[Math.floor(Math.random() * mats.length)]);
      b.position.set(x, h / 2, z);
      this.scene.add(b);
    };
    for (let x = -60; x <= 60; x += rand(9, 14)) add(x, -34 - rand(0, 10), rand(8, 13), rand(12, 30), rand(8, 14));
    for (let z = -20; z <= 50; z += rand(10, 15)) {
      add(-34 - rand(0, 8), z, rand(8, 12), rand(8, 20), rand(8, 13));
      add(34 + rand(0, 8), z, rand(8, 12), rand(8, 20), rand(8, 13));
    }
    for (let x = -50; x <= 50; x += rand(10, 15)) add(x, 40 + rand(0, 10), rand(8, 13), rand(8, 18), rand(8, 12));
  }

  // ------------------------------------------------------------------ 查询
  groundY(x, z) {
    return 0;
  }

  clampToBounds(v, margin = 0) {
    v.x = clamp(v.x, this.bounds.minX + margin, this.bounds.maxX - margin);
    v.z = clamp(v.z, this.bounds.minZ + margin, this.bounds.maxZ - margin);
    return v;
  }

  randomGroundPoint(near = null, radius = 4) {
    const v = new THREE.Vector3();
    for (let k = 0; k < 20; k++) {
      if (near) v.set(near.x + rand(-radius, radius), 0, near.z + rand(-radius, radius));
      else v.set(rand(this.bounds.minX, this.bounds.maxX), 0, rand(this.bounds.minZ, this.bounds.maxZ));
      this.clampToBounds(v, 0.5);
      if (!this.blocked(v.x, v.z, 0.2)) return v;
    }
    return v;
  }

  blocked(x, z, pad = 0) {
    for (const o of this.obstacles) if (Math.hypot(x - o.x, z - o.z) < o.r + pad) return true;
    return false;
  }

  freePerch(near, kinds = ['ledge', 'roof'], self = null) {
    let best = null, bd = Infinity;
    for (const p of this.perches) {
      if (p.reserved || !kinds.includes(p.kind)) continue;
      if (p.occupant && p.occupant !== self) continue;
      const d = near ? near.distanceTo(p.pos) + rand(0, 3) : rand(0, 10);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // ------------------------------------------------------------------ 每帧更新
  update(dt, day, focus) {
    const sky = day.skyColors();
    this.skyUniforms.top.value.copy(sky.top);
    this.skyUniforms.horizon.value.copy(sky.horizon);
    this.skyUniforms.sunDir.value.copy(day.sunDir);
    const daylight = day.daylight;
    this.skyUniforms.night.value = 1 - daylight;
    this.scene.fog.color.copy(sky.horizon);
    this.stars.material.opacity = smoothstep(0.5, 0.05, daylight) * 0.9;

    // 太阳 / 月亮
    const sunUp = day.sunElevation > -0.05;
    const dir = sunUp ? day.sunDir : day.moonDir;
    this.focus.copy(focus);
    this.sun.position.copy(this.focus).addScaledVector(dir, 60);
    this.sun.target.position.copy(this.focus);
    if (sunUp) {
      const gold = sky.golden;
      this.sun.color.set('#fff3dc').lerp(new THREE.Color('#ffb36b'), gold * 0.8);
      this.sun.intensity = 3.0 * day.sunStrength + 0.05;
    } else {
      this.sun.color.set('#9fb4ff');
      this.sun.intensity = 0.35;
    }
    this.hemi.intensity = lerp(0.12, 0.8, daylight);
    this.hemi.color.copy(sky.top).lerp(new THREE.Color('#ffffff'), 0.5);
    // 夜间路灯
    const lampOn = smoothstep(0.45, 0.15, daylight);
    this.bulbMat.emissiveIntensity = lampOn * 3;
    for (const l of this.lampLights) l.intensity = lampOn * 9;
    for (const g of this.lampGlows) g.material.opacity = lampOn * 0.8;
    this.windowMat.emissive.set('#ffcf7a').multiplyScalar(lampOn * 0.35);

    // 树冠随风轻摇
    const t = performance.now() * 0.001;
    for (const tr of this.trees) tr.crown.rotation.z = Math.sin(t * 0.8 + tr.x) * 0.015;

    // 涟漪与水花
    for (const r of this.ripples) {
      if (r.t >= 1) continue;
      r.t = Math.min(1, r.t + dt / 1.4);
      const s = (r.size || 0.15) * (0.3 + r.t * 3);
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = (1 - r.t) * 0.35;
      if (r.t >= 1) r.mesh.visible = false;
    }
    let any = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.dropData.length; i++) {
      const d = this.dropData[i];
      if (!d.alive) continue;
      any = true;
      d.vel.y -= 9.8 * dt;
      d.pos.addScaledVector(d.vel, dt);
      if (d.pos.y < this.pool.waterY) {
        d.alive = false;
        m.makeScale(0, 0, 0);
      } else {
        m.makeTranslation(d.pos.x, d.pos.y, d.pos.z);
      }
      this.drops.setMatrixAt(i, m);
    }
    if (any || this._dropsDirty) this.drops.instanceMatrix.needsUpdate = true;
    this._dropsDirty = any;

    this.food.update(dt);
    for (const s of this.nestSites) s.nest.update(dt);
  }
}
