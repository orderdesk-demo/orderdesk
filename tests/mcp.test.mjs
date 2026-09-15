/**
 * MCP server tests using the official MCP SDK client over Streamable HTTP:
 * tool list, every tool, filters, errors, API-key auth (header and ?key=) and write access.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT, cleanupTempDirs, createReporter, freePort, startServer, tempDir } from './helpers.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const t = createReporter('MCP server');
const check = t.check;

const textOf = (result) => (result.content || []).map((c) => c.text).join('\n');
/** Tool results are "summary\n\nJSON". */
const dataOf = (result) => {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('\n\n') + 2));
};

async function connect(port, headers, query = '') {
  const client = new Client({ name: 'orderdesk-test', version: '1.0.0' });
  const url = new URL(`http://localhost:${port}/mcp${query}`);
  await client.connect(new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined));
  return client;
}

async function expectToolError(client, name, args) {
  try {
    return (await client.callTool({ name, arguments: args })).isError === true;
  } catch {
    return true; // the SDK may throw McpError for invalid params
  }
}

async function startMcpServer(env = {}) {
  const port = await freePort();
  const server = await startServer({ env: { PORT: String(port), DATA_DIR: tempDir('mcp'), ...env }, readyText: 'MCP server:' });
  const rest = async (p) => (await fetch(`http://localhost:${port}${p}`)).json();
  return { port, server, rest };
}

/* ---------------- Read-only server, no auth ---------------- */
{
  const { port, server, rest } = await startMcpServer();
  try {
    check('startup log: no auth, read-only', server.log().includes(`MCP server: http://localhost:${port}/mcp (no auth, read-only)`), server.log());

    const client = await connect(port);
    check('server identifies as orderdesk', client.getServerVersion()?.name === 'orderdesk', JSON.stringify(client.getServerVersion()));
    check('instructions describe the domain', (client.getInstructions() || '').includes('field sales team'));

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    check('5 read-only tools', JSON.stringify(names) === JSON.stringify(['find_stale_orders', 'get_order', 'get_order_insights', 'get_sales_performance', 'search_orders']), names);
    check('tools described + marked read-only', tools.every((tool) => tool.description?.length > 20 && tool.annotations?.readOnlyHint === true));
    const search = tools.find((tool) => tool.name === 'search_orders');
    check('search_orders exposes rep, region and status filters', ['rep', 'region', 'status'].every((key) => key in search.inputSchema.properties));

    const processing = await rest('/api/orders?status=Processing');
    let r = await client.callTool({ name: 'search_orders', arguments: { status: 'Processing', limit: 100 } });
    check('search by status matches REST', textOf(r).startsWith(`Found ${processing.length} order(s)`) && dataOf(r).every((o) => o.status === 'Processing'), textOf(r).split('\n')[0]);
    r = await client.callTool({ name: 'search_orders', arguments: { query: 'KIOSK', limit: 100 } });
    check('free-text search is case-insensitive', dataOf(r).length > 0 && dataOf(r).every((o) => o.product === 'Self-Checkout Kiosk'));
    r = await client.callTool({ name: 'search_orders', arguments: { rep: 'priya', limit: 100 } });
    check('rep filter', dataOf(r).length > 0 && dataOf(r).every((o) => o.rep_name === 'Priya Sharma') && textOf(r).includes('rep Priya Sharma (West)'));
    r = await client.callTool({ name: 'search_orders', arguments: { region: 'South', limit: 100 } });
    check('region filter', dataOf(r).length > 0 && dataOf(r).every((o) => o.rep_region === 'South'));
    r = await client.callTool({ name: 'search_orders', arguments: { customer: 'acme', min_quantity: 10, limit: 100 } });
    check('customer + min_quantity filters', dataOf(r).every((o) => o.customer_name === 'Acme Retail' && o.quantity >= 10));
    r = await client.callTool({ name: 'search_orders', arguments: {} });
    check('default limit 20, newest first', textOf(r).includes('showing the first 20') && dataOf(r).length === 20
      && dataOf(r).every((o, i, a) => i === 0 || a[i - 1].created_at >= o.created_at));
    r = await client.callTool({ name: 'search_orders', arguments: { customer: 'zzzz-nobody' } });
    check('no-match message', textOf(r).startsWith('No orders match'));

    const anyOrder = (await rest('/api/orders'))[0];
    r = await client.callTool({ name: 'get_order', arguments: { id: anyOrder.id } });
    check('get_order returns value + rep', dataOf(r).total === anyOrder.total && textOf(r).includes(anyOrder.rep_name) && !r.isError);
    r = await client.callTool({ name: 'get_order', arguments: { id: String(anyOrder.id) } });
    check('get_order accepts a string id', dataOf(r).id === anyOrder.id);
    r = await client.callTool({ name: 'get_order', arguments: { id: 99999 } });
    check('missing order -> isError', r.isError === true && textOf(r).includes('not found'));

    r = await client.callTool({ name: 'get_order_insights', arguments: {} });
    check('insights summary', textOf(r).startsWith('You have 300 orders') && textOf(r).includes('Top rep by booked value'));

    const lead = await rest('/api/dashboard/leadership?days=28');
    r = await client.callTool({ name: 'get_sales_performance', arguments: { days: 28 } });
    check('sales performance matches the REST dashboard', dataOf(r).kpis.revenue === lead.kpis.revenue && dataOf(r).kpis.orders === lead.kpis.orders);
    check('sales performance text lists every rep', textOf(r).startsWith('Last 28 days:') && lead.reps.every((rep) => textOf(r).includes(rep.name)));
    r = await client.callTool({ name: 'get_sales_performance', arguments: {} });
    check('sales performance defaults to 28 days', dataOf(r).range.days === 28);

    r = await client.callTool({ name: 'find_stale_orders', arguments: { hours: 48 } });
    check('stale orders (48h) match dashboard attention', textOf(r).startsWith(`${lead.attention.total} open order(s)`), textOf(r).split('\n')[0]);
    r = await client.callTool({ name: 'find_stale_orders', arguments: { hours: 100000 } });
    check('stale orders: none beyond the history', textOf(r).startsWith('No open orders have gone 100000h'));

    check('invalid status rejected', await expectToolError(client, 'search_orders', { status: 'Lost' }));
    check('invalid region rejected', await expectToolError(client, 'search_orders', { region: 'Mars' }));
    check('update tool unavailable when read-only', await expectToolError(client, 'update_order_status', { id: 1, status: 'New' }));
    check('GET /mcp -> 405', (await fetch(`http://localhost:${port}/mcp`)).status === 405);
    await client.close();
  } catch (err) {
    t.fail('read-only server', err);
  } finally {
    await server.stop();
  }
}

/* ---------------- API key + writes enabled ---------------- */
{
  const { port, server, rest } = await startMcpServer({ MCP_API_KEY: 'secret-key-123', MCP_ALLOW_WRITES: 'true' });
  try {
    check('startup log: key required + writes', server.log().includes('(API key required, status updates enabled)'), server.log());

    const noAuth = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('no API key -> 401', noAuth.status === 401);

    let rejected = false;
    try { await connect(port, { Authorization: 'Bearer wrong' }); } catch { rejected = true; }
    check('wrong API key rejected', rejected);

    const viaQuery = await connect(port, undefined, '?key=secret-key-123');
    check('?key= in the URL accepted', (await viaQuery.listTools()).tools.length === 6);
    await viaQuery.close();
    const foreign = await connect(port, { Authorization: 'Bearer some-other-token' }, '?key=secret-key-123');
    check('?key= works alongside a foreign Authorization header', (await foreign.listTools()).tools.length === 6);
    await foreign.close();
    let queryRejected = false;
    try { await connect(port, undefined, '?key=wrong'); } catch { queryRejected = true; }
    check('wrong ?key= rejected', queryRejected);

    const client = await connect(port, { Authorization: 'Bearer secret-key-123' });
    const { tools } = await client.listTools();
    check('6 tools including update_order_status', tools.length === 6 && tools.some((tool) => tool.name === 'update_order_status'));

    const target = (await rest('/api/orders?status=New'))[0];
    let r = await client.callTool({ name: 'update_order_status', arguments: { id: target.id, status: 'Shipped' } });
    check('update_order_status reports the change', textOf(r).includes('moved from New to Shipped'), textOf(r));
    check('change visible through REST', (await rest(`/api/orders/${target.id}`)).status === 'Shipped');
    r = await client.callTool({ name: 'update_order_status', arguments: { id: target.id, status: 'Shipped' } });
    check('repeat is idempotent', textOf(r).includes('already Shipped'));
    check('invalid status rejected', await expectToolError(client, 'update_order_status', { id: target.id, status: 'Lost' }));
    await client.close();
  } catch (err) {
    t.fail('key + writes server', err);
  } finally {
    await server.stop();
  }
}

cleanupTempDirs();
t.finish();
