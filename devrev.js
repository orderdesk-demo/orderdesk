/**
 * devrev.js: one-way sync of OrderDesk orders into DevRev as custom objects.
 *
 * Each local order becomes a DevRev custom object of leaf type "order"
 * (display IDs like C-ORD-12), so orders can be listed, filtered and searched
 * inside DevRev.
 *
 *   setupSchema()              create/update the "Order" custom object schema (run once)
 *   upsertOrder(order)         create the DevRev object, or update it if it exists
 *   deleteOrder(orderId)       delete the DevRev object for a local order
 *   listRemoteOrders()         every Order object currently in DevRev
 *   syncAll(orders)            full reconcile: upsert every local order, delete orphans
 *   queueUpsert / queueDelete  fire-and-forget versions used by server.js after each write
 *
 * The local database stays the source of truth: DevRev failures are logged and
 * never break an OrderDesk API request.
 *
 * Configuration (.env):
 *   DEVREV_PAT        Personal Access Token (sync is disabled when unset)
 *   DEVREV_API_BASE   default https://api.devrev.ai
 *   DEVREV_LEAF_TYPE  default "order"
 *   DEVREV_DRY_RUN=1  print the requests instead of sending them
 */
const { STATUSES } = require('./store');

// Read env lazily so .env can be loaded (or flags set) after this module is required.
const config = () => ({
  pat: process.env.DEVREV_PAT || '',
  apiBase: (process.env.DEVREV_API_BASE || 'https://api.devrev.ai').replace(/\/+$/, ''),
  leafType: process.env.DEVREV_LEAF_TYPE || 'order',
  dryRun: ['1', 'true', 'yes'].includes(String(process.env.DEVREV_DRY_RUN || '').toLowerCase()),
});

/** 'live' | 'dry-run' | 'disabled' */
function mode() {
  const { pat, dryRun } = config();
  if (dryRun) return 'dry-run';
  return pat ? 'live' : 'disabled';
}

const state = { lastSyncAt: null, lastError: null };
const objectIds = new Map(); // local order id -> DevRev custom object id (cache)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** POST to a DevRev API endpoint. Retries on 429 / 5xx. Never logs the token. */
async function call(endpoint, body, attempt = 1) {
  const { pat, apiBase, dryRun } = config();
  if (dryRun) {
    console.log(`[devrev dry-run] POST ${apiBase}/${endpoint}\n${JSON.stringify(body, null, 2)}`);
    return null;
  }
  if (!pat) throw new Error('DEVREV_PAT is not set (add it to .env)');

  const res = await fetch(`${apiBase}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    return call(endpoint, body, attempt + 1);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = (data && (data.message || data.detail || data.error)) || text.slice(0, 300);
    const err = new Error(`DevRev ${endpoint} failed (${res.status}): ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Schema + mapping                                                    */
/* ------------------------------------------------------------------ */

function schemaBody() {
  return {
    type: 'tenant_fragment',
    description: 'Orders synced from the OrderDesk order management prototype',
    leaf_type: config().leafType,
    leaf_type_display_name: 'Order',
    is_custom_leaf_type: true,
    id_prefix: 'ORD',
    fields: [
      { name: 'order_id', field_type: 'int', description: 'OrderDesk order ID', is_filterable: true, ui: { display_name: 'OrderDesk ID', is_sortable: true } },
      { name: 'customer_name', field_type: 'tokens', description: 'Customer name', is_filterable: true, ui: { display_name: 'Customer', is_sortable: true } },
      { name: 'product', field_type: 'tokens', description: 'Product ordered', is_filterable: true, ui: { display_name: 'Product', is_sortable: true } },
      { name: 'quantity', field_type: 'int', description: 'Units ordered', is_filterable: true, ui: { display_name: 'Quantity', is_sortable: true } },
      { name: 'status', field_type: 'enum', description: 'Order status', allowed_values: STATUSES, is_filterable: true, ui: { display_name: 'Status', is_sortable: true, is_groupable: true } },
      { name: 'created_at', field_type: 'timestamp', description: 'When the order was created in OrderDesk', is_filterable: true, ui: { display_name: 'Ordered at', is_sortable: true } },
      { name: 'updated_at', field_type: 'timestamp', description: 'When the order was last updated in OrderDesk', is_filterable: true, ui: { display_name: 'Updated in OrderDesk', is_sortable: true } },
      { name: 'order_value', field_type: 'double', description: 'Order value in USD (quantity × unit price)', is_filterable: true, ui: { display_name: 'Order value', is_sortable: true } },
      { name: 'sales_rep', field_type: 'tokens', description: 'Field sales rep who placed the order', is_filterable: true, ui: { display_name: 'Sales rep', is_sortable: true } },
      { name: 'region', field_type: 'tokens', description: 'Sales region of the rep', is_filterable: true, ui: { display_name: 'Region', is_sortable: true } },
      { name: 'placed_offline', field_type: 'bool', description: 'Captured while the rep device was offline', is_filterable: true, ui: { display_name: 'Placed offline' } },
    ],
  };
}

/** Map a local order to DevRev title + tenant custom fields (tnt__ prefix). */
function toDevRev(order) {
  return {
    title: `Order #${order.id}: ${order.quantity} × ${order.product} (${order.customer_name})`,
    custom_fields: {
      tnt__order_id: order.id,
      tnt__customer_name: order.customer_name,
      tnt__product: order.product,
      tnt__quantity: order.quantity,
      tnt__status: order.status,
      tnt__created_at: order.created_at,
      tnt__updated_at: order.updated_at,
      tnt__order_value: order.total,
      tnt__sales_rep: order.rep_name,
      tnt__region: order.rep_region,
      tnt__placed_offline: order.placed_offline,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

const setupSchema = () => call('schemas.custom.set', schemaBody());

async function findObjectId(orderId) {
  if (objectIds.has(orderId)) return objectIds.get(orderId);
  const data = await call('custom-objects.list', {
    leaf_type: config().leafType,
    filter: ['eq', '$custom_fields.tnt__order_id', orderId],
    limit: 1,
  });
  const id = (data && data.result && data.result[0] && data.result[0].id) || null;
  if (id) objectIds.set(orderId, id);
  return id;
}

async function createObject(order) {
  const data = await call('custom-objects.create', {
    leaf_type: config().leafType,
    custom_schema_spec: { tenant_fragment: true },
    unique_key: `orderdesk-order-${order.id}`,
    ...toDevRev(order),
  });
  const created = data && data.custom_object;
  if (created) objectIds.set(order.id, created.id);
  return { action: 'created', id: created ? created.id : null, displayId: created ? created.display_id : null };
}

async function updateObject(id, order) {
  await call('custom-objects.update', { id, ...toDevRev(order) });
  return { action: 'updated', id };
}

async function upsertOrder(order) {
  const existingId = await findObjectId(order.id);
  if (!existingId) return createObject(order);
  try {
    return await updateObject(existingId, order);
  } catch (err) {
    if (err.status !== 404) throw err;
    objectIds.delete(order.id); // deleted inside DevRev: recreate it
    return createObject(order);
  }
}

async function deleteOrder(orderId) {
  const id = await findObjectId(orderId);
  if (!id) return { action: 'skipped' };
  await call('custom-objects.delete', { id });
  objectIds.delete(orderId);
  return { action: 'deleted', id };
}

async function listRemoteOrders() {
  const all = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const data = await call('custom-objects.list', { leaf_type: config().leafType, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!data) break; // dry run
    all.push(...(data.result || []));
    cursor = data.next_cursor;
    if (cursor && seenCursors.has(cursor)) break; // guard against a repeating cursor
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return all;
}

/** Full reconcile: create missing, update existing, delete DevRev orders removed locally. */
async function syncAll(orders) {
  const summary = { created: 0, updated: 0, deleted: 0, failed: 0, errors: [] };

  objectIds.clear();
  for (const obj of await listRemoteOrders()) {
    const orderId = obj.custom_fields && obj.custom_fields.tnt__order_id;
    if (orderId !== undefined && orderId !== null) objectIds.set(Number(orderId), obj.id);
  }

  for (const order of orders) {
    try {
      const existingId = objectIds.get(order.id);
      const result = existingId ? await updateObject(existingId, order) : await createObject(order);
      summary[result.action] += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`order ${order.id}: ${err.message}`);
    }
  }

  const localIds = new Set(orders.map((o) => o.id));
  for (const [orderId, id] of objectIds) {
    if (localIds.has(orderId)) continue;
    try {
      await call('custom-objects.delete', { id });
      objectIds.delete(orderId);
      summary.deleted += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`delete orphan ${id}: ${err.message}`);
    }
  }

  record(summary.errors[0] || null);
  return summary;
}

/* ------------------------------------------------------------------ */
/* Background queue used by server.js                                  */
/* ------------------------------------------------------------------ */

// One promise chain per order, so a quick create-then-update can't race into duplicates.
const queues = new Map();

function record(error) {
  if (error) state.lastError = { message: error, at: new Date().toISOString() };
  else state.lastSyncAt = new Date().toISOString();
}

function enqueue(orderId, label, task) {
  if (mode() === 'disabled') return;
  const run = async () => {
    try {
      const result = await task();
      record(null);
      console.log(`[devrev] order ${orderId} ${result.action}${result.displayId ? ` (${result.displayId})` : ''}`);
    } catch (err) {
      record(err.message);
      console.warn(`[devrev] ${label} for order ${orderId} failed: ${err.message}`);
    }
  };
  const next = (queues.get(orderId) || Promise.resolve()).then(run);
  queues.set(orderId, next);
  next.then(() => { if (queues.get(orderId) === next) queues.delete(orderId); });
}

const queueUpsert = (order) => enqueue(order.id, 'sync', () => upsertOrder(order));
const queueDelete = (orderId) => enqueue(orderId, 'delete', () => deleteOrder(orderId));

/** Safe-to-expose sync status (never includes the token). */
function status() {
  const { apiBase, leafType } = config();
  return { mode: mode(), apiBase, leafType, lastSyncAt: state.lastSyncAt, lastError: state.lastError, pending: queues.size };
}

module.exports = {
  mode,
  status,
  setupSchema,
  upsertOrder,
  deleteOrder,
  listRemoteOrders,
  syncAll,
  queueUpsert,
  queueDelete,
};
