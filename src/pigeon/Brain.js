import { BEHAVIORS, Idle } from './Behaviors.js';

// =====================================================================================
//  决策：效用 AI
//  每隔约半秒为所有可用行为打分，选择得分最高者；当前行为有“惯性”加成，
//  不可打断的行为（惊飞、孵卵、归巢、群飞）只有在出现更紧迫的需求时才会被替换。
// =====================================================================================
export class Brain {
  constructor(p) {
    this.p = p;
    this.current = null;
    this.evalT = Math.random() * 0.5;
    this.lastEnd = {};
    this.lastKey = null;
    this.nudge = null;
    this.scores = [];
    this.trace = [];
  }

  since(key) {
    return this.p.flock.time - (this.lastEnd[key] ?? -1e9);
  }

  update(dt, ctx) {
    const p = this.p;
    if (this.current) {
      this.current.t += dt;
      let done = false;
      try {
        done = this.current.update(dt, ctx);
      } catch (err) {
        console.error(`[${p.name}] 行为 ${this.current.name} 出错`, err);
        done = true;
      }
      if (done) this._end();
    }
    this.evalT -= dt;
    if (!this.current || this.evalT <= 0) {
      this.evalT = 0.45 + Math.random() * 0.3;
      this._choose(ctx);
    }
  }

  _end() {
    const p = this.p, c = this.current;
    if (!c) return;
    try { c.stop(); } catch (e) { console.error(e); }
    this.lastEnd[c.name] = p.flock.time;
    this.lastKey = c.name;
    this.current = null;
    const a = p.anim;
    if (p.mode !== 'air') {
      a.legMode = 'ground';
      a.speed.wing = 14;
    }
    a.lookAround = true;
    a.headBob = true;
    a.nibble = 0;
    if (p.mode !== 'air') p.stop();
  }

  forceEnd() {
    this._end();
  }

  _choose(ctx) {
    const p = this.p;
    const mode = p.mode;
    this.scores = [];
    let best = null, bestS = 0;
    let curS = 0;
    for (const B of BEHAVIORS) {
      // 空中只允许切换到“惊飞”；其余情况下保持当前行为（飞行由行为自身驱动）
      if (mode === 'air' && B.key !== 'flee') continue;
      if (mode !== 'air' && !B.modes.includes(mode)) continue;
      let s = B.score(p, ctx);
      if (!(s > 0)) continue;
      s *= 1 + (Math.random() - 0.5) * 0.12;
      const isCur = this.current && this.current.constructor === B;
      if (isCur) { s += 0.3; curS = s; }
      this.scores.push({ key: B.key, label: B.label, s });
      if (s > bestS) { bestS = s; best = B; }
    }
    this.scores.sort((a, b) => b.s - a.s);
    if (mode === 'air') {
      if (best && (!this.current || this.current.constructor !== best) && (!this.current || this.current.name !== 'flee')) this._start(best, ctx);
      return;
    }
    if (!best) best = Idle;
    if (this.current) {
      if (this.current.constructor === best) return;
      const margin = this.current.interruptible ? 0.12 : 1.4;
      if (bestS < curS + margin) return;
      this._end();
    }
    this._start(best, ctx);
  }

  _start(B, ctx) {
    if (this.current) this._end();
    const b = new B(this.p, ctx);
    this.current = b;
    this.trace.push(`${ctx.day.clockString} ${B.key}`);
    if (this.trace.length > 40) this.trace.shift();
    try {
      b.start();
    } catch (err) {
      console.error(`[${this.p.name}] 行为 ${b.name} 启动出错`, err);
      this.current = null;
    }
  }
}
