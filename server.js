/**
 * server.js: OrderDesk, order management for a field sales team (single process)
 *
 * One Express app serves both:
 *   - the JSON REST API under /api (orders, sales reps, dashboards, insights)
 *   - the static single-page frontend from ./public
 *
 * All persistence goes through ./store.js and all dashboard math through ./metrics.js.
 * This file only deals with HTTP and validation. Handlers `await` every store call,
 * so an async engine (Postgres, a remote API, ...) can replace the current one
 * without changing any code here.
 */
const path = require('path');

// Load .env (DEVREV_PAT, PORT, ...) if present. Must run before reading any config.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const express = require('express');
const store = require('./store');
const devrev = require('./devrev');
const { buildInsights } = require('./insights');
const { leadershipDashboard, repDashboard } = require('./metrics');
const { mountMcp, describeMcp } = require('./mcp');

const PORT = Number(process.env.PORT) || 3000;
const { STATUSES } = store;
const MAX_TEXT_LENGTH = 120;
const MAX_QUANTITY = 100000;
const MAX_UNIT_PRICE = 1000000;

// Fields a client may write, and server-managed or derived fields we silently ignore
// (so a client can round-trip a GET response straight back into a PUT).
const WRITABLE_FIELDS = ['customer_name', 'product', 'quantity', 'unit_price', 'status', 'rep_id', 'placed_offline'];
const READ_ONLY_FIELDS = ['id', 'total', 'rep_name', 'rep_region', 'created_at', 'updated_at'];

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const hasAtMostTwoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-7;

/**
 * Validate an order payload (shape only; rep existence is checked in the route).
 * @param {object} body     Parsed JSON request body
 * @param {object} options  { partial: true } for PUT (fields optional)
 * @returns {{ errors: string[], value: object }} cleaned value + error list
 */
function validateOrder(body, { partial = false } = {}) {
  const errors = [];
  const value = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['request body must be a JSON object'], value };
  }

  const unknown = Object.keys(body).filter(
    (key) => !WRITABLE_FIELDS.includes(key) && !READ_ONLY_FIELDS.includes(key)
  );
  if (unknown.length) {
    errors.push(`unknown field(s): ${unknown.join(', ')}`);
  }

  // Required text fields
  for (const field of ['customer_name', 'product']) {
    const raw = body[field];
    if (raw === undefined) {
      if (!partial) errors.push(`${field} is required`);
    } else if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`${field} must be a non-empty string`);
    } else if (raw.trim().length > MAX_TEXT_LENGTH) {
      errors.push(`${field} must be at most ${MAX_TEXT_LENGTH} characters`);
    } else {
      value[field] = raw.trim();
    }
  }

  // Quantity: a real JSON integer >= 1 ("3" or 2.5 are rejected)
  if (body.quantity === undefined) {
    if (!partial) errors.push('quantity is required');
  } else if (!Number.isInteger(body.quantity) || body.quantity < 1) {
    errors.push('quantity must be a positive integer');
  } else if (body.quantity > MAX_QUANTITY) {
    errors.push(`quantity must be at most ${MAX_QUANTITY}`);
  } else {
    value.quantity = body.quantity;
  }

  // Unit price in USD: a number >= 0 with at most 2 decimal places
  if (body.unit_price === undefined) {
    if (!partial) errors.push('unit_price is required');
  } else if (typeof body.unit_price !== 'number' || !Number.isFinite(body.unit_price) || body.unit_price < 0) {
    errors.push('unit_price must be a number >= 0');
  } else if (body.unit_price > MAX_UNIT_PRICE) {
    errors.push(`unit_price must be at most ${MAX_UNIT_PRICE}`);
  } else if (!hasAtMostTwoDecimals(body.unit_price)) {
    errors.push('unit_price must have at most 2 decimal places');
  } else {
    value.unit_price = body.unit_price;
  }

  // Status: optional on create (defaults to "New"), must be a known value
  if (body.status === undefined) {
    if (!partial) value.status = 'New';
  } else if (!STATUSES.includes(body.status)) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  } else {
    value.status = body.status;
  }

  // Sales rep who placed the order: required on create
  if (body.rep_id === undefined) {
    if (!partial) errors.push('rep_id is required');
  } else if (!Number.isInteger(body.rep_id) || body.rep_id < 1) {
    errors.push('rep_id must be a positive integer');
  } else {
    value.rep_id = body.rep_id;
  }

  // Captured while the rep's device was offline and synced later (optional, default false)
  if (body.placed_offline === undefined) {
    if (!partial) value.placed_offline = false;
  } else if (typeof body.placed_offline !== 'boolean') {
    errors.push('placed_offline must be true or false');
  } else {
    value.placed_offline = body.placed_offline;
  }

  if (partial && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push(`provide at least one of: ${WRITABLE_FIELDS.join(', ')}`);
  }

  return { errors, value };
}

/** Parse an id as a positive integer, or null if malformed. */
function parseId(raw) {
  return /^[1-9]\d*$/.test(String(raw)) ? Number(raw) : null;
}

/** Dashboard window in days: default 28, integer 1-365. Returns null if invalid. */
function parseDays(raw) {
  if (raw === undefined) return 28;
  const days = parseId(raw);
  return days !== null && days <= 365 ? days : null;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// Wrap async handlers so rejected promises reach the error middleware.
const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const notFound = (res, id) => res.status(404).json({ errors: [`order ${id} not found`] });
const repNotFound = (res, id) => res.status(404).json({ errors: [`sales rep ${id} not found`] });
const badId = (res) => res.status(400).json({ errors: ['id must be a positive integer'] });

/** Adds an error when a rep_id in a validated payload doesn't exist. */
async function checkRepExists(value, errors) {
  if (value.rep_id !== undefined && !(await store.getRep(value.rep_id))) {
    errors.push(`rep_id ${value.rep_id} does not match a sales rep`);
  }
}

// List orders (newest first), optionally filtered: ?rep_id=3&status=Processing
app.get('/api/orders', route(async (req, res) => {
  const errors = [];
  const filters = {};
  if (req.query.rep_id !== undefined) {
    const repId = parseId(req.query.rep_id);
    if (repId === null) errors.push('rep_id must be a positive integer');
    else filters.repId = repId;
  }
  if (req.query.status !== undefined) {
    if (!STATUSES.includes(req.query.status)) errors.push(`status must be one of: ${STATUSES.join(', ')}`);
    else filters.status = req.query.status;
  }
  if (errors.length) return res.status(400).json({ errors });
  res.json(await store.listOrders(filters));
}));

// Get a single order
app.get('/api/orders/:id', route(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const order = await store.getOrder(id);
  if (!order) return notFound(res, id);
  res.json(order);
}));

// Create an order
app.post('/api/orders', route(async (req, res) => {
  const { errors, value } = validateOrder(req.body);
  await checkRepExists(value, errors);
  if (errors.length) return res.status(400).json({ errors });
  const order = await store.createOrder(value);
  devrev.queueUpsert(order); // background sync to DevRev (no-op when disabled)
  res.status(201).location(`/api/orders/${order.id}`).json(order);
}));

// Update an order (partial updates allowed)
app.put('/api/orders/:id', route(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const { errors, value } = validateOrder(req.body, { partial: true });
  await checkRepExists(value, errors);
  if (errors.length) return res.status(400).json({ errors });
  const order = await store.updateOrder(id, value);
  if (!order) return notFound(res, id);
  devrev.queueUpsert(order);
  res.json(order);
}));

// Delete an order
app.delete('/api/orders/:id', route(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const deleted = await store.deleteOrder(id);
  if (!deleted) return notFound(res, id);
  devrev.queueDelete(id);
  res.status(204).end();
}));

// Sales reps (read-only reference data)
app.get('/api/reps', route(async (req, res) => {
  res.json(await store.listReps());
}));

app.get('/api/reps/:id', route(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const rep = await store.getRep(id);
  if (!rep) return repNotFound(res, id);
  res.json(rep);
}));

// Product catalog with list prices (prefills the order form)
app.get('/api/products', (req, res) => {
  res.json(store.PRODUCTS);
});

// Leadership dashboard: team KPIs, trend, reps vs quota, regions, pipeline, stale orders
app.get('/api/dashboard/leadership', route(async (req, res) => {
  const days = parseDays(req.query.days);
  if (days === null) return res.status(400).json({ errors: ['days must be an integer from 1 to 365'] });
  const [orders, reps] = await Promise.all([store.listOrders(), store.listReps()]);
  res.json(leadershipDashboard(orders, reps, { days }));
}));

// Sales rep dashboard: month-to-date quota pace, last 30 days, open work, follow-ups
app.get('/api/dashboard/rep/:id', route(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const [orders, reps] = await Promise.all([store.listOrders(), store.listReps()]);
  const dashboard = repDashboard(orders, reps, id);
  if (!dashboard) return repNotFound(res, id);
  res.json(dashboard);
}));

// Plain-language summary of the current orders
app.get('/api/insights', route(async (req, res) => {
  res.json(buildInsights(await store.listOrders()));
}));

// DevRev sync status: mode, last sync, last error (never exposes the token)
app.get('/api/devrev/status', (req, res) => {
  res.json(devrev.status());
});

// MCP endpoint for AI agents (e.g. DevRev Computer custom MCP connector): POST /mcp
mountMcp(app);

// Unknown API routes get a JSON 404 (not the HTML default)
app.use('/api', (req, res) => {
  res.status(404).json({ errors: [`no route for ${req.method} ${req.originalUrl}`] });
});

// Central error handler: malformed JSON becomes 400, anything else 500
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ errors: ['request body is not valid JSON'] });
  }
  console.error(err);
  res.status(500).json({ errors: ['internal server error'] });
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

store.init();

app.listen(PORT, () => {
  console.log(`Order Management System running at http://localhost:${PORT}`);
  console.log(`Storage engine: ${store.engine}`);
  const syncMode = devrev.mode();
  console.log(`DevRev sync: ${syncMode}${syncMode === 'disabled' ? ' (set DEVREV_PAT in .env to enable)' : ''}`);
  console.log(`MCP server: ${describeMcp(`http://localhost:${PORT}`)}`);
});

// Optional MCP-only listener (MCP_PORT). Point a public tunnel here to expose the MCP
// connector WITHOUT exposing the web app or REST API. Bound to localhost only.
const MCP_PORT = Number(process.env.MCP_PORT) || null;
if (MCP_PORT) {
  const mcpApp = express();
  mcpApp.use(express.json({ limit: '100kb' }));
  mountMcp(mcpApp);
  mcpApp.use((req, res) => {
    res.status(404).json({ errors: ['only POST /mcp is served on this port'] });
  });
  mcpApp.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ errors: [status === 400 ? 'request body is not valid JSON' : 'internal server error'] });
  });
  const mcpListener = mcpApp.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`MCP-only listener: ${describeMcp(`http://localhost:${MCP_PORT}`)}`);
  });
  // A busy MCP_PORT shouldn't take down the main app
  mcpListener.on('error', (err) => {
    console.warn(`MCP-only listener not started on port ${MCP_PORT}: ${err.message}`);
  });
}
