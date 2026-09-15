/**
 * format.js: shared formatting and small HTML helpers.
 */

export const STATUSES = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
export const FLOW = ['New', 'Processing', 'Shipped', 'Delivered']; // happy path shown in the stepper

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdExact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US');

export const money = (n) => usd.format(n || 0);
export const moneyExact = (n) => usdExact.format(n || 0);
/** Compact above $10K ("$212.4K"), whole dollars below. */
export const moneyCompact = (n) => (Math.abs(n || 0) >= 10000 ? usdCompact.format(n) : usd.format(n || 0));
/** Always compact, for axis ticks ("$2.5K"). */
export const moneyAxis = (n) => usdCompact.format(n || 0);
export const number = (n) => integer.format(n || 0);
export const pct = (ratio) => (ratio === null || ratio === undefined ? '–' : `${Math.round(ratio * 100)}%`);

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function formatDate(iso, options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, options);
}

export const formatDateLong = (iso) =>
  formatDate(iso, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function relativeTime(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeFormatter.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** "3d" / "20h" for hours without an update. */
export const ageLabel = (hours) => (hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`);

export const statusClass = (status) => `pill-${String(status).toLowerCase()}`;
export const pill = (status) => `<span class="pill ${escapeHtml(statusClass(status))}">${escapeHtml(status)}</span>`;

export const statusOptions = (selected) =>
  STATUSES.map((s) => `<option value="${s}"${s === selected ? ' selected' : ''}>${s}</option>`).join('');

export const initials = (name) =>
  String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
