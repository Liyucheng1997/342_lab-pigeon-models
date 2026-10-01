import { MORPHS } from '../pigeon/Plumage.js';
import { HABITS } from './Encyclopedia.js';
import { BIO } from '../config.js';

const $ = (id) => document.getElementById(id);

const MODE_LABEL = { ground: '地面', air: '飞行中', perch: '停栖' };
const FLIGHT_PHASE = { takeoff: '起飞', cruise: '平飞', approach: '进近', land: '拉平着陆' };

// 界面：时间、工具栏、选中鸽子的详细状态、事件、百科
export class UI {
  constructor(app) {
    this.app = app;
    this.t = 0;
    this._chipsSig = '';
    this._bind();
    this._buildWiki();
  }

  _bind() {
    const app = this.app;
    for (const b of document.querySelectorAll('#speed-buttons button')) {
      b.addEventListener('click', () => {
        app.setSpeed(parseFloat(b.dataset.speed));
        for (const o of document.querySelectorAll('#speed-buttons button')) o.classList.toggle('on', o === b);
      });
    }
    for (const b of document.querySelectorAll('[data-jump]')) {
      b.addEventListener('click', () => app.jumpTo(b.dataset.jump));
    }
    for (const b of document.querySelectorAll('[data-tool]')) {
      b.addEventListener('click', () => {
        const tool = app.tool === b.dataset.tool ? null : b.dataset.tool;
        app.setTool(tool);
        for (const o of document.querySelectorAll('[data-tool]')) o.classList.toggle('on', o.dataset.tool === tool);
        document.body.className = tool ? `tool-${tool}` : '';
        if (tool === 'feed') this.toast('点击地面撒一把谷子');
        if (tool === 'scare') this.toast('点击地面拍一下手，附近的鸽子会被惊飞');
      });
    }
    for (const b of document.querySelectorAll('[data-cam]')) {
      b.addEventListener('click', () => {
        app.setCamMode(b.dataset.cam);
        for (const o of document.querySelectorAll('[data-cam]')) o.classList.toggle('on', o === b);
      });
    }
    for (const b of document.querySelectorAll('[data-action]')) {
      b.addEventListener('click', () => app.action(b.dataset.action));
    }
    $('wiki-close').addEventListener('click', () => this.toggleWiki(false));
  }

  setSoundIcon(on) {
    const b = $('sound-btn');
    b.innerHTML = `${on ? '🔊' : '🔇'}<span>声音</span>`;
    b.classList.toggle('on', on);
  }

  setCamButtons(mode) {
    for (const o of document.querySelectorAll('[data-cam]')) o.classList.toggle('on', o.dataset.cam === mode);
  }

  toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  }

  toggleWiki(force) {
    const el = $('wiki-panel');
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) this._updateWiki();
  }

  _buildWiki() {
    const list = $('wiki-list');
    list.innerHTML = HABITS.map((h, i) => `
      <article class="habit" data-i="${i}">
        <h4>${h.icon} ${h.title}<span class="live"></span></h4>
        <p>${h.text}</p>
      </article>`).join('');
  }

  _updateWiki() {
    const pigeons = this.app.flock.pigeons;
    const counts = {};
    for (const p of pigeons) {
      const k = p.brain.current?.name;
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
    for (const el of document.querySelectorAll('.habit')) {
      const h = HABITS[+el.dataset.i];
      const n = h.keys.reduce((s, k) => s + (counts[k] || 0), 0);
      el.classList.toggle('active', n > 0);
      el.querySelector('.live').textContent = n > 0 ? `● ${n} 只正在进行` : '';
    }
  }

  addEvent(text, time) {
    const ul = $('events');
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${time}</span>${text}`;
    ul.prepend(li);
    while (ul.children.length > 40) ul.lastChild.remove();
  }

  // ------------------------------------------------------------ 每帧（节流）
  update(dt) {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.2;
    const { day, flock, selected } = this.app;
    $('clock-day').textContent = `第 ${day.day} 天`;
    $('clock-time').textContent = day.clockString;
    $('clock-period').textContent = day.periodLabel;
    $('clock-temp').textContent = `🌡 ${day.temperature.toFixed(1)}°C`;
    $('clock-sun').textContent = day.isNight ? '🌙 夜' : day.sunStrength > 0.5 ? '☀️ 晴' : '🌤 弱光';
    $('clock-count').textContent = `🕊 ${flock.pigeons.length} 只 · ${flock.pairs.length} 对`;
    this._chips();
    if (selected) this._bird(selected);
    if (!$('wiki-panel').classList.contains('hidden')) this._updateWiki();
  }

  _chips() {
    const { flock, selected } = this.app;
    const sig = flock.pigeons.map((p) => p.id).join(',') + '|' + selected?.id;
    if (sig === this._chipsSig) return;
    this._chipsSig = sig;
    const el = $('bird-chips');
    el.innerHTML = '';
    for (const p of flock.pigeons) {
      const b = document.createElement('button');
      const m = MORPHS[p.morph];
      b.innerHTML = `<i style="background:${m.shield}"></i>${p.name}${p.juvenile ? '<small>（幼）</small>' : ''}`;
      b.classList.toggle('on', p === selected);
      b.addEventListener('click', () => this.app.select(p));
      el.appendChild(b);
    }
  }

  _bird(p) {
    $('b-name').textContent = p.name;
    const sx = $('b-sex');
    sx.textContent = p.sex === 'male' ? '♂ 雄' : '♀ 雌';
    sx.classList.toggle('f', p.sex !== 'male');
    const age = p.juvenile ? `幼鸽 ${Math.round(p.ageDays)} 日龄` : `成鸟 约 ${(p.ageDays / 365).toFixed(1)} 岁`;
    $('b-meta').textContent = `${MORPHS[p.morph].label} · ${age}`;
    let mate = p.mate ? `伴侣：${p.mate.name}` : '单身';
    if (p.pair) {
      mate += ` · ${p.pair.stageLabel}`;
      if (p.pair.eggs.length) mate += ` · ${p.pair.eggs.length} 枚卵`;
      if (p.pair.hatchAt) mate += `（约 ${Math.max(0, (p.pair.hatchAt - p.flock.absHours) / 24).toFixed(1)} 天后破壳）`;
      if (p.pair.squabs.length) mate += ` · 乳鸽 ${p.pair.squabs.map((s) => s.age.toFixed(1) + ' 天').join('、')}`;
    }
    $('b-mate').textContent = mate;
    const cur = p.brain.current;
    let label = cur ? cur.label : '—';
    if (p.flight) label += ` · ${FLIGHT_PHASE[p.flight.phase] || ''}`;
    $('b-behavior').textContent = label;
    $('b-thought').textContent = p.thought;

    const needs = [
      ['能量储备', p.nutrition, '#7fd1b9', `${Math.round(p.nutrition * 100)}%`],
      ['嗉囊', p.cropG / BIO.cropCapacityG, '#e3b85a', `${p.cropG.toFixed(1)}g`],
      ['水分', p.hydration, '#6fb4f2', `${Math.round(p.hydration * 100)}%`],
      ['精力', p.energy, '#f2d36f', `${Math.round(p.energy * 100)}%`],
      ['羽毛整洁', p.hygiene, '#c9d3e0', `${Math.round(p.hygiene * 100)}%`],
      ['恐惧', p.fear, '#f27a7a', `${Math.round(p.fear * 100)}%`],
      ['孤独', p.lonely, '#a0a8b8', `${Math.round(p.lonely * 100)}%`],
      ['繁殖驱力', p.breedDrive, '#f29ac4', `${Math.round(p.breedDrive * 100)}%`],
    ];
    if (p.wet > 0.02) needs.push(['羽毛湿度', p.wet, '#5aa0e6', `${Math.round(p.wet * 100)}%`]);
    $('b-needs').innerHTML = needs.map(([n, v, c, t]) => `
      <div class="bar"><span>${n}</span><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(1, v)) * 100}%;background:${c}"></div></div><span class="v">${t}</span></div>`).join('');

    const alt = p.pos.y;
    $('b-phys').innerHTML = [
      ['心率', `${Math.round(p.heartRate)} 次/分`],
      ['呼吸', `${Math.round(p.respRate)} 次/分`],
      ['体温', `${p.bodyTemp.toFixed(1)} °C`],
      ['体重', `${Math.round(p.massKg * 1000 + p.cropG)} g`],
      ['状态', `${MODE_LABEL[p.mode]}${alt > 0.3 ? ` · ${alt.toFixed(1)} m` : ''}`],
      ['速度', `${(p.mode === 'air' ? p.vel.length() * 3.6 / 0.55 : p.speed * 3.6).toFixed(1)} km/h`],
    ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');

    const curKey = cur?.name;
    const scores = p.brain.scores.slice(0, 7);
    const max = Math.max(1, ...scores.map((s) => s.s));
    $('b-scores').innerHTML = scores.map((s) => `
      <div class="score ${s.key === curKey ? 'cur' : ''}"><span>${s.label}</span><div class="track"><div class="fill" style="width:${(s.s / max) * 100}%"></div></div><span class="v">${s.s.toFixed(2)}</span></div>`).join('')
      || `<div class="score"><span>${p.mode === 'air' ? '（飞行中，专注于飞行）' : '—'}</span></div>`;

    const st = p.stats;
    $('b-stats').innerHTML = [
      ['进食', `${st.eatenG.toFixed(1)} g · ${st.seeds} 粒`],
      ['饮水', `${st.drankMl.toFixed(0)} ml`],
      ['啄击', `${st.pecks} 次`],
      ['步数', `${Math.round(st.steps)} 步`],
      ['飞行', `${(st.flownM / 0.55).toFixed(0)} m · ${st.flights} 次`],
      ['咕咕', `${st.coos} 声`],
      ['理羽', `${Math.round(st.preenS)} 秒`],
      ['睡眠', `${st.sleepH.toFixed(1)} 小时`],
    ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
    $('b-log').innerHTML = p.log.slice(0, 10).map((l) => `<li>${l}</li>`).join('');
  }
}
