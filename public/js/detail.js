/**
 * detail.js: order detail view (#/orders/:id) with the one-click status stepper.
 */
import { api } from './api.js';
import { FLOW, escapeHtml, formatDateLong, money, moneyExact, number, pill, relativeTime } from './format.js';
import { showToast } from './ui.js';

let current = null;
let token = 0;

export async function renderDetail(root, ctx, id) {
  const my = ++token;
  current = null;
  const back = ctx.lastListHash();
  const backLabel = back.startsWith('#/rep') ? 'Back to Sales Rep dashboard' : 'Back to Leadership dashboard';
  document.title = `Order #${id} · OrderDesk`;
  root.innerHTML = `
    <a href="${escapeHtml(back)}" class="back-link">← ${backLabel}</a>
    <div data-slot="content"><div class="card empty">Loading order #${id}…</div></div>`;
  if (!root.dataset.wired) {
    wire(root, ctx);
    root.dataset.wired = 'true';
  }

  const content = root.querySelector('[data-slot="content"]');
  try {
    const order = await api.getOrder(id);
    if (my !== token) return;
    current = order;
    draw(content, order);
  } catch (err) {
    if (my !== token) return;
    document.title = 'Order not found · OrderDesk';
    const message = err.status === 404
      ? `Order #${id} doesn't exist. It may have been deleted.`
      : `Could not load order #${id}: ${escapeHtml(err.message)}`;
    content.innerHTML = `
      <div class="card empty" data-slot="missing">
        <p>${message}</p>
        <a href="${escapeHtml(back)}" class="btn btn-outline">${backLabel}</a>
      </div>`;
  }
}

function wire(root, ctx) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !current) return;
    const { action } = button.dataset;
    if (action === 'edit') ctx.openOrderForm({ order: current });
    if (action === 'delete') ctx.deleteOrder(current);
    if (action === 'set-status') changeStatus(root, button.dataset.status);
  });
}

async function changeStatus(root, status) {
  if (!current || current.status === status) return;
  const stepper = root.querySelector('.stepper');
  stepper?.setAttribute('aria-busy', 'true');
  try {
    current = await api.updateOrder(current.id, { status });
    showToast(`Order #${current.id} moved to ${status}`);
    draw(root.querySelector('[data-slot="content"]'), current);
  } catch (err) {
    showToast(`Could not update order #${current.id}: ${err.message}`, 'error');
    stepper?.removeAttribute('aria-busy');
  }
}

function draw(content, o) {
  const cancelled = o.status === 'Cancelled';
  const currentIndex = FLOW.indexOf(o.status); // -1 when cancelled

  const steps = FLOW.map((status, i) => {
    let stepState = 'upcoming';
    if (!cancelled && i < currentIndex) stepState = 'done';
    if (!cancelled && i === currentIndex) stepState = 'current';
    const isCurrent = stepState === 'current';
    return `
      <li class="step step-${stepState}">
        <button type="button" class="step-btn" data-action="set-status" data-status="${status}"
                ${isCurrent ? 'aria-current="step" disabled' : `title="Move to ${status}"`}>
          <span class="step-dot" aria-hidden="true">${stepState === 'done' ? '✓' : i + 1}</span>
          <span class="step-label">${status}</span>
        </button>
      </li>`;
  }).join('');

  const fields = [
    ['Order ID', `#${o.id}`],
    ['Customer', escapeHtml(o.customer_name)],
    ['Product', escapeHtml(o.product)],
    ['Quantity', `${number(o.quantity)} unit${o.quantity === 1 ? '' : 's'}`],
    ['Unit price', moneyExact(o.unit_price)],
    ['Order value', moneyExact(o.total)],
    ['Sales rep', `${escapeHtml(o.rep_name)}<small>${escapeHtml(o.rep_region)} region</small>`],
    ['Captured', o.placed_offline ? 'Offline<small>Synced when the device reconnected</small>' : 'Online'],
    ['Created', `${formatDateLong(o.created_at)}<small>${relativeTime(o.created_at)}</small>`],
    ['Last updated', `${formatDateLong(o.updated_at)}<small>${relativeTime(o.updated_at)}</small>`],
  ];

  content.innerHTML = `
    <section class="card detail-card" aria-labelledby="detail-title">
      <div class="detail-head">
        <div>
          <p class="detail-eyebrow">Order #${o.id}</p>
          <h2 id="detail-title">${number(o.quantity)} × ${escapeHtml(o.product)}</h2>
          <p class="detail-sub">for ${escapeHtml(o.customer_name)} · ${money(o.total)} · placed by ${escapeHtml(o.rep_name)}</p>
        </div>
        <div class="detail-actions">
          <button type="button" class="btn btn-outline" data-action="edit">Edit</button>
          <button type="button" class="btn btn-danger-ghost" data-action="delete">Delete</button>
        </div>
      </div>

      <div class="detail-section">
        <div class="section-label-row">
          <h3 class="section-label">Status</h3>
          ${pill(o.status)}
        </div>
        <ol class="stepper${cancelled ? ' is-cancelled' : ''}" aria-label="Order status">${steps}</ol>
        <div class="stepper-foot">
          <p class="muted">${cancelled ? 'This order is cancelled. Click any step to reopen it.' : 'Click any step to move the order there.'}</p>
          ${cancelled ? '' : '<button type="button" class="btn btn-sm btn-danger-ghost" data-action="set-status" data-status="Cancelled">Cancel order</button>'}
        </div>
      </div>

      <dl class="detail-grid">
        ${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
      </dl>
    </section>`;
}
