/**
 * charts.js: small, dependency-free chart components for the dashboards.
 *
 * Built to the dataviz method used for this project:
 *   - thin marks (<= 24px) with 4px rounded data ends, square at the baseline
 *   - solid hairline gridlines, recessive axes, selective direct labels
 *   - every mark has a hover and keyboard-focus tooltip (values lead, labels follow)
 *   - every chart has a table-view twin, so no value is gated behind hover
 *   - text never wears the series color; colors come from validated CSS custom properties
 * Labels are set with textContent (they come from user data).
 */
import { escapeHtml } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** Clean axis maximum and evenly spaced ticks starting at 0. */
export function niceScale(maxValue, tickCount = 4) {
  if (!(maxValue > 0)) return { max: 1, ticks: [0, 1] };
  const rough = maxValue / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(value);
  return { max, ticks };
}

function createTooltip(card) {
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.hidden = true;
  card.append(tip);
  return {
    show(anchor, { value, label, detail }) {
      const strong = document.createElement('strong');
      strong.textContent = value;
      const name = document.createElement('span');
      name.textContent = label;
      tip.replaceChildren(strong, name);
      if (detail) {
        const extra = document.createElement('span');
        extra.className = 'chart-tooltip-detail';
        extra.textContent = detail;
        tip.append(extra);
      }
      tip.hidden = false;
      const cardRect = card.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const left = a.left + a.width / 2 - cardRect.left - tip.offsetWidth / 2;
      tip.style.left = `${Math.max(8, Math.min(left, cardRect.width - tip.offsetWidth - 8))}px`;
      const above = a.top - cardRect.top - tip.offsetHeight - 8;
      tip.style.top = `${above < 8 ? a.bottom - cardRect.top + 8 : above}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function bindHover(target, mark, tooltip, datum) {
  const show = () => { mark.classList.add('is-active'); tooltip.show(mark, datum); };
  const hide = () => { mark.classList.remove('is-active'); tooltip.hide(); };
  target.addEventListener('pointerenter', show);
  target.addEventListener('pointerleave', hide);
  target.addEventListener('focus', show);
  target.addEventListener('blur', hide);
}

function buildTable({ columns, rows }) {
  const table = document.createElement('table');
  table.className = 'data-table';
  const headRow = table.createTHead().insertRow();
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column.label;
    if (column.numeric) th.className = 'num';
    headRow.append(th);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((cell, i) => {
      const td = tr.insertCell();
      td.textContent = cell;
      if (columns[i].numeric) td.className = 'num';
    });
  }
  return table;
}

/**
 * Render a chart card into `container`: title, subtitle, the chart drawn by `draw`, and a
 * "Show table" toggle with the accessible table view. Redraws when the card is resized and
 * remembers chart/table mode across re-renders of the same container.
 */
export function renderChart(container, { title, subtitle, table, draw }) {
  if (container.chartObserver) container.chartObserver.disconnect();
  const tableMode = container.dataset.view === 'table';
  container.replaceChildren();

  const card = document.createElement('section');
  card.className = 'card chart-card';
  const tooltip = createTooltip(card);

  const head = document.createElement('div');
  head.className = 'chart-head';
  const titles = document.createElement('div');
  const heading = document.createElement('h3');
  heading.textContent = title;
  titles.append(heading);
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'chart-sub';
    sub.textContent = subtitle;
    titles.append(sub);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-xs btn-outline';
  head.append(titles, toggle);

  const body = document.createElement('div');
  body.className = 'chart-body';
  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap chart-table';
  tableWrap.append(buildTable(table));

  const setMode = (showTable) => {
    body.hidden = showTable;
    tableWrap.hidden = !showTable;
    toggle.textContent = showTable ? 'Show chart' : 'Show table';
    toggle.setAttribute('aria-pressed', String(showTable));
    container.dataset.view = showTable ? 'table' : 'chart';
    tooltip.hide();
  };
  toggle.addEventListener('click', () => setMode(tableWrap.hidden));

  card.append(head, body, tableWrap);
  container.append(card);
  setMode(tableMode);

  let lastWidth = 0;
  const redraw = () => {
    const width = body.clientWidth;
    if (!width || width === lastWidth) return;
    lastWidth = width;
    draw(body, tooltip, width);
  };
  redraw();
  const observer = new ResizeObserver(() => requestAnimationFrame(redraw));
  observer.observe(body);
  container.chartObserver = observer;
}

/** Vertical columns for one series over time. points: [{ label, value, valueLabel, tooltipLabel, detail }] */
export function columnChart({ points, formatTick, ariaLabel, height = 230 }) {
  return (body, tooltip, fullWidth) => {
    const width = fullWidth - 32; // chart-body horizontal padding
    const margin = { top: 24, right: 8, bottom: 30, left: 56 };
    const plotW = Math.max(width - margin.left - margin.right, 40);
    const plotH = height - margin.top - margin.bottom;
    const { max, ticks } = niceScale(Math.max(0, ...points.map((p) => p.value)));
    const yOf = (v) => margin.top + plotH - (v / max) * plotH;
    const band = plotW / Math.max(points.length, 1);
    const barW = Math.min(24, band * 0.6);

    const svg = svgEl('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': ariaLabel });

    for (const tick of ticks) {
      const y = yOf(tick);
      svg.append(svgEl('line', { class: tick === 0 ? 'axis-line' : 'grid-line', x1: margin.left, x2: margin.left + plotW, y1: y, y2: y }));
      const label = svgEl('text', { class: 'tick', x: margin.left - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = formatTick(tick);
      svg.append(label);
    }

    const labelEvery = Math.max(1, Math.ceil(52 / band));
    const hits = [];
    points.forEach((point, i) => {
      const cx = margin.left + band * i + band / 2;
      const base = yOf(0);
      const top = yOf(point.value);
      const h = base - top;
      let mark = null;
      if (h > 0.5) {
        const r = Math.min(4, h, barW / 2);
        const x0 = cx - barW / 2;
        mark = svgEl('path', {
          class: 'col',
          d: `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${base} Z`,
        });
        svg.append(mark);
      }
      // Label every Nth column counting back from the latest, so the current period always has one
      if ((points.length - 1 - i) % labelEvery === 0) {
        const xLabel = svgEl('text', { class: 'tick', x: cx, y: height - 10, 'text-anchor': 'middle' });
        xLabel.textContent = point.label;
        svg.append(xLabel);
      }
      const hit = svgEl('rect', {
        class: 'hit', x: margin.left + band * i, y: margin.top, width: band, height: plotH,
        tabindex: '0', role: 'img', 'aria-label': `${point.tooltipLabel || point.label}: ${point.valueLabel}`,
      });
      hits.push({ hit, mark, point });
    });

    // Selective direct label: only the most recent period
    const last = points[points.length - 1];
    if (last && last.value > 0) {
      const cx = margin.left + band * (points.length - 1) + band / 2;
      const valueLabel = svgEl('text', {
        class: 'value-label', x: Math.min(cx, width - 4), y: yOf(last.value) - 8,
        'text-anchor': cx + 30 > width ? 'end' : 'middle',
      });
      valueLabel.textContent = last.valueLabel;
      svg.append(valueLabel);
    }

    for (const { hit, mark, point } of hits) {
      svg.append(hit);
      bindHover(hit, mark || hit, tooltip, { value: point.valueLabel, label: point.tooltipLabel || point.label, detail: point.detail });
    }
    body.replaceChildren(svg);
  };
}

/**
 * Horizontal bars (HTML). rows: [{ label, sublabel, value, valueLabel, detail, colorVar, href }]
 * `reference` draws a hairline (e.g. 100% of quota) across every track.
 */
export function barChart({ rows, ariaLabel, max = 0, reference = null }) {
  return (body, tooltip) => {
    const scaleMax = Math.max(max, reference ? reference.value : 0, ...rows.map((r) => r.value)) || 1;
    const list = document.createElement('div');
    list.className = 'bars';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', ariaLabel);

    rows.forEach((row, i) => {
      const item = document.createElement(row.href ? 'a' : 'div');
      item.className = 'bar-row';
      item.setAttribute('role', 'listitem');
      if (row.href) item.href = row.href;
      else item.tabIndex = 0;
      item.setAttribute('aria-label', `${row.label}: ${row.valueLabel}${row.detail ? `, ${row.detail}` : ''}`);

      const label = document.createElement('span');
      label.className = 'bar-label';
      const name = document.createElement('span');
      name.textContent = row.label;
      label.append(name);
      if (row.sublabel) {
        const sub = document.createElement('small');
        sub.textContent = row.sublabel;
        label.append(sub);
      }

      const track = document.createElement('span');
      track.className = 'bar-track';
      const fill = document.createElement('span');
      fill.className = 'bar-fill';
      fill.style.width = `${Math.max(0, Math.min(100, (row.value / scaleMax) * 100))}%`;
      fill.style.background = `var(${row.colorVar || '--series-1'})`;
      track.append(fill);
      if (reference) {
        const ref = document.createElement('span');
        ref.className = 'bar-ref';
        ref.style.left = `${(reference.value / scaleMax) * 100}%`;
        if (i === 0) {
          const refLabel = document.createElement('span');
          refLabel.className = 'bar-ref-label';
          refLabel.textContent = reference.label;
          ref.append(refLabel);
        }
        track.append(ref);
      }

      const value = document.createElement('span');
      value.className = 'bar-value';
      value.textContent = row.valueLabel;

      item.append(label, track, value);
      bindHover(item, row.value > 0 ? fill : track, tooltip, { value: row.valueLabel, label: row.label, detail: row.detail });
      list.append(item);
    });
    body.replaceChildren(list);
  };
}

/** Same-ramp progress meter (fill = series color, track = its light step). */
export function meterHtml(ratio, { label = 'Progress' } = {}) {
  const percent = Math.round((ratio || 0) * 100);
  const clamped = Math.max(0, Math.min(100, percent));
  return `<div class="meter" role="meter" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" `
    + `aria-valuenow="${clamped}" aria-valuetext="${percent}%"><span class="meter-fill" style="width:${clamped}%"></span></div>`;
}

/** Signed delta vs a previous period. Arrow + sign carry direction, so color is never the only cue. */
export function deltaHtml({ value, unit = '%', polarity = 'up-good' }) {
  if (value === null || value === undefined) return '<span class="delta delta-neutral">No prior data</span>';
  const up = value > 0;
  const down = value < 0;
  let tone = 'neutral';
  if (polarity === 'up-good') tone = up ? 'good' : down ? 'bad' : 'neutral';
  const arrow = up ? '▲' : down ? '▼' : '•';
  return `<span class="delta delta-${tone}"><span aria-hidden="true">${arrow}</span> ${up ? '+' : ''}${value}${escapeHtml(unit)}</span>`;
}

/** Stat tile: label · value · optional delta · optional meter · optional sub line. */
export function statTile({ label, value, delta, meter, sub }) {
  return `<div class="stat-tile">
    <span class="stat-tile-label">${escapeHtml(label)}</span>
    <span class="stat-tile-value">${escapeHtml(value)}</span>
    ${delta ? deltaHtml(delta) : ''}
    ${meter !== undefined ? meterHtml(meter, { label }) : ''}
    ${sub ? `<span class="stat-tile-sub">${escapeHtml(sub)}</span>` : ''}
  </div>`;
}
