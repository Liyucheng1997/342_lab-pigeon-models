import * as THREE from 'three';

// 所有纹理都用 Canvas 程序化生成，无需外部图片资源

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function finish(c, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// 羽毛细节纹理：灰度羽轴 + 羽枝，alpha 通道勾勒出羽片外形。
// U 方向为羽片宽度，V 方向从羽根(0)到羽尖(1)。
export function makeFeatherTexture() {
  const W = 128, H = 256;
  const [c, g] = canvas(W, H);
  g.clearRect(0, 0, W, H);
  // 羽片轮廓（canvas 的 y 向下，因此羽尖画在顶部 y=0）
  const outline = new Path2D();
  outline.moveTo(W * 0.5, H * 0.995);
  outline.bezierCurveTo(W * 0.1, H * 0.8, W * 0.02, H * 0.35, W * 0.2, H * 0.08);
  outline.quadraticCurveTo(W * 0.5, -H * 0.03, W * 0.82, H * 0.1);
  outline.bezierCurveTo(W * 0.99, H * 0.4, W * 0.88, H * 0.8, W * 0.5, H * 0.995);
  g.save();
  g.clip(outline);
  g.fillStyle = '#e8e8e8';
  g.fillRect(0, 0, W, H);
  // 羽枝：从羽轴斜向外伸展的细线
  for (let y = -40; y < H + 40; y += 2.2) {
    const shade = 200 + Math.random() * 55;
    g.strokeStyle = `rgba(${shade},${shade},${shade},0.9)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(W * 0.5, y);
    g.lineTo(0, y - 34);
    g.moveTo(W * 0.5, y);
    g.lineTo(W, y - 30);
    g.stroke();
    if (Math.random() < 0.08) {
      // 羽枝分叉/缝隙，增加真实感
      g.strokeStyle = 'rgba(120,120,120,0.5)';
      g.beginPath();
      const side = Math.random() < 0.5 ? -1 : 1;
      g.moveTo(W * 0.5, y);
      g.lineTo(W * 0.5 + side * W * 0.5, y - 32);
      g.stroke();
    }
  }
  // 边缘轻微变暗
  const edge = g.createRadialGradient(W / 2, H * 0.55, W * 0.15, W / 2, H * 0.55, W * 0.75);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);
  // 羽轴
  g.strokeStyle = '#f8f8f8';
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(W * 0.5, H);
  g.quadraticCurveTo(W * 0.52, H * 0.5, W * 0.5, H * 0.04);
  g.stroke();
  g.restore();
  return finish(c);
}

// 体羽纹理：鱼鳞状排列的小羽片，用于躯干/头部的 bump 与颜色细节
export function makeBodyFeatherTexture() {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  const rows = 12, cols = 10;
  for (let r = 0; r < rows + 1; r++) {
    for (let k = 0; k < cols + 1; k++) {
      const x = (k + (r % 2) * 0.5) * (S / cols);
      const y = r * (S / rows);
      const w = S / cols * 0.62, h = S / rows * 1.25;
      for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
        const gr = g.createRadialGradient(x + ox, y + oy - h * 0.3, 1, x + ox, y + oy, h);
        gr.addColorStop(0, '#a8a8a8');
        gr.addColorStop(0.75, '#8a8a8a');
        gr.addColorStop(1, '#5a5a5a');
        g.fillStyle = gr;
        g.beginPath();
        g.ellipse(x + ox, y + oy, w, h, 0, 0, Math.PI);
        g.fill();
      }
    }
  }
  return finish(c, { srgb: false, repeat: true });
}

// 鸽子的眼睛：橙红色虹膜（成鸟典型色），黑色瞳孔，带放射状纹理
export function makeIrisTexture(irisColor = '#e8701a') {
  const S = 128;
  const [c, g] = canvas(S, S);
  const cx = S / 2, cy = S / 2;
  g.fillStyle = '#1a1208';
  g.fillRect(0, 0, S, S);
  const base = g.createRadialGradient(cx, cy, 6, cx, cy, S * 0.48);
  base.addColorStop(0, '#ffd27a');
  base.addColorStop(0.35, irisColor);
  base.addColorStop(0.85, '#b23a0c');
  base.addColorStop(1, '#3a1406');
  g.fillStyle = base;
  g.beginPath();
  g.arc(cx, cy, S * 0.48, 0, Math.PI * 2);
  g.fill();
  // 放射状虹膜纹理
  for (let i = 0; i < 140; i++) {
    const a = Math.random() * Math.PI * 2;
    const r0 = S * 0.17, r1 = S * (0.3 + Math.random() * 0.18);
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(255,220,120,0.35)' : 'rgba(120,30,0,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.stroke();
  }
  // 瞳孔
  g.fillStyle = '#050505';
  g.beginPath();
  g.arc(cx, cy, S * 0.16, 0, Math.PI * 2);
  g.fill();
  // 高光
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.ellipse(cx - S * 0.12, cy - S * 0.13, S * 0.06, S * 0.045, -0.6, 0, Math.PI * 2);
  g.fill();
  return finish(c);
}

// 跗跖的角质鳞片纹理（红色/粉红色，覆盖网格状盾鳞）
export function makeScaleTexture() {
  const W = 64, H = 128;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#b8484a';
  g.fillRect(0, 0, W, H);
  const rows = 10;
  for (let r = 0; r < rows; r++) {
    const y = (r / rows) * H;
    const h = H / rows;
    for (let k = 0; k < 3; k++) {
      const x = (k + (r % 2) * 0.5) * (W / 3) - W / 6;
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, '#d8676a');
      gr.addColorStop(0.8, '#b04446');
      gr.addColorStop(1, '#6a2224');
      g.fillStyle = gr;
      g.beginPath();
      g.roundRect(x + 1, y + 1, W / 3 - 2, h - 1.5, 4);
      g.fill();
    }
  }
  return finish(c, { repeat: true });
}

// 广场地砖
export function makePavingTexture() {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#7d776d';
  g.fillRect(0, 0, S, S);
  const n = 4;
  const tile = S / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const off = (j % 2) * tile * 0.5;
      const v = 150 + Math.random() * 40;
      const tint = Math.random() * 12;
      g.fillStyle = `rgb(${v + tint},${v + tint * 0.6},${v - 8})`;
      g.fillRect(i * tile + off + 3, j * tile + 3, tile - 6, tile - 6);
      g.fillRect(i * tile + off + 3 - S, j * tile + 3, tile - 6, tile - 6);
      // 石材斑点
      for (let s = 0; s < 260; s++) {
        const px = i * tile + off + Math.random() * tile;
        const py = j * tile + Math.random() * tile;
        const d = Math.random() * 50 - 25;
        g.fillStyle = `rgba(${v + d},${v + d},${v + d - 5},0.45)`;
        g.fillRect(px % S, py, 2, 2);
      }
    }
  }
  return finish(c, { repeat: true });
}

// 砖墙
export function makeBrickTexture() {
  const W = 512, H = 512;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#c9bfae';
  g.fillRect(0, 0, W, H);
  const bh = 32, bw = 96;
  for (let r = 0; r < H / bh; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let k = -1; k < W / bw + 1; k++) {
      const v = 150 + Math.random() * 30;
      g.fillStyle = `rgb(${v + 40},${v - 10},${v - 35})`;
      g.fillRect(k * bw + off + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }
  return finish(c, { repeat: true });
}

// 简单的软阴影/光斑贴图
export function makeRadialTexture(inner = 'rgba(0,0,0,0.55)', outer = 'rgba(0,0,0,0)') {
  const S = 64;
  const [c, g] = canvas(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return finish(c);
}

let _cache = null;
export function getTextures() {
  if (!_cache) {
    _cache = {
      feather: makeFeatherTexture(),
      bodyFeather: makeBodyFeatherTexture(),
      scales: makeScaleTexture(),
      paving: makePavingTexture(),
      brick: makeBrickTexture(),
      blob: makeRadialTexture(),
      glow: makeRadialTexture('rgba(255,230,170,1)', 'rgba(255,200,120,0)'),
      iris: new Map(),
    };
  }
  return _cache;
}

export function getIris(color) {
  const t = getTextures();
  if (!t.iris.has(color)) t.iris.set(color, makeIrisTexture(color));
  return t.iris.get(color);
}
