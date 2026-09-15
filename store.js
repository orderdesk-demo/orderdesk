/**
 * store.js: storage layer for OrderDesk.
 *
 * This is the ONLY module that knows how data is persisted. Engine-agnostic interface:
 *
 *   init()                          open storage, create or migrate schema, seed on first run
 *   listOrders({ repId, status })   -> Order[] newest first (both filters optional)
 *   getOrder(id)                    -> Order | null
 *   createOrder(data)               -> Order          (data is pre-validated)
 *   updateOrder(id, patch)          -> Order | null   (partial patch)
 *   deleteOrder(id)                 -> boolean
 *   listReps()                      -> SalesRep[]
 *   getRep(id)                      -> SalesRep | null
 *   STATUSES, OPEN_STATUSES, REGIONS, engine
 *
 * Order (as returned):
 *   { id, customer_name, product, quantity, unit_price, total, status,
 *     rep_id, rep_name, rep_region, placed_offline, created_at, updated_at }
 *   total, rep_name and rep_region are derived on read, never stored.
 * SalesRep: { id, name, email, region, monthly_quota }
 *
 * Engines:
 *   1. SQLite via better-sqlite3 (default)
 *   2. JSON file (automatic fallback if better-sqlite3 can't load, or STORE_ENGINE=json)
 *
 * Swapping in another database means writing one more engine object with the same
 * methods; server.js, mcp.js and the frontend don't change.
 */
const fs = require('fs');
const path = require('path');

const STATUSES = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const OPEN_STATUSES = ['New', 'Processing'];
const REGIONS = ['North', 'South', 'East', 'West'];
const WRITABLE_FIELDS = ['customer_name', 'product', 'quantity', 'unit_price', 'status', 'rep_id', 'placed_offline'];

// v1: orders only. v2: sales reps, order value, offline flag.
const SCHEMA_VERSION = 2;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'orders.db');
const JSON_FILE = path.join(DATA_DIR, 'orders.json');

const HOUR = 36e5;
const nowIso = () => new Date().toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

const SEED_REPS = [
  { name: 'Priya Sharma', email: 'priya.sharma@orderdesk.demo', region: 'West', monthly_quota: 50000 },
  { name: 'Marcus Johnson', email: 'marcus.johnson@orderdesk.demo', region: 'East', monthly_quota: 45000 },
  { name: 'Elena Rodriguez', email: 'elena.rodriguez@orderdesk.demo', region: 'South', monthly_quota: 42000 },
  { name: 'David Kim', email: 'david.kim@orderdesk.demo', region: 'North', monthly_quota: 40000 },
  { name: 'Aisha Patel', email: 'aisha.patel@orderdesk.demo', region: 'West', monthly_quota: 38000 },
  { name: 'Tom Becker', email: 'tom.becker@orderdesk.demo', region: 'East', monthly_quota: 35000 },
];
// Relative share of orders per seed rep, so the leaderboard has a realistic spread.
const REP_WEIGHTS = [1.3, 1.1, 1.0, 0.8, 0.9, 0.6];

const CATALOG = [
  { product: 'POS Terminal', unit_price: 899, qty: [2, 12] },
  { product: 'Handheld Barcode Scanner', unit_price: 249, qty: [5, 30] },
  { product: 'Thermal Receipt Printer', unit_price: 189, qty: [4, 20] },
  { product: 'Rugged Field Tablet', unit_price: 1299, qty: [1, 8] },
  { product: 'Mobile Card Reader', unit_price: 59, qty: [10, 60] },
  { product: 'Label Printer', unit_price: 329, qty: [2, 10] },
  { product: 'Cash Drawer', unit_price: 119, qty: [4, 20] },
  { product: 'Self-Checkout Kiosk', unit_price: 4999, qty: [1, 3] },
];
const DEFAULT_UNIT_PRICE = 99;

const CUSTOMERS = [
  'Acme Retail', 'Northwind Traders', 'Blue Harbor Pharmacy', 'Summit Outdoor Co.',
  'Greenleaf Grocers', 'Lakeside Hardware', 'Metro Mart', 'Sunrise Bakery Group',
  'Pinecrest Pharmacy', 'Harbor Point Deli', 'Canyon Coffee Co.', 'Riverbend Books',
  'Fresh Fields Market', 'Urban Threads Apparel', 'Bayview Wine & Spirits', 'Maple Street Pet Supply',
];

const SEED_ORDER_COUNT = 300;
const SEED_HISTORY_DAYS = 180;

/** Small deterministic PRNG so the demo data (and tests) are stable between runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plausible status for an order of a given age. Open orders only come from the last two weeks,
 * so the "needs attention" list shows believable delays (days, not months).
 */
function seedStatus(ageDays, rand) {
  const r = rand();
  if (ageDays < 2) return r < 0.6 ? 'New' : 'Processing';
  if (ageDays < 7) return r < 0.1 ? 'New' : r < 0.45 ? 'Processing' : r < 0.95 ? 'Shipped' : 'Cancelled';
  if (ageDays < 14) return r < 0.08 ? 'Processing' : r < 0.45 ? 'Shipped' : r < 0.94 ? 'Delivered' : 'Cancelled';
  return r < 0.92 ? 'Delivered' : 'Cancelled';
}

/** Demo order history spread over the last SEED_HISTORY_DAYS, oldest first. */
function buildSeedOrders(repIds, now = Date.now()) {
  const rand = mulberry32(20260915);
  const between = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (items) => items[Math.floor(rand() * items.length)];
  const weights = REP_WEIGHTS.slice(0, repIds.length);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pickRep = () => {
    let r = rand() * totalWeight;
    for (let i = 0; i < repIds.length; i += 1) {
      r -= weights[i];
      if (r < 0) return repIds[i];
    }
    return repIds[repIds.length - 1];
  };

  const orders = [];
  for (let i = 0; i < SEED_ORDER_COUNT; i += 1) {
    const ageHours = between(1, SEED_HISTORY_DAYS * 24);
    const created = now - ageHours * HOUR;
    const item = pick(CATALOG);
    const status = seedStatus(ageHours / 24, rand);
    // New orders haven't changed since creation; others last changed some time after it.
    let updated = created;
    if (status !== 'New') {
      const maxLagHours = Math.min(ageHours, status === 'Processing' ? 30 : 24 * 6);
      updated = created + between(1, Math.max(1, maxLagHours)) * HOUR;
    }
    orders.push({
      customer_name: pick(CUSTOMERS),
      product: item.product,
      quantity: between(item.qty[0], item.qty[1]),
      unit_price: item.unit_price,
      status,
      rep_id: pickRep(),
      placed_offline: rand() < 0.3,
      created_at: new Date(created).toISOString(),
      updated_at: new Date(Math.min(updated, now)).toISOString(),
    });
  }
  return orders.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Best-guess catalog price for an order created before prices existed (migration). */
function catalogPrice(product) {
  const name = String(product).toLowerCase();
  const match = CATALOG.find((c) => {
    const known = c.product.toLowerCase();
    return name.includes(known) || known.includes(name);
  });
  return match ? match.unit_price : DEFAULT_UNIT_PRICE;
}

/** Keep only the writable fields that are actually present in a patch. */
function pickWritable(patch) {
  return Object.fromEntries(WRITABLE_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
}

/* ------------------------------------------------------------------ */
/* Engine 1: SQLite (better-sqlite3)                                   */
/* ------------------------------------------------------------------ */

const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');

const REPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sales_reps (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    email         TEXT    NOT NULL UNIQUE,
    region        TEXT    NOT NULL CHECK (region IN (${sqlList(REGIONS)})),
    monthly_quota INTEGER NOT NULL CHECK (monthly_quota >= 0),
    created_at    TEXT    NOT NULL
  )`;

// The CHECK constraints mirror API validation as a second line of defence.
const ordersTableSql = (name) => `
  CREATE TABLE ${name} (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name  TEXT    NOT NULL CHECK (length(trim(customer_name)) > 0),
    product        TEXT    NOT NULL CHECK (length(trim(product)) > 0),
    quantity       INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
    unit_price     REAL    NOT NULL CHECK (unit_price >= 0),
    status         TEXT    NOT NULL DEFAULT 'New' CHECK (status IN (${sqlList(STATUSES)})),
    rep_id         INTEGER NOT NULL REFERENCES sales_reps (id),
    placed_offline INTEGER NOT NULL DEFAULT 0 CHECK (placed_offline IN (0, 1)),
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
  )`;

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
  CREATE INDEX IF NOT EXISTS idx_orders_rep_id     ON orders (rep_id);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at);
`;

const insertOrderSql = (table) => `
  INSERT INTO ${table} (customer_name, product, quantity, unit_price, status, rep_id, placed_offline, created_at, updated_at)
  VALUES (@customer_name, @product, @quantity, @unit_price, @status, @rep_id, @placed_offline, @created_at, @updated_at)`;

// Derived fields (total, rep name/region) are computed on read.
const ORDER_SELECT = `
  SELECT o.id, o.customer_name, o.product, o.quantity, o.unit_price,
         ROUND(o.quantity * o.unit_price, 2) AS total, o.status,
         o.rep_id, r.name AS rep_name, r.region AS rep_region,
         o.placed_offline, o.created_at, o.updated_at
  FROM orders o
  LEFT JOIN sales_reps r ON r.id = o.rep_id`;

function createSqliteEngine(Database) {
  let db;
  let stmts;

  const toOrder = (row) => (row ? { ...row, placed_offline: row.placed_offline === 1 } : null);
  const toRow = (data) => {
    const row = pickWritable(data);
    if (row.placed_offline !== undefined) row.placed_offline = row.placed_offline ? 1 : 0;
    return row;
  };

  function insertSeedReps() {
    const insert = db.prepare(`
      INSERT INTO sales_reps (name, email, region, monthly_quota, created_at)
      VALUES (@name, @email, @region, @monthly_quota, @created_at)`);
    const createdAt = nowIso();
    return SEED_REPS.map((rep) => Number(insert.run({ ...rep, created_at: createdAt }).lastInsertRowid));
  }

  function createAndSeed() {
    db.transaction(() => {
      db.exec(REPS_TABLE_SQL);
      db.exec(ordersTableSql('orders'));
      db.exec(INDEXES_SQL);
      const insert = db.prepare(insertOrderSql('orders'));
      for (const order of buildSeedOrders(insertSeedReps())) {
        insert.run({ ...order, placed_offline: order.placed_offline ? 1 : 0 });
      }
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    console.log(`[store] New database created and seeded with ${SEED_REPS.length} sales reps and ${SEED_ORDER_COUNT} orders.`);
  }

  /** v1 -> v2: add sales reps, rebuild orders with rep, price and offline columns. Keeps every order and id. */
  function migrateToV2() {
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orders'").get();
    let kept = 0;
    db.pragma('foreign_keys = OFF'); // no-op inside a transaction, so toggle around it
    db.transaction(() => {
      db.exec(REPS_TABLE_SQL);
      const repIds = insertSeedReps();
      db.exec(ordersTableSql('orders_v2'));
      const insert = db.prepare(`
        INSERT INTO orders_v2 (id, customer_name, product, quantity, unit_price, status, rep_id, placed_offline, created_at, updated_at)
        VALUES (@id, @customer_name, @product, @quantity, @unit_price, @status, @rep_id, 0, @created_at, @updated_at)`);
      for (const row of db.prepare('SELECT id, customer_name, product, quantity, status, created_at, updated_at FROM orders ORDER BY id').all()) {
        insert.run({ ...row, unit_price: catalogPrice(row.product), rep_id: repIds[(row.id - 1) % repIds.length] });
        kept += 1;
      }
      db.exec('DROP TABLE orders');
      db.exec('ALTER TABLE orders_v2 RENAME TO orders');
      db.exec(INDEXES_SQL);
      if (sequence) {
        // Never reuse ids of orders deleted before the migration
        db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'orders'").run(sequence.seq);
      }
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    db.pragma('foreign_keys = ON');
    console.log(`[store] Migrated database to schema v${SCHEMA_VERSION} (sales reps, order value, offline flag); kept ${kept} existing orders.`);
  }

  function init() {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const hasOrders = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get());
    if (!hasOrders) createAndSeed();
    else if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) migrateToV2();

    stmts = {
      getOrder: db.prepare(`${ORDER_SELECT} WHERE o.id = ?`),
      insertOrder: db.prepare(insertOrderSql('orders')),
      deleteOrder: db.prepare('DELETE FROM orders WHERE id = ?'),
      listReps: db.prepare('SELECT id, name, email, region, monthly_quota FROM sales_reps ORDER BY name'),
      getRep: db.prepare('SELECT id, name, email, region, monthly_quota FROM sales_reps WHERE id = ?'),
    };
  }

  return {
    name: `SQLite (better-sqlite3) at ${DB_FILE}`,
    init,
    listOrders({ repId, status } = {}) {
      const where = [];
      const params = {};
      if (repId !== undefined) { where.push('o.rep_id = @repId'); params.repId = repId; }
      if (status !== undefined) { where.push('o.status = @status'); params.status = status; }
      const stmt = db.prepare(`${ORDER_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC, o.id DESC`);
      return (where.length ? stmt.all(params) : stmt.all()).map(toOrder);
    },
    getOrder: (id) => toOrder(stmts.getOrder.get(id)),
    createOrder(data) {
      const now = nowIso();
      const info = stmts.insertOrder.run({ status: 'New', placed_offline: 0, ...toRow(data), created_at: now, updated_at: now });
      return toOrder(stmts.getOrder.get(info.lastInsertRowid));
    },
    updateOrder(id, patch) {
      const fields = toRow(patch);
      // Column names come from the WRITABLE_FIELDS whitelist, never from user input.
      const assignments = [...Object.keys(fields).map((k) => `${k} = @${k}`), 'updated_at = @updated_at'];
      const info = db
        .prepare(`UPDATE orders SET ${assignments.join(', ')} WHERE id = @id`)
        .run({ ...fields, updated_at: nowIso(), id });
      return info.changes > 0 ? toOrder(stmts.getOrder.get(id)) : null;
    },
    deleteOrder: (id) => stmts.deleteOrder.run(id).changes > 0,
    listReps: () => stmts.listReps.all(),
    getRep: (id) => stmts.getRep.get(id) || null,
  };
}

/* ------------------------------------------------------------------ */
/* Engine 2: JSON file (fallback)                                      */
/* ------------------------------------------------------------------ */

function createJsonEngine() {
  // nextId / nextRepId are stored so ids are never reused after a delete (same as AUTOINCREMENT).
  let state = { version: SCHEMA_VERSION, nextId: 1, nextRepId: 1, reps: [], orders: [] };

  // Write to a temp file then rename, so a crash can't leave half-written JSON.
  function save() {
    const tmp = `${JSON_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, JSON_FILE);
  }

  const find = (id) => state.orders.find((o) => o.id === id);
  const repById = (id) => state.reps.find((r) => r.id === id) || null;
  const publicRep = (r) => ({ id: r.id, name: r.name, email: r.email, region: r.region, monthly_quota: r.monthly_quota });
  const byNewest = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;

  /** Same shape and key order as the SQLite engine. */
  function decorate(o) {
    const rep = repById(o.rep_id);
    return {
      id: o.id,
      customer_name: o.customer_name,
      product: o.product,
      quantity: o.quantity,
      unit_price: o.unit_price,
      total: round2(o.quantity * o.unit_price),
      status: o.status,
      rep_id: o.rep_id,
      rep_name: rep ? rep.name : null,
      rep_region: rep ? rep.region : null,
      placed_offline: Boolean(o.placed_offline),
      created_at: o.created_at,
      updated_at: o.updated_at,
    };
  }

  function addSeedReps() {
    const createdAt = nowIso();
    return SEED_REPS.map((rep) => {
      const record = { id: state.nextRepId++, ...rep, created_at: createdAt };
      state.reps.push(record);
      return record.id;
    });
  }

  return {
    name: `JSON file (fallback) at ${JSON_FILE}`,
    init() {
      if (fs.existsSync(JSON_FILE)) {
        state = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
        if ((state.version || 1) < SCHEMA_VERSION) {
          state.version = SCHEMA_VERSION;
          state.nextRepId = 1;
          state.reps = [];
          const repIds = addSeedReps();
          state.orders = state.orders.map((o) => ({
            ...o,
            unit_price: catalogPrice(o.product),
            rep_id: repIds[(o.id - 1) % repIds.length],
            placed_offline: false,
          }));
          save();
          console.log(`[store] Migrated JSON store to schema v${SCHEMA_VERSION}; kept ${state.orders.length} existing orders.`);
        }
        return;
      }
      for (const row of buildSeedOrders(addSeedReps())) state.orders.push({ id: state.nextId++, ...row });
      save();
      console.log(`[store] New JSON store created and seeded with ${SEED_REPS.length} sales reps and ${SEED_ORDER_COUNT} orders.`);
    },
    listOrders({ repId, status } = {}) {
      return state.orders
        .filter((o) => (repId === undefined || o.rep_id === repId) && (status === undefined || o.status === status))
        .sort(byNewest)
        .map(decorate);
    },
    getOrder(id) {
      const order = find(id);
      return order ? decorate(order) : null;
    },
    createOrder(data) {
      const now = nowIso();
      const fields = pickWritable(data);
      const order = {
        id: state.nextId++,
        customer_name: fields.customer_name,
        product: fields.product,
        quantity: fields.quantity,
        unit_price: fields.unit_price,
        status: fields.status || 'New',
        rep_id: fields.rep_id,
        placed_offline: Boolean(fields.placed_offline),
        created_at: now,
        updated_at: now,
      };
      state.orders.push(order);
      save();
      return decorate(order);
    },
    updateOrder(id, patch) {
      const order = find(id);
      if (!order) return null;
      Object.assign(order, pickWritable(patch), { updated_at: nowIso() });
      order.placed_offline = Boolean(order.placed_offline);
      save();
      return decorate(order);
    },
    deleteOrder(id) {
      const index = state.orders.findIndex((o) => o.id === id);
      if (index === -1) return false;
      state.orders.splice(index, 1);
      save();
      return true;
    },
    listReps: () => [...state.reps].sort((a, b) => a.name.localeCompare(b.name)).map(publicRep),
    getRep(id) {
      const rep = repById(id);
      return rep ? publicRep(rep) : null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Engine selection + public interface                                 */
/* ------------------------------------------------------------------ */

let active = null;

function init() {
  if (process.env.STORE_ENGINE !== 'json') {
    try {
      // better-sqlite3 loads its native binary lazily, so init() is inside the try as well.
      const engine = createSqliteEngine(require('better-sqlite3'));
      engine.init();
      active = engine;
      return;
    } catch (err) {
      console.warn(`[store] better-sqlite3 unavailable (${String(err.message).split('\n')[0]}). Falling back to JSON file store.`);
    }
  }
  active = createJsonEngine();
  active.init();
}

function requireInit() {
  if (!active) throw new Error('store.init() must be called before use');
  return active;
}

module.exports = {
  STATUSES,
  OPEN_STATUSES,
  REGIONS,
  PRODUCTS: CATALOG.map(({ product, unit_price }) => ({ product, unit_price })),
  get engine() { return active ? active.name : 'not initialised'; },
  init,
  listOrders: (filters) => requireInit().listOrders(filters),
  getOrder: (id) => requireInit().getOrder(id),
  createOrder: (data) => requireInit().createOrder(data),
  updateOrder: (id, patch) => requireInit().updateOrder(id, patch),
  deleteOrder: (id) => requireInit().deleteOrder(id),
  listReps: () => requireInit().listReps(),
  getRep: (id) => requireInit().getRep(id),
};
