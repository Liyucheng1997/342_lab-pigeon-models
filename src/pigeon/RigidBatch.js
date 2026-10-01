import * as THREE from 'three';

// 把许多“刚性附着在骨骼节点上”的小零件（羽毛、趾节、爪、喙……）合并成一个网格，
// 每帧在 CPU 上把各零件按其节点的变换写入同一个顶点缓冲。
// 这样一只鸽子的 150 余片羽毛只需要 1 次绘制调用，整群鸽子也能流畅运行。
const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();

export class RigidBatch {
  constructor(material, name = 'batch') {
    this.material = material;
    this.name = name;
    this.parts = [];
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  // node：决定零件位姿的 Object3D（不渲染）；geometry：零件在节点局部空间中的几何体
  // color：THREE.Color 或 (x,y,z,u,v)=>THREE.Color；若几何体自带 color 属性则优先使用
  add(node, geometry, color) {
    const g = geometry.index ? geometry : geometry.toNonIndexed();
    const pos = g.attributes.position.array.slice();
    if (!g.attributes.normal) g.computeVertexNormals();
    const nrm = g.attributes.normal.array.slice();
    const count = pos.length / 3;
    const uv = g.attributes.uv ? g.attributes.uv.array.slice() : new Float32Array(count * 2).fill(0.5);
    let col;
    if (g.attributes.color) {
      col = g.attributes.color.array.slice();
    } else {
      col = new Float32Array(count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < count; i++) {
        if (typeof color === 'function') c.copy(color(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]));
        else c.copy(color ?? new THREE.Color(1, 1, 1));
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
    }
    const index = g.index ? Array.from(g.index.array) : [...Array(count).keys()];
    this.parts.push({ node, pos, nrm, uv, col, index, count, offset: 0 });
    this.vertexCount += count;
    this.indexCount += index.length;
    geometry.dispose();
    if (g !== geometry) g.dispose();
  }

  build(parent, { castShadow = true, receiveShadow = true, depthMaterial = null, radius = 0.6 } = {}) {
    const V = this.vertexCount;
    const position = new Float32Array(V * 3);
    const normal = new Float32Array(V * 3);
    const uv = new Float32Array(V * 2);
    const color = new Float32Array(V * 3);
    const index = new Uint32Array(this.indexCount);
    let vo = 0, io = 0;
    for (const p of this.parts) {
      p.offset = vo;
      uv.set(p.uv, vo * 2);
      color.set(p.col, vo * 3);
      for (let i = 0; i < p.index.length; i++) index[io++] = p.index[i] + vo;
      vo += p.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = this.name;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = receiveShadow;
    if (depthMaterial) this.mesh.customDepthMaterial = depthMaterial;
    parent.add(this.mesh);
    // 释放各零件中不再需要的数据
    for (const p of this.parts) { p.uv = null; p.col = null; p.index = null; }
    return this.mesh;
  }

  // invParent：父节点（mesh 所在节点）世界矩阵的逆
  update(invParent) {
    const P = this.geometry.attributes.position.array;
    const N = this.geometry.attributes.normal.array;
    for (const p of this.parts) {
      if (!p.node.visible && p.collapsed) continue;
      _m.multiplyMatrices(invParent, p.node.matrixWorld);
      _n.getNormalMatrix(_m);
      const e = _m.elements, n = _n.elements;
      const src = p.pos, sn = p.nrm;
      let o = p.offset * 3;
      const hidden = !p.node.visible;
      // 已经折叠隐藏的零件无需重复写入
      if (hidden && p.collapsed) continue;
      p.collapsed = hidden;
      for (let i = 0; i < src.length; i += 3, o += 3) {
        const x = src[i], y = src[i + 1], z = src[i + 2];
        if (hidden) {
          P[o] = e[12]; P[o + 1] = e[13]; P[o + 2] = e[14];
        } else {
          P[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
          P[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          P[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        const a = sn[i], b = sn[i + 1], c = sn[i + 2];
        let nx = n[0] * a + n[3] * b + n[6] * c;
        let ny = n[1] * a + n[4] * b + n[7] * c;
        let nz = n[2] * a + n[5] * b + n[8] * c;
        const l = 1 / (Math.hypot(nx, ny, nz) || 1);
        N[o] = nx * l; N[o + 1] = ny * l; N[o + 2] = nz * l;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }

  dispose() {
    this.geometry?.dispose();
  }
}
