import * as THREE from 'three';

// 常用姿态（根空间：原点在两脚之间的地面，+Z 为前方）
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

export const POSES = {
  stand: {
    bodyHeight: 0.1, bodyPitch: -0.38, bodyRoll: 0, bodyForward: 0,
    head: V3(0, 0.18, 0.074), headPitch: 0.15, headYaw: 0, headRoll: 0,
    tailPitch: 0.22, tailSpread: 0.05, fluff: 0, neckPuff: 0, crop: 0, lid: 0, beak: 0,
    foldL: 1, foldR: 1, raiseL: 0, raiseR: 0, droop: 0, toeCurl: 0,
  },
  walk: {
    bodyHeight: 0.1, bodyPitch: -0.3, head: V3(0, 0.176, 0.084), headPitch: 0.18,
    tailPitch: 0.18, fluff: -0.1,
  },
  forage: {
    bodyHeight: 0.095, bodyPitch: -0.12, head: V3(0, 0.13, 0.11), headPitch: 0.75,
    tailPitch: 0.1, fluff: -0.05,
  },
  alert: {
    bodyHeight: 0.108, bodyPitch: -0.55, head: V3(0, 0.205, 0.068), headPitch: 0.02,
    tailPitch: 0.25, fluff: -0.35, neckPuff: 0,
  },
  sit: {
    bodyHeight: 0.064, bodyPitch: -0.16, head: V3(0, 0.148, 0.052), headPitch: 0.25,
    tailPitch: 0.12, fluff: 0.6,
  },
  sleep: {
    bodyHeight: 0.066, bodyPitch: -0.12, head: V3(0, 0.138, 0.034), headPitch: 0.55,
    tailPitch: 0.1, fluff: 1, lid: 1,
  },
  oneLeg: {
    bodyHeight: 0.092, bodyPitch: -0.22, head: V3(0, 0.15, 0.04), headPitch: 0.45,
    tailPitch: 0.15, fluff: 0.85, lid: 0.7,
  },
  incubate: {
    bodyHeight: 0.07, bodyPitch: -0.1, head: V3(0, 0.15, 0.055), headPitch: 0.25,
    tailPitch: 0.06, fluff: 0.45,
  },
  flightHead: { head: V3(0, 0.125, 0.105), headPitch: -0.05 },
};

// 理羽的各个部位：头部在根空间中的位置与朝向，以及翅膀配合动作
export const PREEN_SPOTS = [
  { name: '左翼覆羽', head: V3(0.034, 0.128, 0.0), yaw: 2.1, pitch: 0.75, roll: 0.25, raiseL: 0.12, foldL: 0.92 },
  { name: '右翼覆羽', head: V3(-0.034, 0.128, 0.0), yaw: -2.1, pitch: 0.75, roll: -0.25, raiseR: 0.12, foldR: 0.92 },
  { name: '胸羽', head: V3(0, 0.126, 0.072), yaw: 0, pitch: 1.35, roll: 0 },
  { name: '左侧翼下', head: V3(0.04, 0.115, 0.02), yaw: 1.7, pitch: 0.35, roll: 0.7, raiseL: 0.55, foldL: 0.55 },
  { name: '右侧翼下', head: V3(-0.04, 0.115, 0.02), yaw: -1.7, pitch: 0.35, roll: -0.7, raiseR: 0.55, foldR: 0.55 },
  { name: '背部/尾脂腺', head: V3(0.022, 0.15, -0.035), yaw: 2.6, pitch: 0.95, roll: 0.3 },
  { name: '飞羽', head: V3(0.04, 0.13, -0.05), yaw: 2.5, pitch: 0.55, roll: 0.15, foldL: 0.75, raiseL: 0.2 },
  { name: '飞羽', head: V3(-0.04, 0.13, -0.05), yaw: -2.5, pitch: 0.55, roll: -0.15, foldR: 0.75, raiseR: 0.2 },
];

export function applyPose(anim, name, extra = {}) {
  const base = POSES.stand;
  const p = POSES[name] || base;
  const out = {};
  for (const k in base) out[k] = base[k];
  for (const k in p) out[k] = p[k];
  for (const k in extra) out[k] = extra[k];
  anim.set(out);
}
