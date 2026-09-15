/**
 * DevRev integration tests against a MOCK DevRev API (no network, no real token):
 * the setup/sync/list CLI, background sync hooks in the server, ordering, recovery and reconcile.
 */
import { execFile } from 'node:child_process';
import http from 'node:http';
import { ISOLATED_ENV, ROOT, cleanupTempDirs, createReporter, freePort, startServer, tempDir } from './helpers.mjs';

const t = createReporter('DevRev sync (mock DevRev API)');
const check = t.check;
const TOKEN = 'test-pat-123';
const SEEDED = 300;

/* ---------------- Mock DevRev API ---------------- */
const objects = new Map();
let seq = 0;
let schema = null;
let failNext = 0;

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.method !== 'POST') return send(405, { message: 'POST only' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'unauthorized' });
  if (failNext > 0) { failNext -= 1; return send(400, { message: 'simulated DevRev failure' }); }

  const b = raw ? JSON.parse(raw) : {};
  switch (req.url.slice(1)) {
    case 'schemas.custom.set':
      schema = b;
      return send(201, { id: 'don:core:dvrv-us-1:devo/test:tenant_fragment/1' });

    case 'custom-objects.create': {
      if (!schema || b.leaf_type !== schema.leaf_type) return send(400, { message: 'unknown leaf type' });
      if (!b.custom_schema_spec?.tenant_fragment) return send(400, { message: 'custom_schema_spec.tenant_fragment required' });
      const allowed = new Set(schema.fields.map((f) => `tnt__${f.name}`));
      const unknown = Object.keys(b.custom_fields || {}).filter((key) => !allowed.has(key));
      if (unknown.length) return send(400, { message: `fields without schema: ${unknown}` });
      if ([...objects.values()].some((o) => o.unique_key === b.unique_key)) return send(409, { message: 'duplicate unique_key' });
      seq += 1;
      const obj = { id: `don:core:dvrv-us-1:devo/test:custom_object/order/${seq}`, display_id: `C-ORD-${seq}`, leaf_type: b.leaf_type, title: b.title, unique_key: b.unique_key, custom_fields: { ...b.custom_fields } };
      objects.set(obj.id, obj);
      return send(201, { custom_object: obj });
    }

    case 'custom-objects.update': {
      const obj = objects.get(b.id);
      if (!obj) return send(404, { message: 'not found' });
      Object.assign(obj.custom_fields, b.custom_fields);
      if (b.title) obj.title = b.title;
      return send(200, { custom_object: obj });
    }

    case 'custom-objects.delete':
      return objects.delete(b.id) ? send(200, {}) : send(404, { message: 'not found' });

    case 'custom-objects.list': {
      let list = [...objects.values()].filter((o) => o.leaf_type === b.leaf_type);
      if (b.filter) {
        const [op, field, value] = b.filter;
        if (op !== 'eq') return send(400, { message: 'unsupported op' });
        const key = field.replace('$custom_fields.', '');
        list = list.filter((o) => o.custom_fields[key] === value);
      }
      const pageSize = Math.min(b.limit || 50, 25); // small pages exercise cursor pagination
      const start = b.cursor ? Number(b.cursor) : 0;
      const next = start + pageSize < list.length ? String(start + pageSize) : undefined;
      return send(200, { result: list.slice(start, start + pageSize), next_cursor: next });
    }

    default:
      return send(404, { message: 'unknown endpoint' });
  }
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockPort = mock.address().port;

/* ---------------- Helpers ---------------- */
const DEVREV_ENV = { DATA_DIR: tempDir('devrev'), DEVREV_PAT: TOKEN, DEVREV_API_BASE: `http://127.0.0.1:${mockPort}` };

const cli = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, ['tools/devrev-sync.js', ...args], {
    cwd: ROOT, env: { ...process.env, ...ISOLATED_ENV, ...DEVREV_ENV, ...env }, maxBuffer: 10 * 1024 * 1024,
  }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
});
const byOrder = (id) => [...objects.values()].filter((o) => o.custom_fields.tnt__order_id === id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

let server = null;
try {
  /* ---------------- CLI ---------------- */
  let r = await cli(['setup']);
  check('setup exits 0', r.code === 0, r.out);
  check('schema: custom leaf type "order"', schema?.leaf_type === 'order' && schema.is_custom_leaf_type === true && schema.type === 'tenant_fragment', JSON.stringify(schema));
  const fieldNames = schema?.fields.map((f) => f.name) || [];
  check('schema: 11 fields incl. value, rep, region, offline', fieldNames.length === 11
    && ['order_value', 'sales_rep', 'region', 'placed_offline'].every((name) => fieldNames.includes(name)), fieldNames);

  r = await cli(['sync']);
  check(`first sync creates ${SEEDED} objects`, r.code === 0 && r.out.includes(`${SEEDED} created, 0 updated`) && objects.size === SEEDED, r.out.slice(-400));
  const sample = [...objects.values()][0];
  const f = sample.custom_fields;
  check('title + typed custom fields', sample.title === `Order #${f.tnt__order_id}: ${f.tnt__quantity} × ${f.tnt__product} (${f.tnt__customer_name})`
    && typeof f.tnt__order_value === 'number' && typeof f.tnt__sales_rep === 'string' && typeof f.tnt__region === 'string'
    && typeof f.tnt__placed_offline === 'boolean' && sample.unique_key === `orderdesk-order-${f.tnt__order_id}`, JSON.stringify(sample));

  r = await cli(['sync']);
  check('second sync is idempotent (paginated list)', r.out.includes(`0 created, ${SEEDED} updated, 0 deleted`) && objects.size === SEEDED, r.out.slice(-400));
  r = await cli(['list']);
  check('list prints DevRev display IDs', r.code === 0 && r.out.includes('C-ORD-1'));
  r = await cli(['sync'], { DEVREV_PAT: 'wrong-token' });
  check('bad token: exit 1 with a 401 message', r.code === 1 && r.out.includes('401'), r.out);

  /* ---------------- Server live hooks ---------------- */
  const appPort = await freePort();
  server = await startServer({ env: { ...DEVREV_ENV, PORT: String(appPort) }, readyText: 'DevRev sync:' });
  const APP = `http://localhost:${appPort}`;
  const api = async (method, url, body) => {
    const res = await fetch(APP + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };

  check('server logs DevRev sync: live', server.log().includes('DevRev sync: live'), server.log());
  r = await api('GET', '/api/devrev/status');
  check('status endpoint: live, token never exposed', r.json.mode === 'live' && !r.text.includes(TOKEN), r.text);

  const reps = (await api('GET', '/api/reps')).json;
  const ORDER = { customer_name: 'Contoso', product: 'Kiosk', quantity: 4, unit_price: 4999, rep_id: reps[0].id };

  r = await api('POST', '/api/orders', ORDER);
  const newId = r.json.id;
  check('POST creates a DevRev object with value + rep', await waitFor(() => byOrder(newId)[0]?.custom_fields.tnt__order_value === 19996
    && byOrder(newId)[0].custom_fields.tnt__sales_rep === reps[0].name));

  await api('PUT', `/api/orders/${newId}`, { status: 'Shipped', rep_id: reps[1].id });
  check('PUT syncs status + reassigned rep', await waitFor(() => byOrder(newId)[0]?.custom_fields.tnt__status === 'Shipped'
    && byOrder(newId)[0].custom_fields.tnt__sales_rep === reps[1].name));

  r = await api('POST', '/api/orders', { ...ORDER, customer_name: 'Fabrikam', quantity: 2 });
  const rapidId = r.json.id;
  await api('PUT', `/api/orders/${rapidId}`, { quantity: 9 });
  await waitFor(() => byOrder(rapidId)[0]?.custom_fields.tnt__quantity === 9);
  await sleep(300);
  check('rapid create + update: exactly one object with the latest values', byOrder(rapidId).length === 1 && byOrder(rapidId)[0].custom_fields.tnt__quantity === 9);

  await api('DELETE', `/api/orders/${newId}`);
  check('DELETE removes the DevRev object', await waitFor(() => byOrder(newId).length === 0));

  objects.delete(byOrder(rapidId)[0].id);
  await api('PUT', `/api/orders/${rapidId}`, { status: 'Processing' });
  check('update after a manual delete in DevRev recreates the object', await waitFor(() => byOrder(rapidId)[0]?.custom_fields.tnt__status === 'Processing'));

  failNext = 1;
  r = await api('POST', '/api/orders', { ...ORDER, customer_name: 'Tailspin', quantity: 1 });
  const failedId = r.json?.id;
  check('DevRev failure never breaks the OrderDesk API (201)', r.status === 201, r.text);
  await sleep(400);
  r = await api('GET', '/api/devrev/status');
  check('status shows the last error', r.json.lastError?.message.includes('simulated DevRev failure'), r.text);
  check('failed order not in DevRev yet', byOrder(failedId).length === 0);

  const orphan = { id: 'don:core:dvrv-us-1:devo/test:custom_object/order/9999', display_id: 'C-ORD-9999', leaf_type: 'order', title: 'orphan', unique_key: 'orderdesk-order-9999', custom_fields: { tnt__order_id: 9999 } };
  objects.set(orphan.id, orphan);
  r = await cli(['sync']);
  check('reconcile creates the missed order and deletes the orphan', r.out.includes('1 created') && r.out.includes('1 deleted')
    && byOrder(failedId).length === 1 && byOrder(9999).length === 0, r.out.slice(-400));
  r = await api('GET', '/api/orders');
  check('DevRev and OrderDesk match', objects.size === r.json.length, `${objects.size} vs ${r.json.length}`);
} catch (err) {
  t.fail('suite crashed', err);
} finally {
  if (server) await server.stop();
  mock.close();
}

cleanupTempDirs();
t.finish();
