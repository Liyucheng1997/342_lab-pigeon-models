import * as THREE from 'three';
import { getTextures, getIris } from '../utils/textures.js';
import { resolveMorph, piedMask } from './Plumage.js';
import { RigidBatch } from './RigidBatch.js';
import { clamp, lerp, smoothstep, seeded } from '../utils/math.js';

// =====================================================================================
//  鸽子（原鸽 Columba livia）程序化三维模型
//  单位：米。坐标：鸽子面朝 +Z，+Y 向上，+X 为鸽子的左侧。
//  主要尺寸参考：体长约 32 cm，翼展约 64–70 cm，体重约 300–380 g。
// =====================================================================================

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const C = (hex) => new THREE.Color(hex);
const _c = new THREE.Color();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

// ---------- 共享材质 ----------
let SHARED = null;
function sharedMaterials() {
  if (SHARED) return SHARED;
  const tex = getTextures();
  const body = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0,
    bumpMap: tex.bodyFeather, bumpScale: 0.6,
  });
  const feather = new THREE.MeshStandardMaterial({
    vertexColors: true, map: tex.feather, alphaTest: 0.42, side: THREE.DoubleSide,
    roughness: 0.78, metalness: 0,
  });
  // 翼下覆羽颜色更浅（原鸽翼下近白色）：背面片元提亮并降低饱和度
  feather.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       if (!gl_FrontFacing) {
         float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l), 0.45) * 1.35 + 0.04;
       }`
    );
  };
  const featherDepth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, map: tex.feather, alphaTest: 0.42, side: THREE.DoubleSide,
  });
  const skin = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.scales, roughness: 0.55 });
  const hard = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42 });
  SHARED = { body, feather, featherDepth, skin, hard };
  return SHARED;
}

// 颈部虹彩强度贴图：沿颈部长度方向的渐变（两端不闪光）
let IRID_MAP = null;
function iridescenceMap() {
  if (IRID_MAP) return IRID_MAP;
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 128, 0, 0);
  gr.addColorStop(0.0, '#000');
  gr.addColorStop(0.12, '#555');
  gr.addColorStop(0.3, '#fff');
  gr.addColorStop(0.72, '#fff');
  gr.addColorStop(0.9, '#222');
  gr.addColorStop(1.0, '#000');
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 128);
  IRID_MAP = new THREE.CanvasTexture(c);
  return IRID_MAP;
}

// ---------- 羽片几何 ----------
// 羽根在原点，羽尖指向 -Z，背面（上表面）朝 +Y。
function featherGeometry(L, W, { camber = 0.05, bend = 0.08, curve = 0, segL = 6, colorFn }) {
  const g = new THREE.PlaneGeometry(W, L, 2, segL);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    const x = p.getX(i);
    const cu = (u - 0.5) * 2;
    const X = x + curve * L * v * v;
    const Y = -bend * L * v * v - camber * W * cu * cu;
    const Z = -v * L;
    p.setXYZ(i, X, Y, Z);
    const c = colorFn ? colorFn(u, v) : _c.setRGB(1, 1, 1);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// 沿 +Z 方向的锥形/胶囊形零件（趾节、喙等）
function taperedTube(len, r0, r1, radial = 8, rings = 4, { flatten = 1, droop = 0, cap = true } = {}) {
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, rings, !cap);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const t = clamp(z / len, 0, 1);
    p.setX(i, p.getX(i) * flatten);
    p.setY(i, p.getY(i) - droop * t * t * len);
  }
  g.computeVertexNormals();
  return g;
}

function ellipsoid(rx, ry, rz, ws = 16, hs = 12) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  return g;
}

// 躯干外形：把单位球面上的点 (x,y,t)（t 为前后方向）映射到鸽子躯干表面
function torsoShape(x, y, t, out) {
  const back = Math.max(0, -t), front = Math.max(0, t);
  const w = 0.046 * (1 - 0.42 * Math.pow(back, 1.6)) * (1 - 0.12 * Math.pow(front, 2));
  const top = 0.038 * (1 - 0.35 * back) + 0.006 * front;
  const bottom = 0.044 + 0.014 * Math.exp(-((t - 0.4) ** 2) / 0.12) - 0.02 * Math.pow(back, 1.3);
  let Y = y > 0 ? y * top : y * bottom;
  let Z = t > 0 ? t * 0.07 : t * 0.105;
  Y += 0.016 * back * back + 0.004 * t;
  // 龙骨突（胸肌）略向前下方鼓出
  Z += 0.012 * Math.max(0, -y) * front;
  return out.set(x * w, Y, Z);
}

function mixColor(a, b, t) {
  return _c.copy(a).lerp(b, clamp(t, 0, 1));
}

export class PigeonModel {
  constructor({ morph = 'blueBar', sex = 'male', seed = 1, size = 1 } = {}) {
    this.seed = seed;
    this.rng = seeded(seed * 7919 + 13);
    this.colors = resolveMorph(morph);
    this.sex = sex;
    this.size = size;
    this.mats = sharedMaterials();

    this.root = new THREE.Group();      // 地面位置 + 朝向（由实体控制）
    this.root.name = 'pigeon';
    this.body = new THREE.Group();      // 躯干：高度、俯仰、侧滚
    this.body.rotation.order = 'YXZ';
    this.root.add(this.body);
    this.root.scale.setScalar(size);

    this.bodyBatch = new RigidBatch(this.mats.body, 'body');
    this.featherBatch = new RigidBatch(this.mats.feather, 'feathers');
    this.skinBatch = new RigidBatch(this.mats.skin, 'legs');
    this.hardBatch = new RigidBatch(this.mats.hard, 'keratin');

    this._buildTorso();
    this._buildHead();
    this._buildNeck();
    this.wings = [this._buildWing(1), this._buildWing(-1)];
    this._buildWingShells();
    this._buildTail();
    this.legs = [this._buildLeg(1), this._buildLeg(-1)];

    this.bodyBatch.build(this.body, { radius: 0.5 });
    this.featherBatch.build(this.body, { depthMaterial: this.mats.featherDepth, radius: 0.6 });
    this.skinBatch.build(this.body, { radius: 0.4 });
    this.hardBatch.build(this.body, { radius: 0.4 });

    this._invBody = new THREE.Matrix4();
    // 初始姿态
    this.setWing(0, { fold: 1 });
    this.setWing(1, { fold: 1 });
    this.setTail({});
  }

  // 体积较大、刚性跟随单个节点的部件直接作为独立网格（由 GPU 变换），无需 CPU 合批
  _addMesh(node, geo, colorFn) {
    if (!geo.attributes.color) {
      const p = geo.attributes.position;
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const c = colorFn(p.getX(i), p.getY(i), p.getZ(i));
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const m = new THREE.Mesh(geo, this.mats.body);
    m.castShadow = true;
    m.receiveShadow = true;
    node.add(m);
    (this._meshes ||= []).push(m);
    return m;
  }

  // =================================================================== 躯干
  _buildTorso() {
    const col = this.colors;
    const geo = new THREE.SphereGeometry(1, 56, 40);
    geo.rotateX(Math.PI / 2); // 两极沿 Z 轴
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const pied = col.pied;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), t = p.getZ(i);
      const back = Math.max(0, -t);
      torsoShape(x, y, t, _v1);
      const X = _v1.x, Y = _v1.y, Z = _v1.z;
      p.setXYZ(i, X, Y, Z);

      // ----- 分区着色 -----
      const dorsal = smoothstep(-0.15, 0.45, y);
      const c = new THREE.Color().copy(col.belly);
      c.lerp(col.breast, smoothstep(0.0, 0.55, t));
      c.lerp(col.neck, smoothstep(0.62, 0.95, t) * (0.5 + 0.5 * (1 - dorsal)));
      const dors = new THREE.Color().copy(col.back);
      // 腰部白斑（原鸽的典型特征，飞行时可见）
      dors.lerp(col.rump, smoothstep(0.62, 0.72, back) * (1 - smoothstep(0.86, 0.95, back)) * smoothstep(0.5, 0.85, y));
      c.lerp(dors, dorsal);
      // 尾下覆羽偏深
      c.lerp(col.tail, smoothstep(0.75, 0.95, back) * (1 - dorsal) * 0.6);
      if (pied && piedMask(X * 10, Y * 10, Z * 10, this.seed, pied)) c.setRGB(0.95, 0.94, 0.92);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // 体羽纹理重复
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * 4);
    geo.computeVertexNormals();
    this.torsoNode = new THREE.Object3D();
    this.body.add(this.torsoNode);
    this._addMesh(this.torsoNode, geo);

    // 胸前与颈基部连接处的羽毛团，填补颈部与躯干之间的缝隙
    this.chestNode = new THREE.Object3D();
    this.chestNode.position.set(0, 0.004, 0.05);
    this.chestNode.rotation.x = -0.5;
    this.body.add(this.chestNode);
    const chest = ellipsoid(0.031, 0.034, 0.028, 24, 16);
    this._addMesh(this.chestNode, chest, (x, y, z) =>
      mixColor(col.breast, col.neck, smoothstep(-0.01, 0.03, y + z * 0.3)).clone());
  }

  // =================================================================== 头部
  _buildHead() {
    const col = this.colors;
    this.head = new THREE.Group();        // 头的枢轴（颈部连接点，位于后脑下方）
    this.head.rotation.order = 'YXZ';
    this.body.add(this.head);
    this.headMesh = new THREE.Object3D();
    this.headMesh.position.set(0, 0.012, 0.013);
    this.head.add(this.headMesh);

    const geo = new THREE.SphereGeometry(1, 36, 28);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const fz = Math.max(0, z);
      // 前额向喙部倾斜、面部收窄，后脑圆润
      let X = x * 0.0176 * (1 - 0.34 * fz * fz);
      let Y = y > 0 ? y * 0.0188 * (1 - 0.42 * fz * fz * (0.4 + 0.6 * y)) : y * 0.0165 * (1 - 0.25 * fz);
      let Z = z > 0 ? z * 0.0235 : z * 0.0205;
      Y -= 0.003 * fz * fz;
      p.setXYZ(i, X, Y, Z);
      const c = new THREE.Color().copy(col.head);
      // 下颌与喉部向颈色过渡
      c.lerp(col.neck, smoothstep(0.1, -0.8, y) * smoothstep(0.6, -0.4, z));
      if (col.pied && piedMask(X * 30, Y * 30, Z * 30, this.seed + 5, col.pied * 0.9)) c.setRGB(0.95, 0.94, 0.92);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 8, uv.getY(i) * 5);
    geo.computeVertexNormals();
    this._addMesh(this.headMesh, geo);

    // ---- 喙 ----
    this.beak = new THREE.Object3D();
    this.beak.position.set(0, -0.0036, 0.0196);
    this.beak.rotation.x = 0.12;
    this.headMesh.add(this.beak);
    const upper = taperedTube(0.0195, 0.0041, 0.0008, 12, 8, { flatten: 0.7, droop: 0.12 });
    // 上喙：截掉下半部分，形成略扁平的下缘
    const up = upper.attributes.position;
    for (let i = 0; i < up.count; i++) up.setY(i, Math.max(up.getY(i), -0.0012 - 0.08 * up.getZ(i) * up.getZ(i) / 0.0195));
    upper.computeVertexNormals();
    this.hardBatch.add(this.beak, upper, (x, y, z) =>
      mixColor(col.beak, C('#6b6b6b'), smoothstep(0.013, 0.0195, z) * 0.5).clone());
    this.lowerJaw = new THREE.Object3D();
    this.lowerJaw.position.set(0, -0.0014, 0.001);
    this.beak.add(this.lowerJaw);
    const lower = taperedTube(0.0155, 0.0032, 0.0007, 10, 6, { flatten: 0.7, droop: 0.05 });
    const lp = lower.attributes.position;
    for (let i = 0; i < lp.count; i++) lp.setY(i, Math.min(lp.getY(i), 0.0004));
    lower.computeVertexNormals();
    this.hardBatch.add(this.lowerJaw, lower, col.beak.clone().multiplyScalar(1.15));
    // 蜡膜（鼻瘤）：喙基部上方白色粉状的隆起，成年雄鸽尤为明显
    const cereSize = this.sex === 'male' ? 1.15 : 0.95;
    for (const s of [1, -1]) {
      const n = new THREE.Object3D();
      n.position.set(s * 0.0016, 0.0022, 0.0042);
      n.rotation.set(-0.3, s * 0.15, 0);
      n.scale.setScalar(cereSize);
      this.beak.add(n);
      this.bodyBatch.add(n, ellipsoid(0.0022, 0.0019, 0.0048, 12, 8), col.cere.clone().multiplyScalar(0.92));
    }

    // ---- 眼睛：橙红色虹膜，位于头侧，单眼视野约 170° ----
    this.eyes = [];
    this.lids = [];
    const eyeR = 0.0043;
    const irisColor = this.colors.key === 'white' ? '#3a2416' : '#e8701a'; // 白鸽常为暗色“牛眼”
    const eyeMat = new THREE.MeshPhysicalMaterial({
      map: getIris(irisColor), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04,
    });
    const eyeGeo = new THREE.SphereGeometry(eyeR, 24, 16);
    {
      const ep = eyeGeo.attributes.position, euv = eyeGeo.attributes.uv;
      for (let i = 0; i < ep.count; i++) {
        const z = ep.getZ(i);
        if (z > 0) euv.setXY(i, ep.getX(i) / eyeR * 0.5 + 0.5, ep.getY(i) / eyeR * 0.5 + 0.5);
        else euv.setXY(i, 0.02, 0.02);
      }
    }
    for (const s of [1, -1]) {
      const e = new THREE.Object3D();
      e.position.set(s * 0.0122, 0.0046, 0.0082);
      const dir = V3(s, 0.1, 0.42).normalize();
      e.quaternion.setFromUnitVectors(V3(0, 0, 1), dir);
      this.headMesh.add(e);
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.castShadow = false;
      e.add(eye);
      // 眼周裸皮（眼环）
      const ringNode = new THREE.Object3D();
      ringNode.position.z = eyeR * 0.45;
      e.add(ringNode);
      const ring = new THREE.TorusGeometry(eyeR * 0.98, eyeR * 0.13, 8, 24);
      this.hardBatch.add(ringNode, ring, this.colors.key === 'red' || this.colors.key === 'white' ? C('#d9a79a') : C('#6f747c'));
      // 眼睑：上半球壳，绕 X 轴旋转合上
      const lid = new THREE.Object3D();
      e.add(lid);
      const lidGeo = new THREE.SphereGeometry(eyeR * 1.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      this.bodyBatch.add(lid, lidGeo, col.head.clone());
      this.eyes.push(e);
      this.lids.push(lid);
      this._eyeMesh = eye;
    }
    this.eyeMaterial = eyeMat;
    this.setEyelids(0);
  }

  // =================================================================== 颈部（每帧变形的管状网格）
  _buildNeck() {
    const RINGS = 18, RAD = 24;
    this.neckRings = RINGS;
    this.neckRadial = RAD;
    const count = (RINGS + 1) * (RAD + 1);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const col = new Float32Array(count * 3);
    const idx = [];
    const c = this.colors;
    for (let r = 0; r <= RINGS; r++) {
      const s = r / RINGS;
      for (let k = 0; k <= RAD; k++) {
        const i = r * (RAD + 1) + k;
        uv[i * 2] = (k / RAD) * 6;
        uv[i * 2 + 1] = s;
        const theta = (k / RAD) * Math.PI * 2;
        const dorsal = Math.max(0, Math.cos(theta)); // cos=1 → 后颈
        const cc = new THREE.Color().copy(c.neck);
        cc.lerp(c.breast, (1 - smoothstep(0.0, 0.2, s)) * (1 - dorsal));
        cc.lerp(c.back, (1 - smoothstep(0.0, 0.2, s)) * dorsal);
        cc.lerp(c.head, smoothstep(0.8, 1.0, s));
        if (c.pied && piedMask(Math.cos(theta) * 3, s * 5, Math.sin(theta) * 3, this.seed + 9, c.pied)) cc.setRGB(0.95, 0.94, 0.92);
        col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
      }
    }
    for (let r = 0; r < RINGS; r++) {
      for (let k = 0; k < RAD; k++) {
        const a = r * (RAD + 1) + k, b = a + RAD + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(V3(), 0.4);
    // 颈部羽毛的结构色：羽小枝上的薄膜干涉产生绿色与紫色金属光泽
    const tex = getTextures();
    this.neckMaterial = new THREE.MeshPhysicalMaterial({
      vertexColors: true, roughness: 0.42, metalness: 0.0,
      bumpMap: tex.bodyFeather, bumpScale: 0.5,
      iridescence: c.iridescence * (this.sex === 'male' ? 1 : 0.8),
      iridescenceIOR: 1.9,
      iridescenceThicknessRange: [420, 720],
      specularIntensity: 1, clearcoat: 0.25, clearcoatRoughness: 0.5,
      iridescenceMap: iridescenceMap(),
      sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.6, 0.65, 0.7),
    });
    this.neck = new THREE.Mesh(geo, this.neckMaterial);
    this.neck.castShadow = true;
    this.neck.receiveShadow = true;
    this.body.add(this.neck);
    this.neckBase = V3(0, 0.008, 0.042);
    this.neckBaseDir = V3(0, 0.7, 0.72).normalize();
    this.neckPuff = 0;
    this.cropInflate = 0;
    this.neckSwallow = 0;
  }

  // 根据头部当前位置重建颈部曲面（三次贝塞尔曲线 + 椭圆截面）
  _updateNeck() {
    const RINGS = this.neckRings, RAD = this.neckRadial;
    const pos = this.neck.geometry.attributes.position.array;
    const nrm = this.neck.geometry.attributes.normal.array;
    const P0 = this.neckBase;
    const P3 = _tmp.p3.set(0, 0.007, 0.007).applyQuaternion(this.head.quaternion).add(this.head.position);
    const P1 = _tmp.p1.copy(this.neckBaseDir).multiplyScalar(0.026).add(P0);
    const headQ = this.head.quaternion;
    const P2 = _tmp.p2.set(0, -0.8, -0.45).normalize().applyQuaternion(headQ).multiplyScalar(0.02).add(P3);
    const puff = this.neckPuff, crop = this.cropInflate, swallow = this.neckSwallow;
    // 第一遍：中心线与切线
    const CT = this._neckCT || (this._neckCT = new Float32Array((RINGS + 1) * 6));
    for (let r = 0; r <= RINGS; r++) {
      const s = r / RINGS;
      const it = 1 - s;
      const b0 = it * it * it, b1 = 3 * it * it * s, b2 = 3 * it * s * s, b3 = s * s * s;
      const d0 = 3 * it * it, d1 = 6 * it * s, d2 = 3 * s * s;
      const o = r * 6;
      CT[o] = b0 * P0.x + b1 * P1.x + b2 * P2.x + b3 * P3.x;
      CT[o + 1] = b0 * P0.y + b1 * P1.y + b2 * P2.y + b3 * P3.y;
      CT[o + 2] = b0 * P0.z + b1 * P1.z + b2 * P2.z + b3 * P3.z;
      _tmp.t.set(
        d0 * (P1.x - P0.x) + d1 * (P2.x - P1.x) + d2 * (P3.x - P2.x),
        d0 * (P1.y - P0.y) + d1 * (P2.y - P1.y) + d2 * (P3.y - P2.y),
        d0 * (P1.z - P0.z) + d1 * (P2.z - P1.z) + d2 * (P3.z - P2.z),
      ).normalize();
      CT[o + 3] = _tmp.t.x; CT[o + 4] = _tmp.t.y; CT[o + 5] = _tmp.t.z;
    }
    // 平行传输侧向量，再把头部的扭转量沿颈部均匀分配（转头 180° 理羽也不会翻折）
    const side = _tmp.side.set(1, 0, 0);
    const T = _tmp.t;
    for (let r = 0; r <= RINGS; r++) {
      T.set(CT[r * 6 + 3], CT[r * 6 + 4], CT[r * 6 + 5]);
      side.addScaledVector(T, -side.dot(T)).normalize();
    }
    const headSide = _tmp.st.set(1, 0, 0).applyQuaternion(headQ);
    headSide.addScaledVector(T, -headSide.dot(T)).normalize();
    const twist = Math.atan2(_tmp.up.crossVectors(side, headSide).dot(T), side.dot(headSide));
    side.set(1, 0, 0);
    for (let r = 0; r <= RINGS; r++) {
      const s = r / RINGS;
      const o = r * 6;
      const cx = CT[o], cy = CT[o + 1], cz = CT[o + 2];
      T.set(CT[o + 3], CT[o + 4], CT[o + 5]);
      side.addScaledVector(T, -side.dot(T)).normalize();
      const sd = _tmp.sb.copy(side).applyAxisAngle(T, twist * smoothstep(0, 1, s));
      const up = _tmp.up.crossVectors(T, sd).normalize(); // 指向后颈（背侧）
      // 截面半径：基部宽（与胸部融合），上部细
      const taper = 1 - Math.pow(1 - s, 2.4);
      let rx = lerp(0.026, 0.0155, taper);
      let ry = lerp(0.029, 0.0165, taper);
      const puffK = 1 + 0.28 * puff * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.15)), 0.6);
      rx *= puffK; ry *= puffK;
      // 嗉囊位于颈基部前侧：求偶时鼓胀；吞咽时食团沿食道下移
      const cropBump = crop * 0.014 * Math.exp(-((s - 0.32) ** 2) / 0.03);
      const swallowBump = swallow > 0 ? 0.003 * Math.exp(-((s - (1 - swallow)) ** 2) / 0.004) : 0;
      for (let k = 0; k <= RAD; k++) {
        const theta = (k / RAD) * Math.PI * 2;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const ventral = Math.max(0, -ct);
        const extra = (cropBump + swallowBump) * ventral * ventral;
        const ox = st * rx, oy = ct * (ry + extra);
        const i = (r * (RAD + 1) + k) * 3;
        pos[i] = cx + sd.x * ox + up.x * oy;
        pos[i + 1] = cy + sd.y * ox + up.y * oy;
        pos[i + 2] = cz + sd.z * ox + up.z * oy;
        const nx = sd.x * st / rx + up.x * ct / ry;
        const ny = sd.y * st / rx + up.y * ct / ry;
        const nz = sd.z * st / rx + up.z * ct / ry;
        const l = 1 / Math.hypot(nx, ny, nz);
        nrm[i] = nx * l; nrm[i + 1] = ny * l; nrm[i + 2] = nz * l;
      }
    }
    this.neck.geometry.attributes.position.needsUpdate = true;
    this.neck.geometry.attributes.normal.needsUpdate = true;
  }

  // =================================================================== 翅膀
  _buildWing(side) {
    const col = this.colors, rng = this.rng;
    const mount = new THREE.Group();
    mount.position.set(side * 0.022, 0.026, 0.044);
    mount.scale.x = side; // 右翼通过镜像获得
    this.body.add(mount);
    const shoulder = new THREE.Group(); shoulder.rotation.order = 'ZYX';
    const elbow = new THREE.Group(); elbow.rotation.order = 'ZYX';
    const wrist = new THREE.Group(); wrist.rotation.order = 'ZYX';
    const HUM = 0.05, ULNA = 0.06, HAND = 0.068;
    mount.add(shoulder);
    shoulder.add(elbow); elbow.position.x = HUM;
    elbow.add(wrist); wrist.position.x = ULNA;
    const tip = new THREE.Object3D(); tip.position.x = HAND; wrist.add(tip);

    const feathers = [];
    const piedFeather = () => col.pied > 0 && rng() < col.pied * 0.8;
    const white = C('#f3f1ec');
    const addFeather = (bone, type, i, n, base, L, W, opts, colorFn, extYaw, foldYaw, pitch = 0, layer = 0, rollOverride = null) => {
      const node = new THREE.Object3D();
      node.rotation.order = 'YXZ';
      node.position.copy(base);
      bone.add(node);
      const pf = piedFeather();
      const geo = featherGeometry(L, W, { ...opts, colorFn: pf ? () => white : colorFn });
      this.featherBatch.add(node, geo);
      const foldRoll = rollOverride ?? { primary: -0.75, secondary: -0.8, gcovert: -0.8, covert: -0.8, pcovert: -0.8, alula: -0.9, scapular: -0.18 }[type];
      const foldPitch = { primary: 0.1, secondary: 0.06, gcovert: 0.1, covert: 0.12, pcovert: 0.08, alula: 0.1, scapular: 0.12 }[type];
      const f = { node, type, i, n, extYaw, foldYaw, foldPitch, foldRoll, pitch, bone, layer, baseY: base.y };
      feathers.push(f);
      return f;
    };

    // 翼骨外的肌肉与翼膜（前缘）：用椭球表示
    const fleshNodes = [];
    const flesh = (bone, len, r, z = 0.004) => {
      const n = new THREE.Object3D();
      n.position.set(len / 2, 0.001, z);
      bone.add(n);
      fleshNodes.push(n);
      this.bodyBatch.add(n, ellipsoid(len / 2 + r * 0.4, r * 0.5, r, 14, 8), col.back.clone().lerp(col.shield, 0.3).multiplyScalar(0.92));
    };
    flesh(shoulder, HUM, 0.012, 0.0);
    flesh(elbow, ULNA, 0.0085, 0.004);
    flesh(wrist, HAND, 0.0055, 0.003);

    const flight = col.flight, shield = col.shield, bar = col.bar;
    const checkerSpot = () => col.checker > 0 && rng() < col.checker;

    // ---- 初级飞羽 P1–P10（附着于掌骨/指骨）----
    const pLen = [0.108, 0.114, 0.121, 0.129, 0.138, 0.148, 0.158, 0.166, 0.17, 0.158];
    for (let i = 0; i < 10; i++) {
      const t = i / 9;
      const x = HAND * Math.min(1, Math.pow(t, 0.6));
      const L = pLen[i] * 1.04;
      const W = lerp(0.031, 0.024, t) * (i === 9 ? 0.85 : 1);
      const dark = 0.25 + 0.55 * t;
      addFeather(wrist, 'primary', i, 10, V3(x, -0.0012 - i * 0.00055, -0.002), L, W,
        { camber: 0.06, bend: 0.05 + 0.02 * t, curve: -0.04 * t },
        (u, v) => {
          const c = _c.copy(shield).lerp(flight, smoothstep(0.05, 0.45, v) * (0.55 + dark * 0.45));
          return c.lerp(_c2.copy(flight).multiplyScalar(0.7), smoothstep(0.75, 1, v) * 0.6);
        },
        -lerp(0.12, 0.98, Math.pow(t, 1.2)), lerp(0.1, 0.19, t), 0, i, lerp(-0.6, -0.3, t));
    }
    // ---- 次级飞羽 S1–S11（附着于尺骨），靠近肘部的为三级飞羽 ----
    for (let i = 0; i < 11; i++) {
      const t = i / 10; // 0=S1（靠腕）
      const x = lerp(ULNA - 0.002, 0.004, t);
      const L = lerp(0.094, 0.074, Math.pow(t, 1.4));
      const isTertial = i >= 8;
      addFeather(elbow, 'secondary', i, 11, V3(x, 0.0006 + i * 0.0003, -0.0025), L, 0.027,
        { camber: 0.05, bend: 0.03 },
        (u, v) => {
          const c = _c.copy(shield).lerp(flight, smoothstep(0.35, 0.95, v) * (isTertial ? 0.25 : 0.75));
          // 后翼斑：位于次级/三级飞羽中段可见区域
          const band = smoothstep(0.42, 0.5, v) * (1 - smoothstep(0.72, 0.8, v));
          return c.lerp(bar, band * (isTertial ? 1 : 0.85));
        },
        lerp(0.0, 0.18, t), lerp(0.02, 0.18, t * t), 0, 20 + i, lerp(-1.05, -0.15, Math.pow(t, 0.8)));
    }
    // ---- 大覆羽（覆盖次级飞羽基部，末端为前翼斑）----
    for (let i = 0; i < 11; i++) {
      const t = i / 10;
      const x = lerp(ULNA - 0.003, 0.006, t);
      const spot = checkerSpot();
      addFeather(elbow, 'gcovert', i, 11, V3(x, 0.0042, 0.0006), lerp(0.046, 0.04, t), 0.024,
        { camber: 0.06, bend: 0.03 },
        (u, v) => {
          const c = _c.copy(shield);
          if (spot) c.lerp(bar, smoothstep(0.5, 0.8, v) * smoothstep(0.1, 0.5, 1 - Math.abs(u - 0.5) * 2) * 0.85);
          return c.lerp(bar, smoothstep(0.7, 0.78, v) * (1 - smoothstep(0.96, 1, v) * 0.3));
        },
        lerp(0.02, 0.2, t), lerp(0.0, 0.16, t * t), 0, 40 + i, lerp(-1.0, -0.2, Math.pow(t, 0.8)));
    }
    // ---- 中覆羽、小覆羽（翼盾）----
    for (let row = 0; row < 2; row++) {
      const n = row === 0 ? 10 : 8;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = lerp(ULNA - 0.002, 0.004, t);
        const spot = checkerSpot();
        addFeather(elbow, 'covert', i, n, V3(x, 0.0062 + row * 0.0015, 0.0046 + row * 0.0035),
          row === 0 ? 0.03 : 0.022, 0.02,
          { camber: 0.08, bend: 0.02 },
          (u, v) => {
            const c = _c.copy(shield);
            if (spot) c.lerp(bar, smoothstep(0.45, 0.85, v) * 0.8);
            return c;
          },
          lerp(0.05, 0.25, t), lerp(0.0, 0.12, t), 0, 60 + row * 10 + i, lerp(-0.95, -0.3, t));
      }
    }
    // ---- 初级覆羽 ----
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      addFeather(wrist, 'pcovert', i, 8, V3(HAND * Math.pow(t, 0.85) * 0.92 + 0.003, 0.0032, 0.0012), lerp(0.034, 0.03, t), 0.02,
        { camber: 0.06, bend: 0.03 },
        () => _c.copy(shield).lerp(flight, 0.35 + 0.3 * t),
        -lerp(0.12, 0.85, t), lerp(0.03, 0.06, t), 0, 80 + i);
    }
    // ---- 小翼羽（位于腕部前缘，低速飞行时防止失速）----
    for (let i = 0; i < 2; i++) {
      addFeather(wrist, 'alula', i, 2, V3(0.004 + i * 0.002, 0.004, 0.006), 0.026 - i * 0.004, 0.012,
        { camber: 0.05, bend: 0.02 },
        () => _c.copy(flight).lerp(shield, 0.3),
        -1.9, -0.15, 0, 90 + i);
    }
    // ---- 肩羽（覆盖翼根与背部之间）----
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      addFeather(shoulder, 'scapular', i, 7, V3(lerp(0.006, HUM - 0.002, t), 0.009 + 0.0008 * i, 0.002), lerp(0.05, 0.066, t), 0.034,
        { camber: 0.08, bend: 0.02 },
        () => _c.copy(col.back).lerp(shield, 0.3),
        lerp(0.45, 0.1, t), lerp(0.16, 0.3, t), 0, 95 + i, -0.1);
    }
    // ---- 预计算收拢姿态 ----
    // 收拢时（翼根坐标系，左翼）：肱骨沿背部向后，前臂由肘部向前下方折到胸侧（腕部为“翼角”），
    // 手部再沿体侧向后；飞羽全部指向后方，次级飞羽由体侧（腕）过渡到背上（三级飞羽）。
    const basis = (dir, upHint) => {
      const x = dir.clone().normalize();
      const y = upHint.clone().addScaledVector(x, -upHint.dot(x)).normalize();
      const z = V3().crossVectors(x, y);
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    };
    const qH = basis(V3(0.006, -0.004, -0.046), V3(0, 1, 0));
    const qE = basis(V3(0.17, -0.4, 0.9), V3(0.8, 0.6, 0));
    const qW = basis(V3(0.1, 0.3, -1), V3(1, 0.3, 0));
    const foldQ = {
      shoulder: qH.clone(),
      elbow: qH.clone().invert().multiply(qE),
      wrist: qE.clone().invert().multiply(qW),
    };
    for (const ft of feathers) {
      const qb = ft.bone === wrist ? qW : ft.bone === elbow ? qE : qH;
      _e.set(ft.foldPitch, ft.foldYaw, ft.foldRoll, 'YXZ');
      ft.foldLocal = qb.clone().invert().multiply(new THREE.Quaternion().setFromEuler(_e));
    }

    return {
      foldQ, fleshNodes,
      side, mount, shoulder, elbow, wrist, tip, feathers,
      lengths: { HUM, ULNA, HAND },
      state: { fold: 1, flap: 0, sweep: 0, twist: 0, spread: 1, droop: 0, flex: 0, raise: 0 },
    };
  }

  // =================================================================== 收拢翅膀的外壳
  // 收拢时的翅膀用一张贴合体侧的曲面表现（覆羽鳞状排列、两道黑色翼斑、深色飞羽），
  // 翅膀张开时切换为逐片羽毛，从而兼顾近景精度与整洁的外形。
  _buildWingShells() {
    const tex = this._paintWingTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex, alphaTest: 0.5, roughness: 0.85,
      bumpMap: getTextures().bodyFeather, bumpScale: 0.8,
    });
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5 });
    this.wingShellMaterial = mat;
    this.shells = [];
    const NU = 34, NV = 14;
    const pt = (side, l, sAcross, out) => {
      const t = lerp(0.8, -0.93, l);
      const phiTop = lerp(0.62, 0.2, l);
      const phiBot = lerp(1.95, 1.2, smoothstep(0.05, 1, l));
      const phi = lerp(phiTop, phiBot, sAcross);
      const r = Math.sqrt(Math.max(0, 1 - t * t));
      return torsoShape(side * r * Math.sin(phi), r * Math.cos(phi), t, out);
    };
    for (const side of [1, -1]) {
      const pos = [], uv = [], idx = [];
      const a = V3(), b = V3(), c = V3(), n = V3(), ctr = V3();
      for (let i = 0; i <= NU; i++) {
        const l = i / NU;
        for (let j = 0; j <= NV; j++) {
          const sa = j / NV;
          pt(side, l, sa, a);
          // 外法线：近似为从躯干中轴指向表面点的方向
          ctr.set(0, 0.004, a.z);
          n.subVectors(a, ctr).normalize();
          // 外鼓的厚度：中间厚，边缘贴合躯干
          const thick = 0.0012 + 0.0055 * Math.pow(Math.sin(Math.PI * sa), 0.6) * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, l * 1.3)));
          a.addScaledVector(n, thick);
          pos.push(a.x, a.y, a.z);
          uv.push(l, sa);
        }
      }
      for (let i = 0; i < NU; i++) {
        for (let j = 0; j < NV; j++) {
          const p0 = i * (NV + 1) + j, p1 = p0 + NV + 1;
          if (side > 0) idx.push(p0, p0 + 1, p1, p1, p0 + 1, p1 + 1);
          else idx.push(p0, p1, p0 + 1, p1, p1 + 1, p0 + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depth;
      this.body.add(mesh);
      this.shells.push(mesh);
    }
  }

  _paintWingTexture() {
    const W = 512, H = 256;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const col = this.colors, rng = this.rng;
    const ch = (v, k) => Math.round(Math.min(1, Math.pow(v, 1 / 2.2) * k) * 255);
    const css = (c, k = 1) => `rgb(${ch(c.r, k)},${ch(c.g, k)},${ch(c.b, k)})`;
    // 纹理坐标：x = 沿身体由前到后；canvas y 向下，对应 uv.v（背部=0 → 体侧=1）翻转
    const Y = (sAcross) => (1 - sAcross) * H;
    // 外轮廓：前端圆润的“翼角”，后端收尖
    const outline = new Path2D();
    outline.moveTo(W * 0.06, Y(0.02));
    outline.lineTo(W * 0.82, Y(0.02));
    outline.quadraticCurveTo(W * 1.0, Y(0.1), W * 0.995, Y(0.4));
    outline.quadraticCurveTo(W * 0.96, Y(0.9), W * 0.7, Y(0.985));
    outline.lineTo(W * 0.12, Y(0.985));
    outline.quadraticCurveTo(W * 0.0, Y(0.9), W * 0.005, Y(0.5));
    outline.quadraticCurveTo(W * 0.0, Y(0.05), W * 0.06, Y(0.02));
    g.clearRect(0, 0, W, H);
    g.save();
    g.clip(outline);
    g.fillStyle = css(col.shield);
    g.fillRect(0, 0, W, H);
    // 深色飞羽：体侧下缘后部（初级飞羽）
    const pg = g.createLinearGradient(W * 0.45, 0, W, 0);
    pg.addColorStop(0, css(col.shield));
    pg.addColorStop(0.35, css(col.flight));
    pg.addColorStop(1, css(col.flight, 0.85));
    g.fillStyle = pg;
    g.beginPath();
    g.moveTo(W * 0.42, Y(1));
    g.quadraticCurveTo(W * 0.62, Y(0.55), W * 1.0, Y(0.42));
    g.lineTo(W, Y(1));
    g.closePath();
    g.fill();
    // 覆羽：鳞状排列的羽缘
    const checker = col.checker;
    const fw = 30, fh = 26;
    for (let y = 0; y < H * 0.78; y += fh * 0.62) {
      const row = Math.round(y / (fh * 0.62));
      for (let x = (row % 2) * fw * 0.5; x < W * 0.5; x += fw) {
        const dark = checker > 0 && rng() < checker;
        g.fillStyle = dark ? css(col.bar, 1.3) : css(col.shield, 0.94 + rng() * 0.1);
        g.beginPath();
        g.ellipse(x, y, fw * 0.55, fh * 0.6, 0, 0, Math.PI);
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.12)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.ellipse(x, y, fw * 0.55, fh * 0.6, 0, 0.15, Math.PI - 0.15);
        g.stroke();
      }
    }
    // 次级飞羽/三级飞羽：沿身体方向的长羽片
    for (let k = 0; k < 9; k++) {
      const yy = H * (0.04 + k * 0.085);
      g.fillStyle = css(col.shield, 0.95 + rng() * 0.08);
      g.beginPath();
      g.ellipse(W * 0.66, yy, W * 0.2, H * 0.055, 0.04, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.13)';
      g.stroke();
    }
    // 两道黑色翼斑（前：大覆羽末端；后：次级飞羽中段），略向后下方倾斜
    const bar = (cx, w) => {
      g.fillStyle = css(col.bar);
      g.beginPath();
      g.moveTo(W * (cx - 0.02), Y(0.0));
      g.lineTo(W * (cx - 0.02 + w), Y(0.0));
      g.lineTo(W * (cx - 0.07 + w), Y(0.78));
      g.lineTo(W * (cx - 0.075), Y(0.78));
      g.closePath();
      g.fill();
    };
    if (this.colors.key !== 'white' && this.colors.key !== 'dark') {
      bar(0.52, 0.034);
      bar(0.645, 0.042);
    }
    // 后端：深色初级飞羽露出部分
    g.fillStyle = css(col.flight);
    g.globalAlpha = 0.85;
    g.beginPath();
    g.moveTo(W * 0.84, Y(0.0));
    g.quadraticCurveTo(W * 0.95, Y(0.3), W * 0.88, Y(1));
    g.lineTo(W, Y(1));
    g.lineTo(W, 0);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    // 花斑：随机白色斑块
    if (col.pied > 0) {
      g.fillStyle = '#f3f1ec';
      for (let k = 0; k < 7 * col.pied * 3; k++) {
        g.beginPath();
        g.ellipse(rng() * W, rng() * H, 20 + rng() * 50, 14 + rng() * 30, rng() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 细腻的羽枝纹理与整体明暗
    g.globalAlpha = 0.08;
    for (let k = 0; k < 900; k++) {
      g.strokeStyle = rng() < 0.5 ? '#000' : '#fff';
      const x = rng() * W, y = rng() * H;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 10, y + (rng() - 0.5) * 6);
      g.stroke();
    }
    g.globalAlpha = 1;
    const shade = g.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(255,255,255,0.06)');
    shade.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = shade;
    g.fillRect(0, 0, W, H);
    g.restore();
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // fold: 1=收拢 0=展开；flap: 拍动角（弧度，向上为正）；sweep: 后掠修正；twist: 攻角；
  // spread: 初级飞羽张开程度；flex: 上扑时的肘/腕弯曲；raise: 翅膀向上翘起（晒太阳/伸展）
  setWing(index, params) {
    const w = this.wings[index];
    const s = Object.assign(w.state, params);
    const f = clamp(s.fold, 0, 1);
    const flex = clamp(s.flex, 0, 1);
    const fe = Math.max(f, flex * 0.5);
    const ext = 1 - f;
    // 展开姿态（欧拉角），再与收拢姿态（四元数）球面插值
    _e.set(s.twist, -0.12 + s.sweep, 0, 'ZYX');
    _wq.h.setFromEuler(_e).slerp(w.foldQ.shoulder, fe);
    _e.set(0, 0, s.raise + s.flap - s.droop, 'ZYX');
    w.shoulder.quaternion.copy(_wq.h).premultiply(_wq.ext.setFromEuler(_e));
    _e.set(0, 0.22 + s.sweep * 0.4, s.flap * 0.18 * ext, 'ZYX');
    w.elbow.quaternion.setFromEuler(_e).slerp(w.foldQ.elbow, fe);
    _e.set(0, 0.1 - s.sweep * 0.3, s.flap * 0.22 * ext, 'ZYX');
    w.wrist.quaternion.setFromEuler(_e).slerp(w.foldQ.wrist, fe);
    const spread = clamp(s.spread, 0, 1.2);
    // 几乎完全收拢时显示外壳，隐藏被覆盖的覆羽与次级飞羽
    const shellOn = this.shellsEnabled !== false && f > 0.9 && flex < 0.2 && s.raise < 0.15;
    if (this.shells) this.shells[index].visible = shellOn;
    for (const n of w.fleshNodes) n.visible = !shellOn;
    for (const ft of w.feathers) {
      ft.node.visible = !(shellOn && ft.type !== 'primary');
      let yaw = ft.extYaw;
      if (ft.type === 'primary' || ft.type === 'pcovert') yaw *= spread;
      _e.set(ft.pitch, yaw, 0, 'YXZ');
      ft.node.quaternion.setFromEuler(_e);
      if (fe > 0.001) ft.node.quaternion.slerp(ft.foldLocal, fe);
    }
  }

  // =================================================================== 尾部
  _buildTail() {
    const col = this.colors, rng = this.rng;
    this.tailPivot = new THREE.Group();
    this.tailPivot.rotation.order = 'YXZ';
    this.tailPivot.position.set(0, 0.016, -0.096);
    this.body.add(this.tailPivot);
    this.tailFeathers = [];
    const white = C('#f3f1ec');
    for (let i = 0; i < 12; i++) {
      const c = (i - 5.5) / 5.5; // -1..1
      const node = new THREE.Object3D();
      node.rotation.order = 'YXZ';
      node.position.set(c * 0.012, -Math.abs(c) * 0.004 - 0.0006 * Math.abs(i - 5.5), 0.004);
      this.tailPivot.add(node);
      const outer = Math.abs(c) > 0.9;
      const pied = col.pied > 0 && rng() < col.pied * 0.6;
      const geo = featherGeometry(0.118 + 0.006 * (1 - Math.abs(c)), 0.034, {
        camber: 0.04, bend: 0.025, curve: 0,
        colorFn: pied ? () => white : (u, v) => {
          const cc = _c.copy(col.tail);
          // 外侧尾羽的外翈呈白色（原鸽特征）
          if (outer && ((c > 0 && u > 0.55) || (c < 0 && u < 0.45))) cc.lerp(white, 0.75 * (1 - smoothstep(0.7, 0.8, v)));
          // 次端黑色尾带
          cc.lerp(col.tailBand, smoothstep(0.7, 0.76, v) * (1 - smoothstep(0.93, 0.98, v) * 0.35));
          return cc;
        },
      });
      this.featherBatch.add(node, geo);
      this.tailFeathers.push({ node, c });
    }
    // 尾上覆羽 / 尾下覆羽
    for (let i = 0; i < 5; i++) {
      const c = (i - 2) / 2;
      const node = new THREE.Object3D();
      node.rotation.order = 'YXZ';
      node.position.set(c * 0.01, 0.006, 0.024);
      this.tailPivot.add(node);
      this.featherBatch.add(node, featherGeometry(0.066, 0.03, {
        camber: 0.1, bend: 0.03, colorFn: (u, v) => _c.copy(col.back).lerp(col.tail, smoothstep(0.2, 1, v)),
      }));
      this.tailFeathers.push({ node, c: c * 0.6, covert: 1 });
    }
    for (let i = 0; i < 4; i++) {
      const c = (i - 1.5) / 1.5;
      const node = new THREE.Object3D();
      node.rotation.order = 'YXZ';
      node.position.set(c * 0.008, -0.012, 0.03);
      this.tailPivot.add(node);
      this.featherBatch.add(node, featherGeometry(0.064, 0.03, {
        camber: -0.1, bend: 0.0, colorFn: () => _c.copy(col.tail).lerp(col.belly, 0.3),
      }));
      this.tailFeathers.push({ node, c: c * 0.5, covert: -1 });
    }
    this.tailState = { spread: 0, pitch: 0, yaw: 0, fan: 0 };
  }

  setTail(params) {
    const s = Object.assign(this.tailState, params);
    const spreadAngle = lerp(0.1, 0.95, clamp(s.spread, 0, 1));
    this.tailPivot.rotation.set(s.pitch, s.yaw, 0);
    for (const f of this.tailFeathers) {
      const yaw = f.c * spreadAngle * (f.covert ? 0.55 : 1);
      // 张开时外侧尾羽稍微下垂并扭转，形成扇面
      const roll = -f.c * 0.12 * s.spread;
      const pitch = f.covert === 1 ? 0.12 : f.covert === -1 ? -0.18 : Math.abs(f.c) * 0.04 * s.spread;
      f.node.rotation.set(pitch, yaw, roll);
    }
  }

  // =================================================================== 腿与脚
  _buildLeg(side) {
    const col = this.colors;
    const hip = new THREE.Group();
    hip.rotation.order = 'ZXY';
    hip.position.set(side * 0.02, -0.024, -0.008);
    this.body.add(hip);
    // “羽裤”：胫部被覆的体羽
    const thigh = new THREE.Object3D();
    thigh.position.set(0, 0.002, 0.004);
    hip.add(thigh);
    this.bodyBatch.add(thigh, ellipsoid(0.013, 0.019, 0.018, 12, 9), col.belly.clone());
    const TIB = 0.04, TAR = 0.026;
    const ankle = new THREE.Group();
    ankle.position.y = -TIB;
    hip.add(ankle);
    // 胫部：被体羽覆盖（“羽裤”），一直延伸到踝关节上方
    const shin = new THREE.Object3D();
    shin.position.y = -TIB * 0.55;
    hip.add(shin);
    this.bodyBatch.add(shin, ellipsoid(0.0085, TIB * 0.42, 0.0095, 10, 8), col.belly.clone().lerp(col.breast, 0.25));
    // 跗跖：红色，覆盖盾状鳞
    const tar = new THREE.Object3D();
    tar.rotation.x = Math.PI / 2; // tube 沿 +Z → 指向 -Y
    ankle.add(tar);
    this.skinBatch.add(tar, taperedTube(TAR, 0.003, 0.0026, 8, 3), C('#ffffff'));
    const ankleBall = new THREE.Object3D();
    ankle.add(ankleBall);
    this.skinBatch.add(ankleBall, ellipsoid(0.0036, 0.0036, 0.0036, 8, 6), C('#e6a19c'));
    const foot = new THREE.Group();
    foot.position.y = -TAR;
    ankle.add(foot);
    const footBall = new THREE.Object3D();
    foot.add(footBall);
    this.skinBatch.add(footBall, ellipsoid(0.0034, 0.0028, 0.0038, 8, 6), C('#f2c0bb'));
    // 四趾：三前一后（不等趾足），每趾两节，末端为角质爪
    const toes = [];
    const toeDefs = [
      { yaw: 0.0, len: 0.034 },                 // 中趾（第三趾）
      { yaw: side * 0.52, len: 0.027 },         // 内趾（第二趾，靠身体中线一侧）——注意 +X 为左
      { yaw: -side * 0.55, len: 0.03 },         // 外趾（第四趾）
      { yaw: Math.PI, len: 0.019, hallux: true } // 后趾（第一趾）
    ];
    // 对于左脚(side=+1)，内侧为 -X，因此内趾 yaw 取负方向。
    toeDefs[1].yaw = -side * 0.5;
    toeDefs[2].yaw = side * 0.55;
    for (const d of toeDefs) {
      const base = new THREE.Group();
      base.rotation.order = 'YXZ';
      base.rotation.y = d.yaw;
      foot.add(base);
      const l1 = d.len * 0.55, l2 = d.len * 0.45;
      const seg1 = new THREE.Object3D();
      base.add(seg1);
      this.skinBatch.add(seg1, taperedTube(l1, 0.0024, 0.002, 6, 2), C('#f2b3ad'));
      const j = new THREE.Group();
      j.position.z = l1;
      base.add(j);
      const seg2 = new THREE.Object3D();
      j.add(seg2);
      this.skinBatch.add(seg2, taperedTube(l2, 0.002, 0.0016, 6, 2), C('#f2b3ad'));
      const claw = new THREE.Object3D();
      claw.position.set(0, 0.0003, l2 - 0.0005);
      j.add(claw);
      this.hardBatch.add(claw, taperedTube(0.0062, 0.0013, 0.0002, 6, 3, { droop: 0.35 }), C('#2b2724'));
      toes.push({ base, j, def: d });
    }
    return { side, hip, ankle, foot, toes, TIB, TAR, curl: 0 };
  }

  // 设置脚趾弯曲（0=平放，1=抓握/收起）
  setToeCurl(index, curl) {
    const leg = this.legs[index];
    leg.curl = curl;
    for (const t of leg.toes) {
      t.base.rotation.x = t.def.hallux ? -0.05 + curl * 0.5 : 0.03 + curl * 0.55;
      t.j.rotation.x = curl * 1.25;
    }
  }

  // 直接设置关节角（飞行收腿等）
  setLegAngles(index, hipPitch, anklePitch, roll = 0) {
    const leg = this.legs[index];
    leg.hip.rotation.set(hipPitch, 0, roll);
    leg.ankle.rotation.set(anklePitch, 0, 0);
  }

  // 两骨 IK：让脚落在 targetWorld 上；yawWorld 为脚掌朝向（世界坐标偏航角）
  solveLegIK(index, targetWorld, yawWorld) {
    const leg = this.legs[index];
    this.body.updateWorldMatrix(true, false);
    // 目标点转换到躯干局部空间
    const T = _v1.copy(targetWorld);
    this.body.worldToLocal(T);
    const H = leg.hip.position;
    const dx = T.x - H.x, dy = T.y - H.y, dz = T.z - H.z;
    const l1 = leg.TIB, l2 = leg.TAR;
    const len = Math.hypot(dx, dy, dz);
    const roll = Math.asin(clamp(dx / Math.max(len, 1e-5), -0.6, 0.6));
    const D = clamp(Math.sqrt(Math.max(len * len - dx * dx, 1e-8)), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
    const alpha = Math.atan2(dz, -dy);
    const beta = Math.acos(clamp((l1 * l1 + D * D - l2 * l2) / (2 * l1 * D), -1, 1));
    const gamma = Math.acos(clamp((l1 * l1 + l2 * l2 - D * D) / (2 * l1 * l2), -1, 1));
    // 鸟类的“膝”（实为踝关节/跗间关节）向后弯
    leg.hip.rotation.set(-alpha + beta, 0, roll);
    leg.ankle.rotation.set(-(Math.PI - gamma), 0, 0);
    // 脚掌保持水平，朝向指定的偏航角
    leg.hip.updateWorldMatrix(true, true);
    leg.ankle.getWorldQuaternion(_q1).invert();
    this.root.getWorldQuaternion(_q2);
    _q2.premultiply(_qTmp.setFromAxisAngle(_up, yawWorld - this._rootYaw()));
    leg.foot.quaternion.copy(_q1.multiply(_q2));
    return len <= l1 + l2 + 0.004;
  }

  _rootYaw() {
    return this.root.rotation.y;
  }

  // 脚相对水平面取向（不使用 IK 时也让脚掌正对地面）
  levelFoot(index, extraPitch = 0) {
    const leg = this.legs[index];
    leg.hip.updateWorldMatrix(true, true);
    leg.ankle.getWorldQuaternion(_q1).invert();
    this.root.getWorldQuaternion(_q2);
    _q2.multiply(_qTmp.setFromAxisAngle(_right, extraPitch));
    leg.foot.quaternion.copy(_q1.multiply(_q2));
  }

  // =================================================================== 其它
  setEyelids(v, index = -1) {
    // v: 0=睁开, 1=闭合
    for (let i = 0; i < this.lids.length; i++) {
      if (index >= 0 && i !== index) continue;
      this.lids[i].rotation.x = lerp(-1.75, 1.45, clamp(v, 0, 1));
    }
  }

  setBeak(open) {
    this.lowerJaw.rotation.x = clamp(open, 0, 1) * 0.45;
  }

  setFluff(f, breath = 0) {
    // 蓬松：竖起体羽保温（睡眠、寒冷）
    const k = 1 + 0.16 * f;
    this.torsoNode.scale.set(k * (1 + breath * 0.7), k * (1 + breath), k);
    this.chestNode.scale.setScalar(1 + 0.14 * f + breath * 0.6);
    if (this.shells) for (const sh of this.shells) sh.scale.copy(this.torsoNode.scale);
  }

  // 每帧最后调用：更新矩阵并重建合批网格与颈部
  finalize() {
    this.root.updateMatrixWorld(true);
    this._updateNeck();
    this._invBody.copy(this.body.matrixWorld).invert();
    this.bodyBatch.update(this._invBody);
    this.featherBatch.update(this._invBody);
    this.skinBatch.update(this._invBody);
    this.hardBatch.update(this._invBody);
  }

  setShadows(on) {
    for (const m of [this.bodyBatch.mesh, this.featherBatch.mesh, this.skinBatch.mesh, this.hardBatch.mesh, this.neck]) m.castShadow = on;
  }

  dispose() {
    this.bodyBatch.dispose();
    this.featherBatch.dispose();
    this.skinBatch.dispose();
    this.hardBatch.dispose();
    this.neck.geometry.dispose();
    this.neckMaterial.dispose();
  }
}

const _c2 = new THREE.Color();
const _qTmp = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);
const _e = new THREE.Euler();
const _wq = { h: new THREE.Quaternion(), e: new THREE.Quaternion(), w: new THREE.Quaternion(), ext: new THREE.Quaternion(), fold: new THREE.Quaternion(), local: new THREE.Quaternion() };
const _tmp = { p1: V3(), p2: V3(), p3: V3(), sb: V3(), st: V3(), t: V3(), side: V3(), up: V3() };
