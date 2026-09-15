/**
 * leadership.js: Leadership dashboard (#/leadership).
 *
 * Team-wide field sales performance: AI insights and stale orders (current state), then a
 * date-range filter that scopes the KPIs, revenue trend, quota attainment by rep, pipeline
 * by stage, revenue by region and the rep leaderboard.
 */
import { api } from './api.js';
import { ageLabel, escapeHtml, formatDate, initials, money, moneyAxis, moneyCompact, number, pct, pill } from './format.js';
import { barChart, columnChart, meterHtml, renderChart, statTile } from './charts.js';
import { showToast } from './ui.js';

const RANGES = [
  { days: 7, label: 'Last 7 days', short: '7 days' },
  { days: 28, label: 'Last 4 weeks', short: '4 weeks' },
  { days: 84, label: 'Last 12 weeks', short: '12 weeks' },
];
const STAGE_COLORS = {
  New: '--ordinal-1', Processing: '--ordinal-2', Shipped: '--ordinal-3', Delivered: '--ordinal-4', Cancelled: '--mark-muted',
};
const SHORT_DATE = { month: 'short', day: 'numeric' };

let days = 28;
let token = 0;

const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

export async function renderLeadership(root) {
  document.title = 'Leadership · OrderDesk';
  if (!root.dataset.ready) {
    root.innerHTML = skeleton();
    wire(root);
    root.dataset.ready = 'true';
  }
  const my = ++token;
  root.classList.add('is-loading'); // refetch keeps the previous frame, dimmed
  try {
    const [dashboard, insights] = await Promise.all([api.leadership(days), api.insights()]);
    if (my !== token) return;
    fill(root, dashboard, insights);
  } catch (err) {
    if (my === token) showToast(`Could not load the leadership dashboard: ${err.message}`, 'error');
  } finally {
    if (my === token) root.classList.remove('is-loading');
  }
}

function skeleton() {
  return `
    <div class="page-head">
      <div>
        <h2 class="page-title">Leadership dashboard</h2>
        <p class="page-sub">Field sales performance across every rep and region</p>
      </div>
    </div>

    <div class="grid-2 grid-top">
      <section class="card insights" aria-labelledby="ld-insights">
        <div class="insights-head">
          <h3 id="ld-insights" class="eyebrow">✦ AI Insights</h3>
          <span class="chip chip-light">All orders</span>
        </div>
        <p class="insights-summary" data-slot="insights" aria-live="polite">Loading insights…</p>
      </section>
      <section class="card attention" aria-labelledby="ld-attention">
        <div class="card-head">
          <h3 id="ld-attention">Needs attention <span class="muted" data-slot="attention-count"></span></h3>
          <span class="chip">Right now</span>
        </div>
        <ul class="attention-list" data-slot="attention"></ul>
      </section>
    </div>

    <div class="filter-row">
      <div class="segmented" role="group" aria-label="Date range" data-slot="ranges">
        ${RANGES.map((r) => `<button type="button" class="segment" data-days="${r.days}" aria-pressed="${r.days === days}">${r.label}</button>`).join('')}
      </div>
      <span class="range-note muted" data-slot="range-note"></span>
    </div>

    <div class="kpi-row" data-slot="kpis"></div>

    <div class="grid-2">
      <div data-slot="chart-trend"></div>
      <div data-slot="chart-attainment"></div>
      <div data-slot="chart-pipeline"></div>
      <div data-slot="chart-regions"></div>
    </div>

    <section class="card" aria-labelledby="ld-leaderboard">
      <div class="card-head">
        <h3 id="ld-leaderboard">Rep leaderboard</h3>
        <span class="muted">Same date range · select a rep to open their dashboard</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>Rep</th>
              <th class="col-hide-sm">Region</th>
              <th class="num">Orders</th>
              <th class="num">Booked revenue</th>
              <th class="num col-hide-sm">Quota</th>
              <th>Attainment</th>
              <th class="num col-hide-sm">Avg order</th>
              <th class="num">Open</th>
              <th class="num">Stale</th>
            </tr>
          </thead>
          <tbody data-slot="leaderboard"></tbody>
        </table>
      </div>
    </section>`;
}

function wire(root) {
  slot(root, 'ranges').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]');
    if (!button || Number(button.dataset.days) === days) return;
    days = Number(button.dataset.days);
    renderLeadership(root);
  });
}

function fill(root, dashboard, insights) {
  const range = RANGES.find((r) => r.days === days);
  slot(root, 'ranges').querySelectorAll('button').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.days) === days));
  });
  slot(root, 'range-note').textContent =
    `${formatDate(dashboard.range.start, SHORT_DATE)} – ${formatDate(dashboard.range.end, SHORT_DATE)} · compared with the previous ${range.short}`;

  slot(root, 'insights').textContent = insights.summary;
  fillAttention(root, dashboard.attention);
  fillKpis(slot(root, 'kpis'), dashboard.kpis, range);
  fillCharts(root, dashboard, range);
  fillLeaderboard(slot(root, 'leaderboard'), dashboard.reps);
}

function fillAttention(root, attention) {
  slot(root, 'attention-count').textContent = attention.total ? `(${number(attention.total)})` : '';
  const list = slot(root, 'attention');
  if (attention.total === 0) {
    list.innerHTML = `<li class="attention-empty">No open orders waiting more than ${attention.stale_hours}h.</li>`;
    return;
  }
  const shown = attention.orders.slice(0, 5);
  list.innerHTML = shown.map((o) => `
    <li>
      <a class="attention-item" href="#/orders/${o.id}">
        <span class="attention-flag" aria-hidden="true">!</span>
        <span class="attention-main">
          <strong>#${o.id} · ${escapeHtml(o.customer_name)}</strong>
          <span class="attention-meta">${escapeHtml(o.rep_name)} · ${money(o.total)} · ${pill(o.status)}</span>
        </span>
        <span class="attention-age">No update for ${ageLabel(o.hours_since_update)}</span>
      </a>
    </li>`).join('')
    + (attention.total > shown.length ? `<li class="attention-more">+ ${number(attention.total - shown.length)} more open orders waiting</li>` : '');
}

function fillKpis(container, k, range) {
  const vs = `vs previous ${range.short}`;
  container.innerHTML = [
    statTile({ label: 'Booked revenue', value: moneyCompact(k.revenue), delta: { value: k.revenue_change_pct }, sub: vs }),
    statTile({ label: 'Quota attainment', value: pct(k.attainment), meter: k.attainment, sub: `${moneyCompact(k.revenue)} of ${moneyCompact(k.quota)} prorated quota` }),
    statTile({ label: 'Orders', value: number(k.orders), delta: { value: k.orders_change_pct }, sub: vs }),
    statTile({ label: 'Avg order value', value: money(k.avg_order_value), delta: { value: k.avg_order_value_change_pct }, sub: vs }),
    statTile({ label: 'Open pipeline', value: moneyCompact(k.open_pipeline_value), sub: `${number(k.open_orders)} orders New or Processing` }),
    statTile({ label: 'Captured offline', value: pct(k.offline_share), delta: { value: k.offline_share_change_pts, unit: ' pts', polarity: 'neutral' }, sub: 'Placed without signal, synced later' }),
  ].join('');
}

function fillCharts(root, dashboard, range) {
  const weekly = dashboard.trend.granularity === 'week';
  const trendPoints = dashboard.trend.points.map((p) => ({
    label: formatDate(p.start, SHORT_DATE),
    tooltipLabel: weekly ? `Week of ${formatDate(p.start, SHORT_DATE)}` : formatDate(p.start, { weekday: 'short', month: 'short', day: 'numeric' }),
    value: p.revenue,
    valueLabel: money(p.revenue),
    detail: `${number(p.orders)} orders`,
  }));
  renderChart(slot(root, 'chart-trend'), {
    title: `Booked revenue by ${weekly ? 'week' : 'day'}`,
    subtitle: `${range.label}, excluding cancelled orders`,
    table: {
      columns: [{ label: weekly ? 'Week starting' : 'Day' }, { label: 'Booked revenue', numeric: true }, { label: 'Orders', numeric: true }],
      rows: dashboard.trend.points.map((p) => [formatDate(p.start, SHORT_DATE), money(p.revenue), number(p.orders)]),
    },
    draw: columnChart({ points: trendPoints, formatTick: moneyAxis, ariaLabel: `Booked revenue by ${weekly ? 'week' : 'day'}` }),
  });

  const byAttainment = [...dashboard.reps].sort((a, b) => (b.attainment ?? 0) - (a.attainment ?? 0));
  renderChart(slot(root, 'chart-attainment'), {
    title: 'Quota attainment by rep',
    subtitle: `Booked revenue vs quota prorated to ${range.short}`,
    table: {
      columns: [{ label: 'Rep' }, { label: 'Region' }, { label: 'Attainment', numeric: true }, { label: 'Booked revenue', numeric: true }, { label: 'Quota', numeric: true }],
      rows: byAttainment.map((r) => [r.name, r.region, pct(r.attainment), money(r.revenue), money(r.quota)]),
    },
    draw: barChart({
      ariaLabel: 'Quota attainment by rep',
      reference: { value: 1, label: '100% of quota' },
      max: 1.2,
      rows: byAttainment.map((r) => ({
        label: r.name,
        sublabel: r.region,
        value: r.attainment ?? 0,
        valueLabel: pct(r.attainment),
        detail: `${money(r.revenue)} of ${money(r.quota)} · ${number(r.orders)} orders`,
        href: `#/rep/${r.id}`,
      })),
    }),
  });

  renderChart(slot(root, 'chart-pipeline'), {
    title: 'Order value by stage',
    subtitle: `Orders created in the ${range.label.toLowerCase()}`,
    table: {
      columns: [{ label: 'Stage' }, { label: 'Orders', numeric: true }, { label: 'Order value', numeric: true }],
      rows: dashboard.pipeline.map((s) => [s.status, number(s.orders), money(s.value)]),
    },
    draw: barChart({
      ariaLabel: 'Order value by stage',
      rows: dashboard.pipeline.map((s) => ({
        label: s.status,
        sublabel: `${number(s.orders)} orders`,
        value: s.value,
        valueLabel: moneyCompact(s.value),
        detail: `${number(s.orders)} orders · ${money(s.value)}`,
        colorVar: STAGE_COLORS[s.status],
      })),
    }),
  });

  renderChart(slot(root, 'chart-regions'), {
    title: 'Booked revenue by region',
    subtitle: range.label,
    table: {
      columns: [{ label: 'Region' }, { label: 'Reps', numeric: true }, { label: 'Booked revenue', numeric: true }, { label: 'Attainment', numeric: true }],
      rows: dashboard.regions.map((r) => [r.region, number(r.reps), money(r.revenue), pct(r.attainment)]),
    },
    draw: barChart({
      ariaLabel: 'Booked revenue by region',
      rows: dashboard.regions.map((r) => ({
        label: r.region,
        sublabel: `${r.reps} rep${r.reps === 1 ? '' : 's'}`,
        value: r.revenue,
        valueLabel: moneyCompact(r.revenue),
        detail: `${pct(r.attainment)} of quota · ${number(r.orders)} orders`,
      })),
    }),
  });
}

function fillLeaderboard(tbody, reps) {
  tbody.innerHTML = reps.map((r, i) => `
    <tr>
      <td class="num muted">${i + 1}</td>
      <td><a class="rep-cell" href="#/rep/${r.id}"><span class="avatar-sm" aria-hidden="true">${escapeHtml(initials(r.name))}</span>${escapeHtml(r.name)}</a></td>
      <td class="col-hide-sm">${escapeHtml(r.region)}</td>
      <td class="num">${number(r.orders)}</td>
      <td class="num">${money(r.revenue)}</td>
      <td class="num col-hide-sm">${money(r.quota)}</td>
      <td><div class="attain-cell">${meterHtml(r.attainment, { label: `${r.name} quota attainment` })}<span class="num">${pct(r.attainment)}</span></div></td>
      <td class="num col-hide-sm">${money(r.avg_order_value)}</td>
      <td class="num">${number(r.open_orders)}</td>
      <td class="num">${r.stale_orders ? `<span class="stale-badge"><span aria-hidden="true">!</span>${number(r.stale_orders)}</span>` : '<span class="muted">0</span>'}</td>
    </tr>`).join('');
}
