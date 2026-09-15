/**
 * mcp.js: MCP (Model Context Protocol) server for OrderDesk.
 *
 * Lets AI agents such as DevRev Computer query orders live, through tools:
 *   search_orders           find orders by free text, status, customer, product, rep, region, size
 *   get_order               one order by ID
 *   get_order_insights      plain-language summary + counts by status
 *   get_sales_performance   team, rep and region performance vs quota over a window
 *   find_stale_orders       open orders with no update for N hours (SLA risk)
 *   update_order_status     change an order's status (registered only when MCP_ALLOW_WRITES=true)
 *
 * Transport: Streamable HTTP in stateless mode (a fresh MCP server per request),
 * mounted at POST /mcp on the same Express app, reading through store.js.
 *
 * Configuration (.env):
 *   MCP_API_KEY=<secret>     require the key as "Authorization: Bearer <secret>" or ?key=<secret>
 *   MCP_ALLOW_WRITES=true    expose update_order_status
 */
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const store = require('./store');
const devrev = require('./devrev');
const { buildInsights } = require('./insights');
const { leadershipDashboard, staleOrders, formatMoney, formatPct } = require('./metrics');

const { STATUSES, REGIONS } = store;

const isTrue = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
const writesAllowed = () => isTrue(process.env.MCP_ALLOW_WRITES);

const INSTRUCTIONS = `OrderDesk is an order management system for a field sales team. Each order has an id,
customer_name, product, quantity (units), unit_price and total (USD), status (${STATUSES.join(', ')}),
rep_name and rep_region (the field sales rep who placed it; regions: ${REGIONS.join(', ')}), placed_offline
(captured without connectivity and synced later), created_at and updated_at (ISO timestamps).
"Open" orders are New or Processing. Revenue / booked value is the total of orders that are not Cancelled.
Use search_orders to find or filter orders, get_order for one order, get_order_insights for an overall summary,
get_sales_performance for team, rep and region results against quota, and find_stale_orders to spot open orders
at risk of missing an SLA.`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const contains = (haystack, needle) =>
  String(haystack || '').toLowerCase().includes(String(needle).trim().toLowerCase());

const describeOrder = (o) =>
  `#${o.id} · ${o.customer_name} · ${o.quantity} × ${o.product} · ${formatMoney(o.total)} · ${o.status}`
  + ` · rep ${o.rep_name} (${o.rep_region})${o.placed_offline ? ' · placed offline' : ''} · updated ${o.updated_at}`;

/** Tool result: a readable summary for the model, followed by the full JSON data. */
function textResult(text, data) {
  const body = data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text: body }] };
}

const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

function matchesFilters(order, { query, status, customer, product, rep, region, min_quantity: minQuantity }) {
  if (status && order.status !== status) return false;
  if (region && order.rep_region !== region) return false;
  if (customer && !contains(order.customer_name, customer)) return false;
  if (product && !contains(order.product, product)) return false;
  if (rep && !contains(order.rep_name, rep)) return false;
  if (minQuantity && order.quantity < minQuantity) return false;
  if (query && ![order.customer_name, order.product, order.status, order.rep_name].some((field) => contains(field, query))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* MCP server + tools                                                  */
/* ------------------------------------------------------------------ */

function buildServer() {
  const server = new McpServer(
    { name: 'orderdesk', title: 'OrderDesk Orders', version: '1.1.0' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool('search_orders', {
    title: 'Search orders',
    description: 'Search OrderDesk orders. All filters are optional and combined with AND; text matching is '
      + 'case-insensitive and partial. Returns newest orders first. Call with no arguments to list recent orders.',
    inputSchema: {
      query: z.string().optional().describe('Free text matched against customer, product, status and sales rep name'),
      status: z.enum(STATUSES).optional().describe('Only orders with exactly this status'),
      customer: z.string().optional().describe('Customer name contains this text'),
      product: z.string().optional().describe('Product name contains this text'),
      rep: z.string().optional().describe('Sales rep name contains this text, e.g. "Priya"'),
      region: z.enum(REGIONS).optional().describe('Only orders placed by reps in this region'),
      min_quantity: z.coerce.number().int().min(1).optional().describe('Only orders with at least this many units'),
      limit: z.coerce.number().int().min(1).max(100).default(20).describe('Maximum number of orders to return'),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const matches = (await store.listOrders()).filter((o) => matchesFilters(o, args));
    const shown = matches.slice(0, args.limit);
    if (matches.length === 0) return textResult('No orders match those filters.', []);
    const more = matches.length > shown.length ? `, showing the first ${shown.length}` : '';
    return textResult(`Found ${matches.length} order(s)${more}:\n${shown.map(describeOrder).join('\n')}`, shown);
  });

  server.registerTool('get_order', {
    title: 'Get order',
    description: 'Get one OrderDesk order by its numeric ID, including value, sales rep and timestamps.',
    inputSchema: {
      id: z.coerce.number().int().min(1).describe('Order ID, e.g. 3'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const order = await store.getOrder(id);
    if (!order) return errorResult(`Order ${id} was not found.`);
    return textResult(describeOrder(order), order);
  });

  server.registerTool('get_order_insights', {
    title: 'Order insights',
    description: 'Plain-language summary of all orders: totals, booked value, open orders, counts by status, '
      + 'the largest order and the top rep.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const insights = buildInsights(await store.listOrders());
    return textResult(insights.summary, insights);
  });

  server.registerTool('get_sales_performance', {
    title: 'Sales performance',
    description: 'Field sales performance over the last N days compared with the N days before: booked revenue, '
      + 'orders, quota attainment per rep and region, open pipeline, share of orders captured offline, and '
      + 'stale orders that need attention.',
    inputSchema: {
      days: z.coerce.number().int().min(1).max(365).default(28).describe('Window length in days, e.g. 7, 28 or 84'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ days }) => {
    const [orders, reps] = await Promise.all([store.listOrders(), store.listReps()]);
    const d = leadershipDashboard(orders, reps, { days });
    const k = d.kpis;
    const change = k.revenue_change_pct === null
      ? ''
      : ` (${k.revenue_change_pct >= 0 ? '+' : ''}${k.revenue_change_pct}% vs the previous ${days} days)`;
    const lines = [
      `Last ${days} days: ${formatMoney(k.revenue)} booked across ${k.orders} orders${change}.`,
      `Team attainment: ${formatPct(k.attainment)} of prorated quota (${formatMoney(k.quota)}). `
        + `Open pipeline: ${formatMoney(k.open_pipeline_value)} in ${k.open_orders} open orders. `
        + `Captured offline: ${formatPct(k.offline_share)}.`,
      'Reps by booked revenue:',
      ...d.reps.map((r, i) => `${i + 1}. ${r.name} (${r.region}): ${formatMoney(r.revenue)}, `
        + `${formatPct(r.attainment)} of quota, ${r.orders} orders, ${r.stale_orders} stale`),
      'Regions: ' + d.regions.map((r) => `${r.region} ${formatMoney(r.revenue)} (${formatPct(r.attainment)})`).join(', '),
      `Needs attention: ${d.attention.total} open orders with no update in ${d.attention.stale_hours}h or more.`,
    ];
    return textResult(lines.join('\n'), d);
  });

  server.registerTool('find_stale_orders', {
    title: 'Find stale orders',
    description: 'Find open orders (New or Processing) that have not been updated for at least the given number '
      + 'of hours, longest-waiting first. Useful for spotting orders at risk of missing an SLA.',
    inputSchema: {
      hours: z.coerce.number().min(0).default(24).describe('Hours without an update before an open order counts as stale'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ hours }) => {
    const stale = staleOrders(await store.listOrders(), { hours });
    if (stale.length === 0) return textResult(`No open orders have gone ${hours}h without an update.`, []);
    const lines = stale.map((o) => `${describeOrder(o)} (no update for ${o.hours_since_update}h)`);
    return textResult(`${stale.length} open order(s) not updated in ${hours}h or more:\n${lines.join('\n')}`, stale);
  });

  if (writesAllowed()) {
    server.registerTool('update_order_status', {
      title: 'Update order status',
      description: `Change an OrderDesk order's status. Allowed statuses: ${STATUSES.join(', ')}.`,
      inputSchema: {
        id: z.coerce.number().int().min(1).describe('Order ID, e.g. 3'),
        status: z.enum(STATUSES).describe('New status'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ id, status }) => {
      const before = await store.getOrder(id);
      if (!before) return errorResult(`Order ${id} was not found.`);
      if (before.status === status) return textResult(`Order #${id} is already ${status}.`, before);
      const updated = await store.updateOrder(id, { status });
      devrev.queueUpsert(updated); // keep the optional DevRev custom-object sync consistent
      return textResult(`Order #${id} moved from ${before.status} to ${status}.`, updated);
    });
  }

  return server;
}

/* ------------------------------------------------------------------ */
/* HTTP mounting                                                       */
/* ------------------------------------------------------------------ */

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Enforce MCP_API_KEY when it is set; open access otherwise.
 * Accepts the key as "Authorization: Bearer <key>" or as a ?key=<key> query parameter,
 * for connectors that can't send custom headers (or send their own Authorization header).
 */
function requireApiKey(req, res, next) {
  const key = process.env.MCP_API_KEY;
  if (!key) return next();
  const header = req.get('authorization') || '';
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : header;
  const fromQuery = typeof req.query.key === 'string' ? req.query.key : '';
  if (safeEqual(fromHeader, key) || safeEqual(fromQuery, key)) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

/** Mount the stateless Streamable HTTP MCP endpoint on an Express app. */
function mountMcp(app, route = '/mcp') {
  app.post(route, requireApiKey, async (req, res) => {
    const server = buildServer();
    // JSON responses (no SSE stream): simplest and most proxy/tunnel-friendly for request/response tools
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // Stateless server: no server-initiated streams or sessions to open or delete
  const methodNotAllowed = (req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP server is stateless, use POST.' },
      id: null,
    });
  };
  app.get(route, methodNotAllowed);
  app.delete(route, methodNotAllowed);
}

/** One-line description for the startup log. */
function describeMcp(baseUrl, route = '/mcp') {
  const auth = process.env.MCP_API_KEY ? 'API key required' : 'no auth';
  const writes = writesAllowed() ? 'status updates enabled' : 'read-only';
  return `${baseUrl}${route} (${auth}, ${writes})`;
}

module.exports = { mountMcp, describeMcp, buildServer };
