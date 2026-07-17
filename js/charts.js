// Minimal SVG time-series charts: a multi-series timeline with crosshair
// tooltip + legend, and tile sparklines with point hover. No dependencies.
//
// Design rules (dataviz method): one axis per chart, series colors assigned
// in fixed order from the validated categorical theme, thin 2px lines,
// recessive grid, hover layer on every plotted form, table view available.

export const SERIES_COLORS = ['#4a88f0', '#0f96da', '#c2568a']; // validated for dark surface

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** Fixed-capacity ring of {t, values[]} samples shared by chart + table. */
export class SeriesStore {
  constructor(names, capacity = 600) {
    this.names = names;
    this.capacity = capacity;
    this.samples = [];
  }

  push(values) {
    this.samples.push({ t: Date.now(), values });
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  clear() {
    this.samples = [];
  }
}

const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

/**
 * Multi-series timeline. Renders into `host` (a sized div). Call update()
 * after pushing samples; hover shows a crosshair + tooltip with all series.
 */
export class TimelineChart {
  constructor(host, store, { unit = '', valueFmt = (v) => v.toFixed(2) } = {}) {
    this.host = host;
    this.store = store;
    this.unit = unit;
    this.valueFmt = valueFmt;
    this.pad = { l: 44, r: 76, t: 10, b: 22 };
    this.svg = el('svg', {
      class: 'chart-svg',
      role: 'img',
      'aria-label': `Timeline chart: ${store.names.join(', ')} — use the Table view for exact values`,
    });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    host.append(this.svg, this.tooltip);
    this.svg.addEventListener('pointermove', (e) => this.#hover(e));
    this.svg.addEventListener('pointerleave', () => this.#unhover());
    new ResizeObserver(() => this.update()).observe(host);
  }

  #scale() {
    const { width, height } = this.host.getBoundingClientRect();
    const s = this.store.samples;
    if (!s.length) return null;
    const t0 = s[0].t;
    const t1 = s[s.length - 1].t;
    let min = Infinity;
    let max = -Infinity;
    for (const smp of s)
      for (const v of smp.values)
        if (v != null) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
    if (!Number.isFinite(min)) return null;
    if (max - min < 0.5) {
      const mid = (max + min) / 2;
      min = mid - 0.25;
      max = mid + 0.25;
    }
    const padY = (max - min) * 0.12;
    min -= padY;
    max += padY;
    const x = (t) => this.pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - this.pad.l - this.pad.r);
    const y = (v) => this.pad.t + (1 - (v - min) / (max - min)) * (height - this.pad.t - this.pad.b);
    return { width, height, t0, t1, min, max, x, y };
  }

  update() {
    const sc = this.#scale();
    this.svg.replaceChildren();
    this.tooltip.hidden = true;
    if (!sc) {
      const { width, height } = this.host.getBoundingClientRect();
      this.svg.setAttribute('viewBox', `0 0 ${Math.max(1, width)} ${Math.max(1, height)}`);
      const empty = el('text', {
        x: width / 2, y: height / 2, class: 'axis-label', 'text-anchor': 'middle',
      });
      empty.textContent = 'waiting for telemetry…';
      this.svg.append(empty);
      return;
    }
    this.sc = sc;
    this.svg.setAttribute('viewBox', `0 0 ${sc.width} ${sc.height}`);

    // grid + y labels (recessive)
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = sc.min + ((sc.max - sc.min) * i) / ticks;
      const yy = sc.y(v);
      this.svg.append(el('line', { x1: this.pad.l, x2: sc.width - this.pad.r, y1: yy, y2: yy, class: 'grid-line' }));
      const label = el('text', { x: this.pad.l - 6, y: yy + 3.5, class: 'axis-label', 'text-anchor': 'end' });
      label.textContent = this.valueFmt(v);
      this.svg.append(label);
    }
    // x labels: first + last (just one while a single sample is on screen)
    const xLabels = sc.t1 !== sc.t0 ? [sc.t0, sc.t1] : [sc.t0];
    xLabels.forEach((t, i) => {
      const label = el('text', {
        x: sc.x(t),
        y: sc.height - 6,
        class: 'axis-label',
        'text-anchor': i === 0 ? 'start' : 'end',
      });
      label.textContent = fmtClock(t);
      this.svg.append(label);
    });

    // series lines
    const endLabels = [];
    this.store.names.forEach((name, si) => {
      const pts = this.store.samples
        .map((s) => (s.values[si] == null ? null : `${sc.x(s.t).toFixed(1)},${sc.y(s.values[si]).toFixed(1)}`))
        .filter(Boolean);
      if (pts.length < 2) return;
      this.svg.append(el('polyline', { points: pts.join(' '), class: 'series-line', stroke: SERIES_COLORS[si] }));
      const last = this.store.samples[this.store.samples.length - 1].values[si];
      if (last != null) endLabels.push({ y: sc.y(last), text: `${name} ${this.valueFmt(last)}` });
    });

    // direct end labels, pushed apart when series run close together
    endLabels.sort((a, b) => a.y - b.y);
    const MIN_GAP = 13;
    for (let i = 1; i < endLabels.length; i++) {
      const prev = endLabels[i - 1];
      const cur = endLabels[i];
      if (cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP;
    }
    for (const { y, text } of endLabels) {
      const label = el('text', { x: sc.width - this.pad.r + 6, y: y + 3.5, class: 'series-end-label' });
      label.textContent = text;
      this.svg.append(label);
    }

    this.cross = el('line', { y1: this.pad.t, y2: sc.height - this.pad.b, class: 'crosshair', visibility: 'hidden' });
    this.svg.append(this.cross);
  }

  #hover(e) {
    const sc = this.sc;
    const s = this.store.samples;
    if (!sc || !s.length) return;
    const rect = this.svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < s.length; i++) {
      const d = Math.abs(sc.x(s[i].t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const smp = s[best];
    const xx = sc.x(smp.t);
    this.cross?.setAttribute('x1', xx);
    this.cross?.setAttribute('x2', xx);
    this.cross?.setAttribute('visibility', 'visible');
    this.tooltip.hidden = false;
    this.tooltip.innerHTML =
      `<div class="tt-time">${fmtClock(smp.t)}</div>` +
      this.store.names
        .map((n, i) =>
          smp.values[i] == null
            ? ''
            : `<div class="tt-row"><i style="background:${SERIES_COLORS[i]}"></i>${n} <b>${this.valueFmt(smp.values[i])}${this.unit}</b></div>`,
        )
        .join('');
    const left = Math.min(xx + 12, rect.width - this.tooltip.offsetWidth - 8);
    this.tooltip.style.left = `${Math.max(0, left)}px`;
    this.tooltip.style.top = '8px';
  }

  #unhover() {
    this.tooltip.hidden = true;
    this.cross?.setAttribute('visibility', 'hidden');
  }
}

/** Single-series sparkline for stat tiles, with nearest-point hover. */
export class Sparkline {
  constructor(host, { color = SERIES_COLORS[0], fmt = (v) => v.toFixed(2), capacity = 120 } = {}) {
    this.host = host;
    this.color = color;
    this.fmt = fmt;
    this.data = [];
    this.capacity = capacity;
    this.svg = el('svg', { class: 'spark-svg' });
    this.tip = document.createElement('div');
    this.tip.className = 'spark-tip';
    this.tip.hidden = true;
    host.append(this.svg, this.tip);
    this.svg.addEventListener('pointermove', (e) => this.#hover(e));
    this.svg.addEventListener('pointerleave', () => {
      this.tip.hidden = true;
      this.dot?.setAttribute('visibility', 'hidden');
    });
  }

  push(v) {
    this.data.push(v);
    if (this.data.length > this.capacity) this.data.shift();
    this.#draw();
  }

  #draw() {
    const { width: w, height: h } = this.host.getBoundingClientRect();
    if (!w || this.data.length < 2) return;
    let min = Math.min(...this.data);
    let max = Math.max(...this.data);
    if (max - min < 1e-6) {
      min -= 0.5;
      max += 0.5;
    }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const x = (i) => (i / (this.data.length - 1)) * (w - 4) + 2;
    const y = (v) => 2 + (1 - (v - min) / (max - min)) * (h - 4);
    this.xy = { x, y };
    const pts = this.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    this.svg.replaceChildren(
      el('polyline', { points: pts, class: 'spark-line', stroke: this.color }),
      (this.dot = el('circle', { r: 3, fill: this.color, visibility: 'hidden' })),
    );
  }

  #hover(e) {
    if (!this.xy || this.data.length < 2) return;
    const rect = this.svg.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - 2) / (rect.width - 4)) * (this.data.length - 1));
    const ci = Math.max(0, Math.min(this.data.length - 1, i));
    this.dot.setAttribute('cx', this.xy.x(ci));
    this.dot.setAttribute('cy', this.xy.y(this.data[ci]));
    this.dot.setAttribute('visibility', 'visible');
    this.tip.textContent = this.fmt(this.data[ci]);
    this.tip.hidden = false;
  }
}

/** Accessible table view of the store (last `rows` samples, newest first). */
export function renderTable(host, store, { rows = 30, valueFmt = (v) => v.toFixed(2) } = {}) {
  const slice = store.samples.slice(-rows).reverse();
  const head = `<tr><th>time</th>${store.names.map((n) => `<th>${n}</th>`).join('')}</tr>`;
  const body = slice
    .map(
      (s) =>
        `<tr><td>${fmtClock(s.t)}</td>${s.values
          .map((v) => `<td>${v == null ? '—' : valueFmt(v)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  host.innerHTML = `<table class="data-table" aria-label="Chart data, newest first"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
