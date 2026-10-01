import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { World } from './world/World.js';
import { DayCycle } from './world/DayCycle.js';
import { Feeder, Pedestrian, Falcon } from './world/Actors.js';
import { Flock } from './pigeon/Flock.js';
import { Sounds } from './audio/Sounds.js';
import { UI } from './ui/UI.js';
import { rand, chance, damp } from './utils/math.js';

// =====================================================================================
//  入口：渲染器、场景、主循环、交互
// =====================================================================================
class App {
  constructor() {
    const container = document.getElementById('app');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;

    this.camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.02, 1200);
    this.camera.position.set(1.6, 1.0, 5.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 70;
    this.controls.target.set(1, 0.15, 3);

    this.day = new DayCycle(7.6);
    this.world = new World(this.scene, this.renderer);
    this.flock = new Flock(this.world, this.day);
    this.flock.spawnInitial();
    this.feeder = new Feeder(this.world, this.world.benches[0]);
    this.flock.feeder = this.feeder;
    this.peds = [new Pedestrian(this.world), new Pedestrian(this.world), new Pedestrian(this.world), new Pedestrian(this.world, true)];
    this.falcon = new Falcon(this.world);
    this.sounds = new Sounds();
    this.sounds.setCamera(this.camera);
    this.flock.sound = this.sounds;

    this.speed = 1;
    this.tool = null;
    this.camMode = 'follow';
    this.selected = this.flock.pigeons[0];
    this.scares = [];
    this.pedT = 6;
    this.crumbT = 5;
    this.clock = new THREE.Clock();
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();

    this.ui = new UI(this);
    this.flock.onEvent = (text) => {
      this.ui.addEvent(text, `${this.day.day}日 ${this.day.clockString}`);
      this.ui.toast(text);
    };
    this.flock.onNewPigeon = (p) => this.ui.toast(`新成员：${p.name}`);
    this.flock.event('清晨，鸽群从窗台飞下广场。点击任意一只鸽子查看它在想什么');

    this._bindInput();
    // 初始镜头位置：从选中鸽子后上方看过去
    const p0 = this.selected.pos;
    this.controls.target.set(p0.x, 0.15, p0.z);
    this.camera.position.set(p0.x + 1.2, 0.75, p0.z + 1.6);

    addEventListener('resize', () => this._resize());
    this.renderer.setAnimationLoop(() => this._frame());
    setTimeout(() => {
      const l = document.getElementById('loading');
      l.style.opacity = 0;
      setTimeout(() => l.remove(), 700);
    }, 300);
    setTimeout(() => (document.getElementById('hint').style.opacity = 0), 9000);
    window.app = this;
  }

  // ------------------------------------------------------------------ 交互
  _bindInput() {
    const dom = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    dom.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
      ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      this.sounds.enabled || this._autoSound();
      if (this.tool) {
        const hit = ray.intersectObject(this.world.ground, false)[0];
        if (!hit) return;
        if (this.tool === 'feed') {
          const from = hit.point.clone().add(new THREE.Vector3(rand(-0.4, 0.4), 1.3, rand(-0.4, 0.4)));
          this.world.food.scatter(from, hit.point, 45, 0.55, chance(0.5) ? 'seed' : 'corn');
        } else if (this.tool === 'scare') {
          this.scares.push({ kind: 'scare', label: '突然的拍手声', position: hit.point.clone(), vel: null, until: this.flock.time + 0.8 });
          this.sounds.click(hit.point);
        }
        return;
      }
      // 选择鸽子：在鸽子包围盒附近做宽松拾取
      let best = null, bd = Infinity;
      for (const p of this.flock.pigeons) {
        const c = p.pos.clone().add(new THREE.Vector3(0, 0.12, 0));
        const d = ray.ray.distanceToPoint(c);
        const dc = c.distanceTo(this.camera.position);
        const tol = Math.max(0.12, dc * 0.025);
        if (d < tol && dc < bd) { bd = dc; best = p; }
      }
      if (best) this.select(best);
    });
  }

  _autoSound() {}

  // 调试：让指定的鸽子立即执行某个行为，例如 app.force('灰灰', 'preen')
  async force(name, key) {
    const { BEHAVIORS } = await import('./pigeon/Behaviors.js');
    const p = this.flock.pigeons.find((q) => q.name === name);
    const B = BEHAVIORS.find((b) => b.key === key);
    if (!p || !B) return false;
    p.brain._start(B, { day: this.day, dh: 0, threats: [], time: this.flock.time });
    p.brain.evalT = 1e9;
    this.select(p);
    return true;
  }

  release(name) {
    const p = this.flock.pigeons.find((q) => q.name === name);
    if (p) p.brain.evalT = 0;
  }

  select(p) {
    this.selected = p;
    if (this.camMode === 'free') this.setCamMode('follow');
    this.ui._chipsSig = '';
  }

  setSpeed(s) {
    this.speed = s;
  }

  setTool(t) {
    this.tool = t;
  }

  setCamMode(m) {
    this.camMode = m;
    this.ui.setCamButtons(m);
    if (m === 'close' && this.selected) {
      const t = this.controls.target;
      const dir = this.camera.position.clone().sub(t).normalize();
      this.camera.position.copy(t).addScaledVector(dir, 0.75);
    }
  }

  jumpTo(v) {
    const before = this.flock.absHours;
    if (v === '+24') {
      this.day.day += 1;
    } else {
      this.day.skipTo(parseFloat(v));
    }
    this.day._computeSun();
    const hours = this.flock.absHours - before;
    this.flock.onTimeJump(hours);
    this.ui.toast(v === '+24' ? '快进了一整天，繁殖进程随之推进' : `时间跳到 ${this.day.clockString}`);
  }

  action(a) {
    if (a === 'sound') {
      if (this.sounds.enabled) this.sounds.disable();
      else this.sounds.enable();
      this.ui.setSoundIcon(this.sounds.enabled);
      if (this.sounds.enabled) this.ui.toast('声音已开启：靠近鸽子能听到咕咕声和起飞的拍翅声');
    } else if (a === 'feeder') {
      this.feeder.callNow();
      this.ui.toast('老人拎着一袋谷子走向长椅');
    } else if (a === 'child') {
      const c = this.peds.find((p) => p.child && !p.active) || this.peds.find((p) => !p.active);
      if (c) { c.child = true; c.radius = 4.5; c.kind = 'child'; c.label = '追鸽子的小孩'; c.spawn(this.flock); this.ui.toast('一个小孩张开双臂冲向鸽群！'); }
    } else if (a === 'falcon') {
      if (!this.falcon.active) { this.falcon.spawn(this.flock); this.ui.toast('高空出现一只游隼……'); this.flock.event('🦅 一只游隼在高空盘旋'); }
    } else if (a === 'flock') {
      if (!this.flock.startGroupFlight()) this.ui.toast('地面上的鸽子太少，暂时不会群飞');
    } else if (a === 'wiki') {
      this.ui.toggleWiki();
    }
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  // ------------------------------------------------------------------ 威胁与随机事件
  _threats() {
    const out = [];
    for (const p of this.peds) if (p.active) out.push(p);
    if (this.feeder.active) out.push({ kind: 'feeder', label: this.feeder.label, position: this.feeder.position, vel: null });
    if (this.falcon.active && this.falcon.state !== 'leave') out.push(this.falcon);
    this.scares = this.scares.filter((s) => s.until > this.flock.time);
    for (const s of this.scares) out.push(s);
    return out;
  }

  _randomEvents(dt) {
    const day = this.day;
    // 路人：白天较多
    this.pedT -= dt;
    if (this.pedT <= 0) {
      this.pedT = day.isNight ? rand(60, 120) : rand(14, 35);
      const free = this.peds.find((p) => !p.active && !p.child);
      if (free && day.hour > 6.5 && day.hour < 22) free.spawn(this.flock);
      // 偶尔有小孩
      if (day.daylight > 0.7 && chance(0.08)) {
        const c = this.peds.find((p) => p.child && !p.active);
        if (c) c.spawn(this.flock);
      }
    }
    // 行人掉落的面包屑、风吹来的草籽
    this.crumbT -= dt;
    if (this.crumbT <= 0) {
      this.crumbT = rand(5, 11);
      if (day.daylight > 0.4) this.world.food.sprinkleNatural(this.world.bounds, 3);
    }
    // 游隼偶尔出现
    if (!this.falcon.active && day.daylight > 0.6 && chance(dt * 0.0006)) {
      this.falcon.spawn(this.flock);
      this.flock.event('🦅 一只游隼在高空盘旋');
    }
    // 每天清晨重新长出可用的细枝
    if (this._lastDay !== day.day) { this._lastDay = day.day; this.world.regrowTwigs(); }
  }

  // ------------------------------------------------------------------ 主循环
  _frame() {
    this._tick(Math.min(this.clock.getDelta(), 0.05));
  }

  // 调试/测试用：以固定步长快速推进模拟（不依赖浏览器帧回调）
  simulate(seconds, step = 1 / 30) {
    const n = Math.round(seconds / step);
    for (let i = 0; i < n; i++) this._tick(step, i === n - 1);
  }

  _tick(dt, render = true) {
    const steps = Math.max(0, Math.ceil(this.speed));
    const sub = steps ? (dt * this.speed) / steps : 0;
    this.camera.updateMatrixWorld();
    this._projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);
    for (let i = 0; i < steps; i++) {
      const dh = this.day.update(sub);
      const ctx = {
        day: this.day, dh, threats: this._threats(), time: this.flock.time,
        render: render && i === steps - 1, frustum: this._frustum, camPos: this.camera.position,
      };
      this.feeder.update(sub, this.day);
      for (const p of this.peds) p.update(sub);
      this.falcon.update(sub);
      this.flock.update(sub, ctx);
      this._randomEvents(sub);
    }
    if (steps === 0) {
      // 暂停：保持渲染
      for (const p of this.flock.pigeons) p.model.finalize();
    }
    this._updateCamera(dt);
    this.world.update(dt * Math.max(this.speed, 0.0001), this.day, this.controls.target);
    if (!render) return;
    this.scene.environmentIntensity = 0.12 + 0.45 * this.day.daylight;
    this.renderer.toneMappingExposure = 0.95 + (1 - this.day.daylight) * 0.35;
    this.sounds.setAmbience(this.day.daylight);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.ui.update(dt);
  }

  _updateCamera(dt) {
    const p = this.selected;
    if (!p || this.camMode === 'free') return;
    const target = p.pos.clone();
    target.y += p.mode === 'air' ? 0.1 : 0.13;
    const t = this.controls.target;
    const k = 1 - Math.exp(-dt * (p.mode === 'air' ? 14 : 3.5));
    const delta = target.sub(t).multiplyScalar(k);
    t.add(delta);
    this.camera.position.add(delta);
    // 飞行中自动拉远一些，避免跟丢
    const dist = this.camera.position.distanceTo(t);
    const want = this.camMode === 'close' ? 0.75 : p.mode === 'air' ? Math.max(dist, 3.5) : dist;
    if (Math.abs(want - dist) > 0.01 && (this.camMode === 'close' || p.mode === 'air')) {
      const dir = this.camera.position.clone().sub(t).normalize();
      const nd = damp(dist, want, 2, dt);
      this.camera.position.copy(t).addScaledVector(dir, nd);
    }
    if (this.camera.position.y < 0.05) this.camera.position.y = 0.05;
  }
}

new App();
