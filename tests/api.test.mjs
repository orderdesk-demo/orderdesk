/**
 * REST API tests: static files, reps and products, order CRUD, validation, filters,
 * dashboards and persistence. The whole suite runs against both storage engines.
 */
import { cleanupTempDirs, createReporter, freePort, startServer, tempDir } from './helpers.mjs';

const t = createReporter('REST API (SQLite + JSON engines)');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EXPECTED_KEYS = ['id', 'customer_name', 'product', 'quantity', 'unit_price', 'total', 'status',
  'rep_id', 'rep_name', 'rep_region', 'placed_offline', 'created_at', 'updated_at'];

async function runSuite(engine) {
  const check = (name, condition, extra) => t.check(`[${engine}] ${name}`, condition, extra);
  const port = await freePort();
  const env = { PORT: String(port), DATA_DIR: tempDir(`api-${engine}`), STORE_ENGINE: engine === 'json' ? 'json' : '' };
  const BASE = `http://localhost:${port}`;

  const call = async (method, url, body, raw) => {
    const res = await fetch(BASE + url, {
      method,
      headers: body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  let server = await startServer({ env });
  try {
    /* ---------- Static frontend ---------- */
    let r = await call('GET', '/');
    check('GET / serves index.html', r.status === 200 && r.text.includes('OrderDesk'));
    for (const asset of ['/styles.css', '/app.js', '/js/charts.js', '/js/leadership.js', '/js/rep.js']) {
      check(`GET ${asset}`, (await call('GET', asset)).status === 200);
    }

    /* ---------- Reference data ---------- */
    r = await call('GET', '/api/reps');
    const reps = r.json;
    check('GET /api/reps -> 6 reps', r.status === 200 && reps.length === 6, r.text);
    check('rep shape', eq(Object.keys(reps[0]), ['id', 'name', 'email', 'region', 'monthly_quota']), Object.keys(reps[0]));
    check('GET /api/reps/:id', (await call('GET', `/api/reps/${reps[0].id}`)).json?.name === reps[0].name);
    check('GET /api/reps/999 -> 404', (await call('GET', '/api/reps/999')).status === 404);
    check('GET /api/reps/abc -> 400', (await call('GET', '/api/reps/abc')).status === 400);
    r = await call('GET', '/api/products');
    check('GET /api/products -> 8 with prices', r.json.length === 8 && r.json.every((p) => p.product && p.unit_price > 0), r.text);

    /* ---------- List + filters ---------- */
    r = await call('GET', '/api/orders');
    let orderCount = r.json.length;
    check('GET /api/orders -> 300 seeded', r.status === 200 && orderCount === 300, orderCount);
    check('order key order', eq(Object.keys(r.json[0]), EXPECTED_KEYS), Object.keys(r.json[0]));
    check('newest first', r.json.every((o, i, a) => i === 0 || a[i - 1].created_at >= o.created_at));
    check('total = quantity × unit_price', r.json.every((o) => o.total === Math.round(o.quantity * o.unit_price * 100) / 100));

    const repId = reps[1].id;
    r = await call('GET', `/api/orders?rep_id=${repId}`);
    check('filter by rep_id', r.json.length > 0 && r.json.every((o) => o.rep_id === repId && o.rep_name === reps[1].name));
    r = await call('GET', '/api/orders?status=Processing');
    check('filter by status', r.json.length > 0 && r.json.every((o) => o.status === 'Processing'));
    r = await call('GET', `/api/orders?rep_id=${repId}&status=Delivered`);
    check('combined filters', r.json.every((o) => o.rep_id === repId && o.status === 'Delivered'));
    check('bad rep_id filter -> 400', (await call('GET', '/api/orders?rep_id=abc')).status === 400);
    check('bad status filter -> 400', (await call('GET', '/api/orders?status=Lost')).status === 400);

    /* ---------- Create ---------- */
    const VALID = { customer_name: 'Acme Retail', product: 'POS Terminal', quantity: 3, unit_price: 899, rep_id: reps[0].id };
    r = await call('POST', '/api/orders', VALID);
    const created = r.json;
    check('POST valid -> 201 with defaults', r.status === 201 && created.status === 'New' && created.placed_offline === false, r.text);
    check('POST derives total + rep', created.total === 2697 && created.rep_name === reps[0].name && created.rep_region === reps[0].region, r.text);
    check('POST sets timestamps + Location', created.created_at === created.updated_at && r.headers.get('location') === `/api/orders/${created.id}`);
    orderCount += 1;

    r = await call('POST', '/api/orders', { ...VALID, unit_price: 19.99, placed_offline: true });
    check('cents priced correctly (3 × 19.99 = 59.97)', r.status === 201 && r.json.total === 59.97 && r.json.placed_offline === true, r.text);
    const cheap = r.json;
    orderCount += 1;

    /* ---------- Validation ---------- */
    r = await call('POST', '/api/orders', { ...VALID, quantity: 0 });
    check('quantity 0 -> exact error', r.status === 400 && eq(r.json, { errors: ['quantity must be a positive integer'] }), r.text);
    r = await call('POST', '/api/orders', {});
    check('{} -> 5 required errors', r.status === 400 && r.json.errors.length === 5
      && ['customer_name', 'product', 'quantity', 'unit_price', 'rep_id'].every((f) => r.json.errors.includes(`${f} is required`)), r.text);
    r = await call('POST', '/api/orders', { customer_name: '  ', product: 'Y', quantity: '3', unit_price: -1, rep_id: 'x', status: 'Lost', placed_offline: 'yes', color: 'red' });
    check('7 errors collected together', r.status === 400 && r.json.errors.length === 7, r.text);
    r = await call('POST', '/api/orders', { ...VALID, unit_price: 1.005 });
    check('unit_price with > 2 decimals rejected', r.status === 400 && r.json.errors.includes('unit_price must have at most 2 decimal places'), r.text);
    check('unit_price as string rejected', (await call('POST', '/api/orders', { ...VALID, unit_price: '10' })).status === 400);
    r = await call('POST', '/api/orders', { ...VALID, rep_id: 999 });
    check('unknown rep rejected', r.status === 400 && eq(r.json.errors, ['rep_id 999 does not match a sales rep']), r.text);
    check('quantity 2.5 rejected', (await call('POST', '/api/orders', { ...VALID, quantity: 2.5 })).status === 400);
    r = await call('POST', '/api/orders', undefined, '{bad json');
    check('malformed JSON -> 400 JSON', r.status === 400 && eq(r.json, { errors: ['request body is not valid JSON'] }), r.text);
    check('array body -> 400', (await call('POST', '/api/orders', [1, 2])).status === 400);

    /* ---------- Read one ---------- */
    check('GET created -> 200', (await call('GET', `/api/orders/${created.id}`)).status === 200);
    r = await call('GET', '/api/orders/99999');
    check('GET missing -> 404', r.status === 404 && eq(r.json, { errors: ['order 99999 not found'] }), r.text);
    check('GET /abc -> 400', (await call('GET', '/api/orders/abc')).status === 400);

    /* ---------- Update ---------- */
    await sleep(5);
    r = await call('PUT', `/api/orders/${created.id}`, { status: 'Shipped' });
    check('PUT partial status', r.status === 200 && r.json.status === 'Shipped' && r.json.quantity === 3 && r.json.total === 2697, r.text);
    check('PUT bumps updated_at only', r.json.updated_at > created.updated_at && r.json.created_at === created.created_at);
    r = await call('PUT', `/api/orders/${created.id}`, { rep_id: reps[2].id });
    check('PUT reassigns rep', r.json.rep_id === reps[2].id && r.json.rep_name === reps[2].name, r.text);
    r = await call('PUT', `/api/orders/${created.id}`, { unit_price: 950 });
    check('PUT price recalculates total', r.json.total === 2850, r.text);
    r = await call('PUT', `/api/orders/${created.id}`, { placed_offline: true });
    check('PUT offline flag', r.json.placed_offline === true);
    check('PUT {} -> 400', (await call('PUT', `/api/orders/${created.id}`, {})).status === 400);
    check('PUT unknown rep -> 400', (await call('PUT', `/api/orders/${created.id}`, { rep_id: 999 })).status === 400);
    check('PUT missing order -> 404', (await call('PUT', '/api/orders/99999', { status: 'New' })).status === 404);
    const current = (await call('GET', `/api/orders/${created.id}`)).json;
    r = await call('PUT', `/api/orders/${created.id}`, { ...current, quantity: 7 });
    check('PUT round-tripped GET object (derived fields ignored)', r.status === 200 && r.json.quantity === 7 && r.json.total === 6650, r.text);

    /* ---------- Delete ---------- */
    check('DELETE -> 204', (await call('DELETE', `/api/orders/${cheap.id}`)).status === 204);
    check('DELETE again -> 404', (await call('DELETE', `/api/orders/${cheap.id}`)).status === 404);
    orderCount -= 1;
    r = await call('POST', '/api/orders', VALID);
    check('ids never reused', r.status === 201 && r.json.id === cheap.id + 1, r.text);
    orderCount += 1;

    /* ---------- Dashboards + insights ---------- */
    r = await call('GET', '/api/dashboard/leadership');
    const lead = r.json;
    check('leadership default 28 days', r.status === 200 && lead.range.days === 28, r.text);
    check('leadership shape', ['range', 'kpis', 'trend', 'reps', 'regions', 'pipeline', 'attention'].every((key) => key in lead)
      && lead.reps.length === 6 && lead.regions.length === 4 && lead.pipeline.length === 5, Object.keys(lead));
    check('leadership reps sum to revenue', Math.abs(lead.reps.reduce((s, x) => s + x.revenue, 0) - lead.kpis.revenue) < 0.05);
    r = await call('GET', '/api/dashboard/leadership?days=7');
    check('7 days -> 7 daily points', r.json.trend.granularity === 'day' && r.json.trend.points.length === 7, JSON.stringify(r.json.trend));
    for (const bad of ['0', 'abc', '400']) {
      check(`days=${bad} -> 400`, (await call('GET', `/api/dashboard/leadership?days=${bad}`)).status === 400);
    }
    r = await call('GET', `/api/dashboard/rep/${reps[0].id}`);
    check('rep dashboard', r.status === 200 && r.json.rep.id === reps[0].id && r.json.month.quota === reps[0].monthly_quota
      && ['on_track', 'at_risk', 'behind'].includes(r.json.month.pace), r.text);
    check('rep dashboard 404', (await call('GET', '/api/dashboard/rep/999')).status === 404);

    r = await call('GET', '/api/insights');
    check('insights reflect current count', r.json.summary.startsWith(`You have ${orderCount} orders`) && r.json.total === orderCount, r.json.summary);
    r = await call('GET', '/api/nope');
    check('unknown /api route -> JSON 404', r.status === 404 && Array.isArray(r.json?.errors));

    /* ---------- Persistence ---------- */
    await server.stop();
    server = await startServer({ env });
    r = await call('GET', '/api/orders');
    check('persists across restart, no reseed', r.json.length === orderCount && !server.log().includes('seeded'), `${r.json.length} vs ${orderCount}`);
  } finally {
    await server.stop();
  }
}

for (const engine of ['sqlite', 'json']) {
  try {
    await runSuite(engine);
  } catch (err) {
    t.fail(`[${engine}] suite crashed`, err);
  }
}
cleanupTempDirs();
t.finish();
