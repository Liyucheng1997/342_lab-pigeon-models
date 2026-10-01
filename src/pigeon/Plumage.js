import * as THREE from 'three';

// 原鸽 / 家鸽的常见羽色型（色型由 B/b、C 等位基因及 spread、pied 等修饰基因决定）。
// 所有颜色均为 sRGB 十六进制；模型内部会转换到线性空间。
export const MORPHS = {
  blueBar: {
    label: '灰色双斑（野生型 · 原鸽）',
    head: '#6a7283', neck: '#465062', back: '#8b95a4', shield: '#a0a9b6',
    breast: '#7a8292', belly: '#9aa3b0', rump: '#e9ecef', flight: '#4b515b',
    bar: '#202126', tail: '#7f8896', tailBand: '#26272c', down: '#c9cfd6',
    iridescence: 1.0, checker: 0, pied: 0, beak: '#2a2a2c', cere: '#f1f0ea',
  },
  checker: {
    label: '灰色雨点（瓦灰斑）',
    head: '#5c6372', neck: '#4b5261', back: '#7b8493', shield: '#8f98a6',
    breast: '#6b7383', belly: '#858e9b', rump: '#7b8493', flight: '#3c414a',
    bar: '#24252a', tail: '#6f7886', tailBand: '#1f2024', down: '#b8bec6',
    iridescence: 1.0, checker: 0.55, pied: 0, beak: '#2a2a2c', cere: '#f1f0ea',
  },
  red: {
    label: '灰红（红双斑）',
    head: '#c7b3a8', neck: '#b49487', back: '#d8c7bd', shield: '#e3d6cd',
    breast: '#c59c8c', belly: '#d9c9bf', rump: '#e8dfd8', flight: '#c8b5aa',
    bar: '#8a3c28', tail: '#d6c6bc', tailBand: '#cbb7aa', down: '#efe7e1',
    iridescence: 0.55, checker: 0, pied: 0, beak: '#d9b3a2', cere: '#f3efe9',
  },
  dark: {
    label: '黑色（spread 扩散型）',
    head: '#2e3138', neck: '#2a2d33', back: '#33363d', shield: '#383b43',
    breast: '#30333a', belly: '#373a41', rump: '#33363d', flight: '#25272c',
    bar: '#25272c', tail: '#2f3238', tailBand: '#1d1e22', down: '#55585f',
    iridescence: 1.0, checker: 0, pied: 0, beak: '#1d1d1f', cere: '#e6e4de',
  },
  white: {
    label: '纯白（隐性白）',
    head: '#f4f2ee', neck: '#efede8', back: '#f2f0ec', shield: '#f6f4f0',
    breast: '#efede9', belly: '#f6f4f0', rump: '#f8f6f2', flight: '#ebe8e2',
    bar: '#e9e6e0', tail: '#f0eeea', tailBand: '#e6e3dd', down: '#ffffff',
    iridescence: 0.15, checker: 0, pied: 0, beak: '#e3c5b5', cere: '#f7f4ee',
  },
  pied: {
    label: '花斑（灰色双斑 + 白花）',
    head: '#6e7686', neck: '#5c6474', back: '#8f99a8', shield: '#a9b2bf',
    breast: '#7d8595', belly: '#9aa3b0', rump: '#e9ecef', flight: '#4b515b',
    bar: '#202126', tail: '#7f8896', tailBand: '#26272c', down: '#c9cfd6',
    iridescence: 0.9, checker: 0, pied: 0.38, beak: '#9b8278', cere: '#f1f0ea',
  },
};

// 把 morph 中的十六进制颜色转换成 THREE.Color（线性空间）
export function resolveMorph(name) {
  const src = MORPHS[name] ?? MORPHS.blueBar;
  const out = { ...src, key: name };
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'string' && src[k].startsWith('#')) out[k] = new THREE.Color(src[k]);
  }
  return out;
}

// 花斑：根据 3D 位置给出一个确定性的“是否为白羽”判定
export function piedMask(x, y, z, seed, amount) {
  if (amount <= 0) return 0;
  const n =
    Math.sin(x * 37.1 + seed * 1.7) * Math.cos(y * 41.3 - seed) +
    Math.sin(z * 29.7 + y * 13.1 + seed * 2.3) * 0.8;
  return n > 1.25 - amount * 2.6 ? 1 : 0;
}
