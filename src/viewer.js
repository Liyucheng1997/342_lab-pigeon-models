import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PigeonModel } from './pigeon/PigeonModel.js';
import { PigeonAnimator } from './pigeon/PigeonAnimator.js';
import { applyPose, PREEN_SPOTS } from './pigeon/Poses.js';
import { MORPHS } from './pigeon/Plumage.js';
import { getTextures } from './utils/textures.js';

// =====================================================================================
//  模型检视页：在转台上展示单只鸽子的各种姿态与动作
// =====================================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1b2029');
scene.fog = new THREE.Fog('#1b2029', 3, 9);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 50);
camera.position.set(0.62, 0.32, 0.72);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.14, 0);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.minDistance = 0.18;
controls.maxDistance = 3;
controls.maxPolarAngle = Math.PI * 0.62;

const key = new THREE.DirectionalLight('#fff1dc', 3.0);
key.position.set(1.2, 2.2, 1.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.5, far: 6 });
key.shadow.bias = -0.0003;
const rim = new THREE.DirectionalLight('#9fc4ff', 1.6);
rim.position.set(-1.5, 1.2, -1.6);
scene.add(key, rim, new THREE.HemisphereLight('#d9e6ff', '#3a3226', 0.5));

// 展台
const tex = getTextures();
const paving = tex.paving.clone();
paving.needsUpdate = true;
paving.repeat.set(2, 2);
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.82, 0.04, 64), new THREE.MeshStandardMaterial({ map: paving, roughness: 0.9, color: '#d8d2c8' }));
pedestal.position.y = -0.02;
pedestal.receiveShadow = true;
scene.add(pedestal);
const water = new THREE.Mesh(new THREE.CircleGeometry(0.16, 40).rotateX(-Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: '#4d5e68', roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.8 }));
water.position.set(0, 0.006, 0.17);
water.visible = false;
scene.add(water);

let model = null, anim = null;
let morph = 'blueBar', sex = 'male';
let poseKey = 'stand';
let poseT = 0;
let shellsEnabled = true;

function build() {
  if (model) { scene.remove(model.root); model.dispose(); }
  model = new PigeonModel({ morph, sex, seed: 7, size: sex === 'male' ? 1.04 : 0.97 });
  model.shellsEnabled = shellsEnabled;
  anim = new PigeonAnimator(model);
  anim.groundY = () => 0;
  scene.add(model.root);
  setPose(poseKey);
}

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- 姿态库
const POSE_LIST = {
  stand: {
    label: '站立', note: '静息站姿：身体约 25° 上仰，颈部收短呈 S 形，尾羽略下垂。头部会不时快速转动，用一侧眼睛观察（鸽子单眼视野约 170°）。',
    enter() { applyPose(anim, 'stand'); },
  },
  walk: {
    label: '行走点头', note: '两足交替迈步，脚掌着地不打滑（两骨 IK）。头部先在空间中“定住”，身体前移后再快速前冲——这就是鸽子走路点头的原理。',
    enter() { applyPose(anim, 'walk'); },
    update(t, dt) {
      const r = 0.42, w = 0.3 / r;
      const a = t * w;
      model.root.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      model.root.rotation.y = -a;
      anim.walkSpeed = 0.3;
      anim.localVel.set(0, 0, 0.3);
      controls.target.lerp(V3(model.root.position.x, 0.13, model.root.position.z), 0.08);
    },
  },
  peck: {
    label: '啄食', note: '低头快速啄击，最后一瞬闭眼并张开喙；食物整粒吞下后沿食道进入嗉囊（可见颈部的吞咽波动）。',
    enter() { applyPose(anim, 'forage'); this.t = 0; },
    update(t, dt) {
      this.t -= dt;
      if (this.t <= 0 && !anim.pecking) {
        this.t = 0.9;
        const g = V3((Math.random() - 0.5) * 0.04, 0.003, 0.085);
        model.root.localToWorld(g);
        anim.peck(g);
        setTimeout(() => (anim.swallow = 1), 380);
      }
    },
  },
  spread: {
    label: '展翅', note: '双翅完全展开（翼展约 65 cm）：外侧 10 枚初级飞羽构成尖形翼尖，内侧为次级飞羽，上方覆盖大、中、小覆羽，腕部前缘有小翼羽。翼下颜色明显较浅。',
    enter() { applyPose(anim, 'stand', { foldL: 0, foldR: 0, raiseL: 0.35, raiseR: 0.35, tailSpread: 1, bodyPitch: -0.45, headPitch: 0.1 }); },
  },
  fly: {
    label: '平飞振翅', note: '平飞时每秒振翅约 6–7 次：下扑时翅膀完全伸展并内旋，上挥时肘、腕弯曲收拢以减小阻力；双脚收向后方，尾羽略张开用于转向。',
    enter() { model.root.position.y = 0.2; anim.legMode = 'air'; anim.set({ bodyPitch: 0.05, bodyHeight: 0.1, head: V3(0, 0.125, 0.105), headPitch: -0.05, tailSpread: 0.2, tailPitch: 0, foldL: 0, foldR: 0 }); anim.startFlap({ freq: 6.5, amp: 0.78, bias: 0.08, flexAmt: 0.45, glide: 0 }); anim.lookAround = false; },
  },
  takeoff: {
    label: '起飞拍翅', note: '起飞时振翅频率更高、幅度更大，翼尖在背部上方相互拍击发出清脆的“啪啪”声；受惊起飞时这声音也是给同伴的警报。',
    enter() { model.root.position.y = 0.12; anim.legMode = 'air'; anim.set({ bodyPitch: -0.6, head: V3(0, 0.15, 0.1), headPitch: 0.4, tailSpread: 0.9, tailPitch: 0.15, foldL: 0, foldR: 0 }); anim.startFlap({ freq: 9, amp: 1.15, bias: 0.15, flexAmt: 0.6, clap: true }); anim.lookAround = false; },
  },
  glide: {
    label: 'V 形滑翔', note: '雄鸽的炫耀飞行：用力拍翅后双翅上举成 V 字形滑翔，尾羽张开。',
    enter() { model.root.position.y = 0.2; anim.legMode = 'air'; anim.set({ bodyPitch: 0.05, head: V3(0, 0.125, 0.105), headPitch: -0.05, tailSpread: 0.75, tailPitch: 0, foldL: 0, foldR: 0, sweep: 0.15 }); anim.startFlap({ freq: 6, amp: 0, bias: 0.5, glide: 1 }); anim.lookAround = false; },
  },
  land: {
    label: '着陆拉平', note: '降落前身体大角度上仰，尾羽完全张开当作减速板，翅膀快速向前扑动，双腿前伸准备着地。',
    enter() { model.root.position.y = 0.12; anim.legMode = 'land'; anim.set({ bodyPitch: -0.95, head: V3(0, 0.125, 0.105), headPitch: 0.9, tailSpread: 1, tailPitch: -0.25, foldL: 0, foldR: 0, sweep: -0.25, spread: 1.1 }); anim.startFlap({ freq: 8.5, amp: 1.05, bias: 0.2, flexAmt: 0.55 }); anim.lookAround = false; },
  },
  court: {
    label: '求偶鞠躬', note: '雄鸽颈羽蓬起、嗉囊充气鼓胀，尾羽展开拖在地上，一边“鞠躬”一边发出咕咕声，还会原地转圈。',
    update(t) {
      const cyc = (t % 1.7) / 1.7;
      const bow = Math.sin(cyc * Math.PI);
      applyPose(anim, 'stand', { neckPuff: 1, crop: 0.8, tailSpread: 0.85, tailPitch: -0.3, fluff: 0.35, bodyPitch: -0.3 + bow * 0.25, head: V3(0, 0.185 - bow * 0.06, 0.08 + bow * 0.02), headPitch: 0.1 + bow * 0.9 });
      anim.lookAround = false;
      if (t % 6 > 4) model.root.rotation.y += 0.05;
    },
  },
  drink: {
    label: '吸吮饮水', note: '把喙插入水中像吸管一样连续吸水，喉部有节奏地抽动，整个过程不需要抬头——这是鸠鸽类特有的饮水方式。',
    enter() { water.visible = true; this.p = 0; },
    update(t, dt) {
      applyPose(anim, 'stand', { bodyPitch: -0.12, bodyHeight: 0.095, head: V3(0, 0.032, 0.085), headPitch: 1.22, tailPitch: 0.05 });
      anim.lookAround = false; anim.headBob = false;
      this.p -= dt;
      if (this.p <= 0) { this.p = 0.55; anim.swallow = 1; }
    },
    exit() { water.visible = false; anim.headBob = true; },
  },
  preen: {
    label: '理羽', note: '用喙依次梳理翼覆羽、胸羽、翼下、背部与飞羽，把散开的羽小钩重新扣合。颈部可以扭转近 180°。',
    enter() { this.i = 0; this.t = 0; },
    update(t, dt) {
      this.t -= dt;
      if (this.t <= 0) {
        const s = PREEN_SPOTS[this.i++ % PREEN_SPOTS.length];
        this.t = 2.2;
        applyPose(anim, 'stand', { fluff: 0.35, head: s.head, headYaw: s.yaw, headPitch: s.pitch, headRoll: s.roll, raiseL: s.raiseL || 0, raiseR: s.raiseR || 0, foldL: s.foldL ?? 1, foldR: s.foldR ?? 1 });
        setNote(`理羽：${s.name}`);
      }
      anim.nibble = 1;
      anim.lookAround = false; anim.headBob = false;
    },
    exit() { anim.nibble = 0; anim.headBob = true; },
  },
  sunbathe: {
    label: '日光浴', note: '侧卧在地上，把朝阳一侧的翅膀高高张开、尾羽展开，眼睛半闭，让阳光照进羽毛之间。',
    enter() { applyPose(anim, 'sit', { bodyHeight: 0.06, bodyRoll: 0.55, fluff: 0.8, raiseL: 0.75, foldL: 0.25, tailSpread: 0.85, head: V3(0.02, 0.135, 0.06), headRoll: 0.5, lid: 0.6 }); anim.legMode = 'sit'; },
  },
  sleep: {
    label: '睡眠', note: '夜间单脚站立或伏卧，把头缩进蓬松的颈羽与肩羽中，全身羽毛蓬起保温，双眼闭合。',
    enter() { applyPose(anim, 'oneLeg', { lid: 1, fluff: 1, head: V3(0, 0.138, 0.032), headPitch: 0.6 }); anim.legMode = 'oneLeg'; anim.lookAround = false; },
  },
  stretch: {
    label: '伸展', note: '“单侧翼腿伸展”：一侧翅膀连同同侧的腿一起向后伸展，尾羽张开；醒来或长时间休息后常见。',
    update(t) {
      const k = Math.sin(((t % 3) / 3) * Math.PI);
      applyPose(anim, 'stand', { raiseL: -0.25 * k, foldL: 1 - 0.9 * k, sweep: 0.5 * k, tailSpread: 0.7 * k, bodyRoll: 0.08 * k });
    },
  },
};

function setNote(text) {
  document.getElementById('pose-note').textContent = text;
}

function setPose(key) {
  const prev = POSE_LIST[poseKey];
  prev?.exit?.call(prev);
  poseKey = key;
  poseT = 0;
  // 复位
  anim.reset();
  anim.stopFlap();
  anim.legMode = 'ground';
  anim.lookAround = true;
  anim.headBob = true;
  anim.nibble = 0;
  anim.walkSpeed = 0;
  anim.localVel.set(0, 0, 0);
  model.root.position.set(0, 0, 0);
  model.root.rotation.y = 0;
  controls.target.set(0, key === 'fly' || key === 'glide' ? 0.3 : 0.14, 0);
  const P = POSE_LIST[key];
  P.enter?.call(P);
  setNote(P.note);
  for (const b of document.querySelectorAll('#poses button')) b.classList.toggle('on', b.dataset.k === key);
}

// ---------------------------------------------------------------- UI
const posesEl = document.getElementById('poses');
for (const [k, v] of Object.entries(POSE_LIST)) {
  const b = document.createElement('button');
  b.textContent = v.label;
  b.dataset.k = k;
  b.onclick = () => setPose(k);
  posesEl.appendChild(b);
}
const morphsEl = document.getElementById('morphs');
for (const [k, v] of Object.entries(MORPHS)) {
  const b = document.createElement('button');
  b.textContent = v.label.replace(/（.*?）/, '');
  b.title = v.label;
  b.dataset.k = k;
  b.classList.toggle('on', k === morph);
  b.onclick = () => {
    morph = k;
    for (const o of morphsEl.children) o.classList.toggle('on', o === b);
    build();
  };
  morphsEl.appendChild(b);
}
const sexEl = document.getElementById('sexes');
for (const [k, label] of [['male', '♂ 雄鸽'], ['female', '♀ 雌鸽']]) {
  const b = document.createElement('button');
  b.textContent = label;
  b.classList.toggle('on', k === sex);
  b.onclick = () => {
    sex = k;
    for (const o of sexEl.children) o.classList.toggle('on', o === b);
    build();
  };
  sexEl.appendChild(b);
}
document.getElementById('turntable').onchange = (e) => (controls.autoRotate = e.target.checked);
let slow = 1;
document.getElementById('slowmo').onchange = (e) => (slow = e.target.checked ? 0.25 : 1);
document.getElementById('shell').onchange = (e) => {
  shellsEnabled = e.target.checked;
  model.shellsEnabled = shellsEnabled;
};

build();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05) * slow;
  poseT += dt;
  const P = POSE_LIST[poseKey];
  P.update?.call(P, poseT, dt);
  anim.update(dt);
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);
window.viewer = { setPose, step: (s) => { for (let i = 0; i < s * 30; i++) { poseT += 1 / 30; POSE_LIST[poseKey].update?.call(POSE_LIST[poseKey], poseT, 1 / 30); anim.update(1 / 30); } controls.update(); renderer.render(scene, camera); }, camera, controls };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
