/**
 * insights.js: plain-language summary of orders.
 *
 * Shared by the REST API (GET /api/insights) and the MCP server (get_order_insights),
 * so the web UI and AI agents always describe orders the same way.
 */
const { STATUSES } = require('./store');
const { formatMoney } = require('./metrics');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isAre = (n) => (n === 1 ? 'is' : 'are');

/**
 * Build a plain-language summary of the given orders.
 * Deterministic and rule-based for now. This is the single place where an
 * LLM call could be dropped in to generate richer narrative.
 */
function buildInsights(orders) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const bookedByRep = new Map();
  let units = 0;
  let bookedValue = 0;
  let largest = null;

  for (const order of orders) {
    byStatus[order.status] += 1;
    units += order.quantity;
    if (order.status !== 'Cancelled') {
      bookedValue += order.total;
      if (order.rep_name) bookedByRep.set(order.rep_name, (bookedByRep.get(order.rep_name) || 0) + order.total);
    }
    if (!largest || order.total > largest.total) largest = order;
  }

  const total = orders.length;
  const open = byStatus.New + byStatus.Processing;
  bookedValue = Math.round(bookedValue * 100) / 100;

  if (total === 0) {
    return {
      summary: 'You have no orders yet. Create your first order to see insights here.',
      byStatus, total, units, open, booked_value: 0, largestOrder: null, topRep: null,
    };
  }

  const sentences = [
    `You have ${plural(total, 'order')} totalling ${plural(units, 'unit')} and ${formatMoney(bookedValue)} in booked value.`,
  ];

  if (open > 0) {
    const detail = ['New', 'Processing']
      .filter((s) => byStatus[s] > 0)
      .map((s) => `${byStatus[s]} ${s}`)
      .join(', ');
    sentences.push(`${open} ${isAre(open)} still open (${detail}).`);
  } else {
    sentences.push('Nothing is waiting to be processed.');
  }

  const progress = [];
  if (byStatus.Shipped) progress.push(`${byStatus.Shipped} in transit`);
  if (byStatus.Delivered) progress.push(`${byStatus.Delivered} delivered`);
  if (byStatus.Cancelled) progress.push(`${byStatus.Cancelled} cancelled`);
  if (progress.length) sentences.push(`Of the rest, ${progress.join(', ')}.`);

  sentences.push(
    `The largest order is #${largest.id}: ${largest.quantity} × ${largest.product} ` +
    `for ${largest.customer_name} (${formatMoney(largest.total)}, ${largest.status}).`
  );

  let topRep = null;
  for (const [name, value] of bookedByRep) {
    if (!topRep || value > topRep.booked_value) topRep = { name, booked_value: Math.round(value * 100) / 100 };
  }
  if (topRep) sentences.push(`Top rep by booked value: ${topRep.name} (${formatMoney(topRep.booked_value)}).`);

  return {
    summary: sentences.join(' '),
    byStatus,
    total,
    units,
    open,
    booked_value: bookedValue,
    largestOrder: largest,
    topRep,
  };
}

module.exports = { buildInsights };
