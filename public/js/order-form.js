/**
 * order-form.js: the New / Edit order modal.
 */
import { api } from './api.js';
import { escapeHtml, moneyExact, statusOptions } from './format.js';
import { showToast } from './ui.js';

let els;
let editing = null;       // order being edited, or null when creating
let onSaved = () => {};
let products = null;      // catalog, loaded once
let priceAutofilled = false;

export function initOrderForm({ saved }) {
  onSaved = saved;
  const $ = (selector) => document.querySelector(selector);
  els = {
    dialog: $('#order-dialog'),
    form: $('#order-form'),
    title: $('#dialog-title'),
    errors: $('#form-errors'),
    save: $('#save-btn'),
    cancel: $('#cancel-btn'),
    preview: $('#value-preview'),
    productOptions: $('#product-options'),
  };
  els.form.elements.status.innerHTML = statusOptions('New');

  els.cancel.addEventListener('click', () => els.dialog.close());
  els.dialog.addEventListener('click', (event) => {
    if (event.target === els.dialog) els.dialog.close(); // backdrop click
  });
  els.form.addEventListener('input', (event) => {
    if (event.target.name === 'product') autofillPrice();
    if (event.target.name === 'unit_price') priceAutofilled = false;
    updatePreview();
  });
  els.form.addEventListener('submit', handleSubmit);
}

export async function openOrderForm({ order = null, reps, defaultRepId }) {
  editing = order;
  priceAutofilled = false;
  const f = els.form.elements;
  f.rep_id.innerHTML = reps
    .map((r) => `<option value="${r.id}">${escapeHtml(r.name)} · ${escapeHtml(r.region)}</option>`)
    .join('');

  els.title.textContent = order ? `Edit Order #${order.id}` : 'New Order';
  els.save.textContent = order ? 'Save Changes' : 'Create Order';
  f.customer_name.value = order ? order.customer_name : '';
  f.product.value = order ? order.product : '';
  f.quantity.value = order ? order.quantity : 1;
  f.unit_price.value = order ? order.unit_price : '';
  f.status.value = order ? order.status : 'New';
  f.rep_id.value = String(order ? order.rep_id : defaultRepId ?? reps[0]?.id);
  f.placed_offline.checked = order ? order.placed_offline : false;
  showErrors([]);
  updatePreview();
  els.dialog.showModal();
  f.customer_name.focus();

  if (!products) {
    try {
      products = await api.listProducts();
      els.productOptions.innerHTML = products.map((p) => `<option value="${escapeHtml(p.product)}"></option>`).join('');
    } catch { /* suggestions are optional */ }
  }
}

/** Prefill the list price when a catalog product is chosen and the price is empty or was autofilled. */
function autofillPrice() {
  const f = els.form.elements;
  const match = (products || []).find((p) => p.product.toLowerCase() === f.product.value.trim().toLowerCase());
  if (match && (f.unit_price.value === '' || priceAutofilled)) {
    f.unit_price.value = match.unit_price;
    priceAutofilled = true;
  }
}

function readForm() {
  const f = els.form.elements;
  // Empty on create: leave the field out so the API reports "is required".
  // Empty on edit: send null so the API rejects clearing it instead of silently keeping the old value.
  const toNumber = (value) => {
    if (value === '') return editing ? null : undefined;
    return Number(value);
  };
  return {
    customer_name: f.customer_name.value.trim(),
    product: f.product.value.trim(),
    // Send numbers; the API rejects anything invalid with a clear message
    quantity: toNumber(f.quantity.value),
    unit_price: toNumber(f.unit_price.value),
    status: f.status.value,
    rep_id: Number(f.rep_id.value),
    placed_offline: f.placed_offline.checked,
  };
}

function updatePreview() {
  const { quantity, unit_price: price } = readForm();
  const valid = Number.isFinite(quantity) && quantity > 0 && Number.isFinite(price) && price >= 0;
  els.preview.textContent = `Order value: ${valid ? moneyExact(quantity * price) : '–'}`;
}

function showErrors(errors) {
  els.errors.innerHTML = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  els.errors.hidden = errors.length === 0;
}

async function handleSubmit(event) {
  event.preventDefault();
  const data = readForm();

  // When editing, send only the fields that changed (exercises partial PUT)
  let payload = data;
  if (editing) {
    payload = Object.fromEntries(Object.entries(data).filter(([key, value]) => value !== editing[key]));
    if (Object.keys(payload).length === 0) {
      els.dialog.close();
      return;
    }
  }

  els.save.disabled = true;
  try {
    if (editing) {
      const order = await api.updateOrder(editing.id, payload);
      showToast(`Order #${order.id} updated`);
      els.dialog.close();
      onSaved({ order, created: false });
    } else {
      const order = await api.createOrder(payload);
      showToast(`Order #${order.id} created`);
      els.dialog.close();
      onSaved({ order, created: true });
    }
  } catch (err) {
    showErrors(err.errors || [err.message]);
  } finally {
    els.save.disabled = false;
  }
}
