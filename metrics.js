/**
 * metrics.js: sales metrics for the Leadership and Sales Rep dashboards.
 *
 * Pure functions over plain order and rep objects (as returned by store.js), so the
 * REST API and the MCP server always compute identical numbers.
 *
 * Definitions:
 *   revenue (booked value)  total of every order that isn't Cancelled
 *   open                    New or Processing
 *   stale                   open with no update for STALE_HOURS or more
 *   quota                   monthly quota prorated to the window (monthly_quota × days / 30)
 */
const { STATUSES, OPEN_STATUSES, REGIONS } = require('./store');

const HOUR = 36e5;
const DAY = 24 * HOUR;
const STALE_HOURS = 48;

const round = (n, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
};
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
const iso = (ms) => new Date(ms).toISOString();
const isBooked = (o) => o.status !== 'Cancelled';
const isOpen = (o) => OPEN_STATUSES.includes(o.status);
const changePct = (current, previous) => (previous > 0 ? round(((current - previous) / previous) * 100, 1) : null);
const ratio = (part, whole) => (whole > 0 ? round(part / whole, 4) : null);

/** Orders created in [start, end). */
const createdIn = (orders, start, end) =>
  orders.filter((o) => {
    const t = Date.parse(o.created_at);
    return t >= start && t < end;
  });

const formatMoney = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const formatPct = (r) => (r === null || r === undefined ? 'n/a' : `${Math.round(r * 100)}%`);

function summarize(orders) {
  const booked = orders.filter(isBooked);
  const revenue = round(sum(booked, (o) => o.total));
  return {
    orders: orders.length,
    revenue,
    units: sum(orders, (o) => o.quantity),
    avg_order_value: booked.length ? round(revenue / booked.length) : 0,
    offline_share: ratio(orders.filter((o) => o.placed_offline).length, orders.length) ?? 0,
  };
}

/** Open orders with no update for `hours` or more, longest-waiting first. */
function staleOrders(orders, { now = Date.now(), hours = STALE_HOURS } = {}) {
  return orders
    .filter((o) => isOpen(o) && now - Date.parse(o.updated_at) >= hours * HOUR)
    .map((o) => ({ ...o, hours_since_update: Math.floor((now - Date.parse(o.updated_at)) / HOUR) }))
    .sort((a, b) => b.hours_since_update - a.hours_since_update);
}

/** Booked revenue per bucket (daily up to 14 days, weekly beyond), oldest first. */
function revenueTrend(orders, { start, end, days }) {
  const bucketDays = days <= 14 ? 1 : 7;
  const count = Math.ceil(days / bucketDays);
  const points = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const bucketEnd = end - i * bucketDays * DAY;
    const bucketStart = Math.max(start, bucketEnd - bucketDays * DAY);
    const inBucket = createdIn(orders, bucketStart, bucketEnd);
    points.push({
      start: iso(bucketStart),
      end: iso(bucketEnd),
      partial: bucketEnd - bucketStart < bucketDays * DAY,
      revenue: round(sum(inBucket.filter(isBooked), (o) => o.total)),
      orders: inBucket.length,
    });
  }
  return { granularity: bucketDays === 1 ? 'day' : 'week', points };
}

/**
 * Team-wide view for sales leadership over the last `days` (compared with the `days` before).
 * Everything except `attention` is scoped to orders created in the window; `attention`
 * is the current list of stale open orders regardless of when they were created.
 */
function leadershipDashboard(orders, reps, { days = 28, now = Date.now() } = {}) {
  const end = now + 1; // include orders created this millisecond
  const start = end - days * DAY;
  const current = createdIn(orders, start, end);
  const previous = createdIn(orders, start - days * DAY, start);
  const cur = summarize(current);
  const prev = summarize(previous);

  const repRows = reps
    .map((rep) => {
      const mine = current.filter((o) => o.rep_id === rep.id);
      const s = summarize(mine);
      const quota = round((rep.monthly_quota * days) / 30);
      return {
        id: rep.id,
        name: rep.name,
        region: rep.region,
        orders: s.orders,
        revenue: s.revenue,
        avg_order_value: s.avg_order_value,
        quota,
        attainment: ratio(s.revenue, quota),
        open_orders: mine.filter(isOpen).length,
        stale_orders: staleOrders(orders.filter((o) => o.rep_id === rep.id), { now }).length,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const regionRows = REGIONS
    .map((region) => {
      const rows = repRows.filter((r) => r.region === region);
      const revenue = round(sum(rows, (r) => r.revenue));
      const quota = round(sum(rows, (r) => r.quota));
      return { region, revenue, orders: sum(rows, (r) => r.orders), quota, attainment: ratio(revenue, quota), reps: rows.length };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const openCurrent = current.filter(isOpen);
  const quota = round(sum(repRows, (r) => r.quota));
  const stale = staleOrders(orders, { now });

  return {
    range: { days, start: iso(start), end: iso(now) },
    kpis: {
      revenue: cur.revenue,
      revenue_change_pct: changePct(cur.revenue, prev.revenue),
      orders: cur.orders,
      orders_change_pct: changePct(cur.orders, prev.orders),
      avg_order_value: cur.avg_order_value,
      avg_order_value_change_pct: changePct(cur.avg_order_value, prev.avg_order_value),
      quota,
      attainment: ratio(cur.revenue, quota),
      open_orders: openCurrent.length,
      open_pipeline_value: round(sum(openCurrent, (o) => o.total)),
      offline_share: cur.offline_share,
      offline_share_change_pts: previous.length ? round((cur.offline_share - prev.offline_share) * 100, 1) : null,
    },
    trend: revenueTrend(current, { start, end, days }),
    reps: repRows,
    regions: regionRows,
    pipeline: STATUSES.map((status) => {
      const inStatus = current.filter((o) => o.status === status);
      return { status, orders: inStatus.length, value: round(sum(inStatus, (o) => o.total)) };
    }),
    attention: { stale_hours: STALE_HOURS, total: stale.length, orders: stale.slice(0, 10) },
  };
}

/** One rep's view: month-to-date quota pace, last 30 days, open work and follow-ups. */
function repDashboard(orders, reps, repId, { now = Date.now() } = {}) {
  const rep = reps.find((r) => r.id === repId);
  if (!rep) return null;

  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const end = now + 1;
  const monthElapsed = (now - monthStart) / (monthEnd - monthStart);
  const daysInMonth = Math.round((monthEnd - monthStart) / DAY);

  const monthOrders = createdIn(orders, monthStart, end);
  const standings = reps
    .map((r) => {
      const revenue = round(sum(monthOrders.filter((o) => o.rep_id === r.id && isBooked(o)), (o) => o.total));
      return { id: r.id, revenue, attainment: ratio(revenue, r.monthly_quota) ?? 0 };
    })
    .sort((a, b) => b.attainment - a.attainment);
  const me = standings.find((r) => r.id === rep.id);

  const expected = round(rep.monthly_quota * monthElapsed);
  let pace = null;
  if (rep.monthly_quota > 0) {
    if (me.revenue >= expected) pace = 'on_track';
    else if (me.revenue >= expected * 0.8) pace = 'at_risk';
    else pace = 'behind';
  }

  const mine = orders.filter((o) => o.rep_id === rep.id);
  const last30 = summarize(createdIn(mine, end - 30 * DAY, end));
  const prev30 = summarize(createdIn(mine, end - 60 * DAY, end - 30 * DAY));
  const open = mine.filter(isOpen);
  const stale = staleOrders(mine, { now });

  return {
    rep,
    month: {
      start: iso(monthStart),
      days_in_month: daysInMonth,
      days_elapsed: round(monthElapsed * daysInMonth, 1),
      revenue: me.revenue,
      orders: monthOrders.filter((o) => o.rep_id === rep.id).length,
      quota: rep.monthly_quota,
      attainment: ratio(me.revenue, rep.monthly_quota),
      expected_to_date: expected,
      pace,
      team_rank: standings.findIndex((r) => r.id === rep.id) + 1,
      team_size: reps.length,
    },
    last_30_days: { ...last30, revenue_change_pct: changePct(last30.revenue, prev30.revenue) },
    open: { orders: open.length, value: round(sum(open, (o) => o.total)) },
    attention: { stale_hours: STALE_HOURS, total: stale.length, orders: stale.slice(0, 10) },
  };
}

module.exports = {
  STALE_HOURS,
  leadershipDashboard,
  repDashboard,
  staleOrders,
  formatMoney,
  formatPct,
};
