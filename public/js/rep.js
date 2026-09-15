/**
 * rep.js: Sales Rep dashboard (#/rep/:id).
 *
 * One field rep's month-to-date quota pace, last 30 days, orders that need follow-up and
 * every order they've placed, with one-click status updates everywhere.
 */
import { api } from './api.js';
import { ageLabel, escapeHtml, formatDate, money, moneyCompact, moneyExact, number, pct, statusClass, statusOptions } from './format.js';
import { meterHtml, statTile } from './charts.js';
import { showToast } from './ui.js';
import { getRememberedRep, rememberRep } from './session.js';

const PACE = {
  on_track: { label: 'On track', tone: 'good', icon: '✓' },
  at_risk: { label: 'At risk', tone: 'warning', icon: '!' },
  behind: { label: 'Behind pace', tone: 'critical', icon: '!' },
};

const state = { repId: null, orders: [] };
let token = 0;

const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

export async function renderRep(root, ctx, { repId }) {
  let reps;
  try {
    reps = await ctx.getReps();
  } catch (err) {
    showToast(`Could not load sales reps: ${err.message}`, 'error');
    return;
  }
  const chosen = reps.find((r) => r.id === repId) || reps.find((r) => r.id === getRememberedRep()) || reps[0];
  if (!chosen) {
    root.innerHTML = '<div class="card empty">No sales reps yet.</div>';
    delete root.dataset.ready;
    return;
  }
  if (chosen.id !== repId) {
    ctx.navigate(`#/rep/${chosen.id}`, { replace: true });
    return;
  }

  rememberRep(chosen.id);
  document.title = `${chosen.name} · OrderDesk`;
  if (!root.dataset.ready) {
    root.innerHTML = skeleton();
    wire(root, ctx);
    root.dataset.ready = 'true';
  }
  state.repId = chosen.id;
  slot(root, 'rep-select').innerHTML = reps
    .map((r) => `<option value="${r.id}"${r.id === chosen.id ? ' selected' : ''}>${escapeHtml(r.name)} · ${escapeHtml(r.region)}</option>`)
    .join('');

  const my = ++token;
  root.classList.add('is-loading');
  try {
    const [dashboard, orders] = await Promise.all([api.repDashboard(chosen.id), api.listOrders({ rep_id: chosen.id })]);
    if (my !== token) return;
    state.orders = orders;
    fillSummary(root, dashboard);
    fillOrders(root);
  } catch (err) {
    if (my === token) showToast(`Could not load the rep dashboard: ${err.message}`, 'error');
  } finally {
    if (my === token) root.classList.remove('is-loading');
  }
}

function skeleton() {
  return `
    <div class="page-head">
      <div>
        <h2 class="page-title">Sales rep dashboard</h2>
        <p class="page-sub">Quota pace, follow-ups and every order placed in the field</p>
      </div>
      <div class="page-actions">
        <label class="viewing-as"><span>Viewing as</span><select data-slot="rep-select"></select></label>
        <button type="button" class="btn btn-amber" data-action="new-order">+ New order</button>
      </div>
    </div>

    <section class="card rep-hero" data-slot="hero" aria-label="Month to date"></section>

    <div class="kpi-row" data-slot="kpis"></div>

    <section class="card attention" aria-labelledby="rep-attention">
      <div class="card-head">
        <h3 id="rep-attention">Needs follow-up <span class="muted" data-slot="attention-count"></span></h3>
        <span class="muted">Open orders with no update in 48h or more</span>
      </div>
      <ul class="attention-list" data-slot="attention"></ul>
    </section>

    <section class="card" aria-labelledby="rep-orders">
      <div class="card-head">
        <h3 id="rep-orders">My orders</h3>
        <span class="muted" data-slot="order-count"></span>
      </div>
      <div class="table-wrap">
        <table class="data-table orders-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Customer</th>
              <th class="col-hide-sm">Product</th>
              <th class="num">Qty</th>
              <th class="num">Value</th>
              <th>Status</th>
              <th class="col-hide-sm">Updated</th>
              <th class="actions"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody data-slot="orders"></tbody>
        </table>
      </div>
      <div class="empty" data-slot="empty" hidden>No orders yet. Click <strong>+ New order</strong> to place one.</div>
    </section>`;
}

function wire(root, ctx) {
  slot(root, 'rep-select').addEventListener('change', (event) => ctx.navigate(`#/rep/${event.target.value}`));
  root.querySelector('[data-action="new-order"]').addEventListener('click', () => ctx.openOrderForm({ defaultRepId: state.repId }));

  // One-click status change from the orders table or the follow-up list
  root.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-action="status"]');
    if (select) changeStatus(root, select);
  });

  slot(root, 'orders').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const order = state.orders.find((o) => o.id === Number(button.dataset.id));
    if (!order) return;
    if (button.dataset.action === 'edit') ctx.openOrderForm({ order });
    if (button.dataset.action === 'delete') ctx.deleteOrder(order);
  });
}

async function changeStatus(root, select) {
  const id = Number(select.dataset.id);
  const order = state.orders.find((o) => o.id === id);
  if (!order) return;
  const previous = order.status;
  const next = select.value;
  syncSelects(root, id, next, true); // optimistic: recolor right away, roll back on failure

  try {
    const updated = await api.updateOrder(id, { status: next });
    Object.assign(order, updated);
    syncSelects(root, id, next, false);
    const cell = slot(root, 'orders').querySelector(`tr[data-id="${id}"] [data-role="updated"]`);
    if (cell) {
      cell.textContent = formatDate(updated.updated_at);
      cell.title = updated.updated_at;
    }
    showToast(`Order #${id} moved to ${next}`);
    refreshSummary(root);
  } catch (err) {
    syncSelects(root, id, previous, false);
    showToast(`Could not update order #${id}: ${err.message}`, 'error');
  }
}

/** Keep every dropdown for the same order (table + follow-ups) in step. */
function syncSelects(root, id, status, saving) {
  root.querySelectorAll(`select[data-action="status"][data-id="${id}"]`).forEach((s) => {
    s.value = status;
    s.className = `status-select ${statusClass(status)}${saving ? ' is-saving' : ''}`;
  });
}

async function refreshSummary(root) {
  const repId = state.repId;
  try {
    const dashboard = await api.repDashboard(repId);
    if (repId === state.repId) fillSummary(root, dashboard);
  } catch { /* keep the previous numbers */ }
}

function fillSummary(root, d) {
  const m = d.month;
  const monthName = new Date(m.start).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const pace = PACE[m.pace];

  slot(root, 'hero').innerHTML = `
    <div class="hero-main">
      <span class="hero-label">${escapeHtml(monthName)} revenue to date</span>
      <span class="hero-figure">${money(m.revenue)}</span>
      ${meterHtml(m.attainment, { label: 'Monthly quota attainment' })}
      <span class="hero-sub"><strong>${pct(m.attainment)}</strong> of ${money(m.quota)} monthly quota · ${money(m.expected_to_date)} expected by today</span>
    </div>
    <div class="hero-side">
      ${pace ? `<span class="status-label status-${pace.tone}"><span class="status-icon" aria-hidden="true">${pace.icon}</span>${pace.label}</span>` : ''}
      <div class="hero-stat"><strong>#${m.team_rank} of ${m.team_size}</strong><span>Team rank by attainment</span></div>
      <div class="hero-stat"><strong>${number(m.orders)}</strong><span>Orders this month</span></div>
      <div class="hero-stat"><strong>${number(d.attention.total)}</strong><span>Need follow-up</span></div>
      <div class="hero-stat"><strong>${Math.floor(m.days_elapsed)} / ${m.days_in_month}</strong><span>Days into the month</span></div>
    </div>`;

  const l = d.last_30_days;
  slot(root, 'kpis').innerHTML = [
    statTile({ label: 'Booked revenue (30 days)', value: moneyCompact(l.revenue), delta: { value: l.revenue_change_pct }, sub: 'vs previous 30 days' }),
    statTile({ label: 'Orders (30 days)', value: number(l.orders), sub: `${number(l.units)} units` }),
    statTile({ label: 'Avg order value', value: money(l.avg_order_value), sub: 'Last 30 days, excluding cancelled' }),
    statTile({ label: 'Open pipeline', value: moneyCompact(d.open.value), sub: `${number(d.open.orders)} orders New or Processing` }),
    statTile({ label: 'Captured offline', value: pct(l.offline_share), sub: 'Last 30 days, synced after reconnecting' }),
  ].join('');

  slot(root, 'attention-count').textContent = d.attention.total ? `(${number(d.attention.total)})` : '';
  slot(root, 'attention').innerHTML = d.attention.total === 0
    ? `<li class="attention-empty">Nothing waiting: every open order was updated in the last ${d.attention.stale_hours}h.</li>`
    : d.attention.orders.map((o) => `
      <li class="attention-item">
        <span class="attention-flag" aria-hidden="true">!</span>
        <span class="attention-main">
          <a class="order-link" href="#/orders/${o.id}"><strong>#${o.id} · ${escapeHtml(o.customer_name)}</strong></a>
          <span class="attention-meta">${number(o.quantity)} × ${escapeHtml(o.product)} · ${money(o.total)} · No update for ${ageLabel(o.hours_since_update)}</span>
        </span>
        <select class="status-select ${statusClass(o.status)}" data-action="status" data-id="${o.id}" aria-label="Status for order #${o.id}">${statusOptions(o.status)}</select>
      </li>`).join('');
}

function fillOrders(root) {
  const orders = state.orders;
  slot(root, 'order-count').textContent = `${number(orders.length)} total`;
  slot(root, 'empty').hidden = orders.length > 0;
  slot(root, 'orders').innerHTML = orders.map((o) => `
    <tr data-id="${o.id}">
      <td class="muted"><a class="order-link" href="#/orders/${o.id}">#${o.id}</a></td>
      <td class="strong"><a class="order-link" href="#/orders/${o.id}">${escapeHtml(o.customer_name)}</a>${o.placed_offline ? '<span class="offline-chip" title="Placed offline and synced later">Offline</span>' : ''}</td>
      <td class="col-hide-sm">${escapeHtml(o.product)}</td>
      <td class="num">${number(o.quantity)}</td>
      <td class="num">${moneyExact(o.total)}</td>
      <td><select class="status-select ${statusClass(o.status)}" data-action="status" data-id="${o.id}" aria-label="Status for order #${o.id}">${statusOptions(o.status)}</select></td>
      <td class="muted col-hide-sm" data-role="updated" title="${escapeHtml(o.updated_at)}">${formatDate(o.updated_at)}</td>
      <td class="actions">
        <a class="btn btn-sm btn-outline" href="#/orders/${o.id}">View</a>
        <button type="button" class="btn btn-sm btn-outline" data-action="edit" data-id="${o.id}">Edit</button>
        <button type="button" class="btn btn-sm btn-danger-ghost" data-action="delete" data-id="${o.id}">Delete</button>
      </td>
    </tr>`).join('');
}
