/**
 * Store + metrics tests: fresh seeding on both engines, engine parity, dashboard math,
 * and v1 -> v2 migrations (SQLite and JSON), including id-sequence preservation.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ISOLATED_ENV, ROOT, cleanupTempDirs, createReporter, tempDir } from './helpers.mjs';

const t = createReporter('Store, migrations and metrics');
const check = t.check;
const require = createRequire(path.join(ROOT, 'package.json'));
const sum = (items, pick) => items.reduce((s, x) => s + pick(x), 0);
const close = (a, b) => Math.abs(a - b) < 0.05;

let Database = null;
try { Database = require('better-sqlite3'); } catch { /* SQLite scenarios are skipped */ }

// Runs inside a child process so each scenario gets a fresh store module with its own DATA_DIR.
const PROBE = `
const store = require('./store');
store.init();
const { leadershipDashboard, repDashboard } = require('./metrics');
const { buildInsights } = require('./insights');
const orders = store.listOrders();
const reps = store.listReps();
let created = null;
if (process.env.PROBE_CREATE) {
  created = store.createOrder({ customer_name: 'Probe Co', product: 'POS Terminal', quantity: 2, unit_price: 899, rep_id: reps[0].id, placed_offline: true });
}
console.log('@@' + JSON.stringify({
  engine: store.engine,
  reps,
  all: orders,
  ids: orders.map((o) => o.id).sort((a, b) => a - b),
  keys: orders[0] ? Object.keys(orders[0]) : [],
  lead: leadershipDashboard(orders, reps, { days: 28 }),
  repView: reps.length ? repDashboard(orders, reps, reps[0].id) : null,
  insights: buildInsights(orders).summary,
  filtered: reps[0] ? store.listOrders({ repId: reps[0].id, status: 'Processing' }).map((o) => [o.rep_id, o.status]) : [],
  created,
}));
`;

function probe(env) {
  const out = execFileSync(process.execPath, ['-e', PROBE], {
    cwd: ROOT,
    env: { ...process.env, ...ISOLATED_ENV, ...env },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const marker = out.lastIndexOf('@@');
  return { log: out.slice(0, marker), data: JSON.parse(out.slice(marker + 2)) };
}

const EXPECTED_KEYS = ['id', 'customer_name', 'product', 'quantity', 'unit_price', 'total', 'status',
  'rep_id', 'rep_name', 'rep_region', 'placed_offline', 'created_at', 'updated_at'];

const V1_ORDERS_SQL = `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, product TEXT NOT NULL,
  quantity INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'New', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

try {
  /* ---------- 1. Fresh SQLite ---------- */
  const primary = probe({ DATA_DIR: tempDir('store-fresh'), STORE_ENGINE: Database ? '' : 'json' });
  const d1 = primary.data;
  check('fresh store: seed log', primary.log.includes('seeded with 6 sales reps and 300 orders'), primary.log);
  check('fresh store: 300 orders, 6 reps', d1.all.length === 300 && d1.reps.length === 6);
  check('order key order', JSON.stringify(d1.keys) === JSON.stringify(EXPECTED_KEYS), d1.keys);
  check('derived fields on every order', d1.all.every((o) => o.total === Math.round(o.quantity * o.unit_price * 100) / 100
    && typeof o.rep_name === 'string' && typeof o.placed_offline === 'boolean'));
  check('rep + status filter', d1.filtered.length > 0 && d1.filtered.every(([rep, status]) => rep === d1.reps[0].id && status === 'Processing'), JSON.stringify(d1.filtered));
  check('offline share roughly 30%', Math.abs(d1.all.filter((o) => o.placed_offline).length / 300 - 0.3) < 0.08);
  const openSeed = d1.all.filter((o) => ['New', 'Processing'].includes(o.status));
  check('seed: open orders are all from the last 14 days', openSeed.length > 0 && openSeed.every((o) => Date.now() - Date.parse(o.created_at) < 14 * 864e5));

  const { lead } = d1;
  const k = lead.kpis;
  check('28-day trend: 4 full weeks', lead.trend.granularity === 'week' && lead.trend.points.length === 4 && lead.trend.points.every((p) => !p.partial), JSON.stringify(lead.trend));
  check('trend sums to revenue and orders', close(sum(lead.trend.points, (p) => p.revenue), k.revenue) && sum(lead.trend.points, (p) => p.orders) === k.orders);
  check('reps sorted by revenue and sum to revenue', lead.reps.every((r, i) => i === 0 || lead.reps[i - 1].revenue >= r.revenue) && close(sum(lead.reps, (r) => r.revenue), k.revenue));
  check('pipeline: 5 stages summing to orders', lead.pipeline.length === 5 && sum(lead.pipeline, (s) => s.orders) === k.orders);
  check('regions: 4 summing to revenue', lead.regions.length === 4 && close(sum(lead.regions, (r) => r.revenue), k.revenue));
  check('revenue > 0, attainment plausible', k.revenue > 0 && k.attainment > 0.3 && k.attainment < 2, JSON.stringify(k));
  check('deltas computed', k.revenue_change_pct !== null && k.offline_share_change_pts !== null);
  check('attention list sorted longest-waiting first', lead.attention.total > 0 && lead.attention.orders.every((o, i, a) => i === 0 || a[i - 1].hours_since_update >= o.hours_since_update));
  const rv = d1.repView;
  check('rep dashboard: month, pace, rank', rv.month.quota === d1.reps[0].monthly_quota && ['on_track', 'at_risk', 'behind'].includes(rv.month.pace)
    && rv.month.team_rank >= 1 && rv.month.team_rank <= 6, JSON.stringify(rv.month));
  check('insights mention booked value and top rep', /in booked value/.test(d1.insights) && /Top rep by booked value/.test(d1.insights), d1.insights);

  /* ---------- 2. JSON engine parity ---------- */
  const json = probe({ DATA_DIR: tempDir('store-json'), STORE_ENGINE: 'json' }).data;
  check('JSON engine: same orders, totals, keys and reps', json.engine.startsWith('JSON') && json.all.length === 300
    && close(sum(json.all, (o) => o.total), sum(d1.all, (o) => o.total))
    && JSON.stringify(json.keys) === JSON.stringify(EXPECTED_KEYS) && JSON.stringify(json.reps) === JSON.stringify(d1.reps));

  if (Database) {
    const now = new Date().toISOString();

    /* ---------- 3. v1 SQLite database (the original schema) ---------- */
    const dir3 = tempDir('store-v1');
    const v1 = new Database(path.join(dir3, 'orders.db'));
    v1.exec(V1_ORDERS_SQL);
    const insert = v1.prepare('INSERT INTO orders (customer_name, product, quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const v1Rows = [
      ['Greenleaf Grocers', 'Mobile Card Reader', 5, 'Delivered'],
      ['Summit Outdoor Co.', 'Rugged Field Tablet', 15, 'Shipped'],
      ['Northwind Traders', 'Handheld Barcode Scanner', 25, 'Processing'],
      ['Acme Retail', 'POS', 1, 'New'],
    ];
    for (const [customer, product, qty, status] of v1Rows) insert.run(customer, product, qty, status, now, now);
    v1.close();

    const m3 = probe({ DATA_DIR: dir3 });
    const byId = new Map(m3.data.all.map((o) => [o.id, o]));
    check('v1 SQLite: migration logged, orders kept', m3.log.includes('Migrated database to schema v2') && JSON.stringify(m3.data.ids) === '[1,2,3,4]', m3.log);
    check('v1 SQLite: original fields unchanged', v1Rows.every(([customer, product, qty, status], i) => {
      const o = byId.get(i + 1);
      return o.customer_name === customer && o.product === product && o.quantity === qty && o.status === status && o.created_at === now;
    }));
    check('v1 SQLite: reps assigned, catalog prices backfilled', m3.data.all.every((o) => o.rep_name)
      && byId.get(1).unit_price === 59 && byId.get(4).unit_price === 899, JSON.stringify(m3.data.all.map((o) => [o.product, o.unit_price])));
    const again = probe({ DATA_DIR: dir3 });
    check('v1 SQLite: second start does not migrate again', !again.log.includes('Migrated') && again.data.all.length === 4, again.log);
    const migrated = new Database(path.join(dir3, 'orders.db'), { readonly: true });
    check('v1 SQLite: user_version 2, foreign keys valid', migrated.pragma('user_version', { simple: true }) === 2 && migrated.pragma('foreign_key_check').length === 0);
    migrated.close();

    /* ---------- 4. Deleted ids stay retired across the migration ---------- */
    const dir4 = tempDir('store-seq');
    const seqDb = new Database(path.join(dir4, 'orders.db'));
    seqDb.exec(V1_ORDERS_SQL);
    const seqInsert = seqDb.prepare('INSERT INTO orders (customer_name, product, quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 5; i += 1) seqInsert.run(`Customer ${i}`, 'Mystery Widget', 2, 'New', now, now);
    seqDb.prepare('DELETE FROM orders WHERE id IN (4, 5)').run();
    seqDb.close();
    const m4 = probe({ DATA_DIR: dir4, PROBE_CREATE: '1' });
    check('unknown product gets the default price', m4.data.all.every((o) => o.unit_price === 99));
    check('ids never reused after migration (next id is 6)', m4.data.created?.id === 6, JSON.stringify(m4.data.created));
    check('created order derived fields', m4.data.created?.total === 1798 && m4.data.created.placed_offline === true && Boolean(m4.data.created.rep_name));
  } else {
    console.log('  SKIP  SQLite migration scenarios (better-sqlite3 not installed)');
  }

  /* ---------- 5. v1 JSON store ---------- */
  const dir5 = tempDir('store-json-v1');
  const stamp = new Date().toISOString();
  writeFileSync(path.join(dir5, 'orders.json'), JSON.stringify({
    nextId: 8,
    orders: [
      { id: 3, customer_name: 'Old JSON Co', product: 'Label Printer', quantity: 4, status: 'Shipped', created_at: stamp, updated_at: stamp },
      { id: 7, customer_name: 'Another Co', product: 'Cash Drawer', quantity: 1, status: 'New', created_at: stamp, updated_at: stamp },
    ],
  }));
  const m5 = probe({ DATA_DIR: dir5, STORE_ENGINE: 'json', PROBE_CREATE: '1' });
  const byId5 = new Map(m5.data.all.map((o) => [o.id, o]));
  check('v1 JSON: migrated, orders kept', m5.log.includes('Migrated JSON store') && JSON.stringify(m5.data.ids) === '[3,7]', m5.log);
  check('v1 JSON: catalog prices', byId5.get(3)?.unit_price === 329 && byId5.get(7)?.unit_price === 119);
  check('v1 JSON: next id continues at 8', m5.data.created?.id === 8, JSON.stringify(m5.data.created));
  const saved = JSON.parse(readFileSync(path.join(dir5, 'orders.json'), 'utf8'));
  check('v1 JSON: saved as version 2 with 6 reps', saved.version === 2 && saved.reps.length === 6);
} catch (err) {
  t.fail('suite crashed', err);
}

cleanupTempDirs();
t.finish();
