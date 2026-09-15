/**
 * Browser end-to-end test (headless Chrome via puppeteer-core): mock login, Leadership and
 * Sales Rep dashboards, charts, one-click status, new order, detail view, phone width, logout.
 *
 * Usage: npm run test:ui   (set CHROME_PATH if Chrome isn't in the default macOS location)
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { cleanupTempDirs, createReporter, freePort, startServer, tempDir } from './helpers.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at "${CHROME}". Set CHROME_PATH to your Chrome or Chromium binary.`);
  process.exit(1);
}

const t = createReporter('Browser end-to-end');
const check = t.check;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format;

const port = await freePort();
const BASE = `http://localhost:${port}/`;
const server = await startServer({ env: { PORT: String(port), DATA_DIR: tempDir('ui') } });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// JS exceptions, console errors (other than network logs), failed requests and unexpected HTTP errors
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text()}`);
});
page.on('requestfailed', (r) => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
page.on('response', (r) => {
  const expected = (r.url().endsWith('/api/orders/99999') && r.status() === 404)
    || (r.request().method() === 'POST' && r.url().endsWith('/api/orders') && r.status() === 400);
  if (r.status() >= 400 && !expected) problems.push(`unexpected ${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on('dialog', (dialog) => dialog.accept()); // confirm() on delete

const apiJson = async (p) => (await fetch(BASE + p)).json();
const waitFor = (fn, ...args) => page.waitForFunction(fn, { timeout: 8000 }, ...args);
const waitToast = (text) => waitFor((expected) => document.querySelector('#toast').textContent.includes(expected), text);
const visible = (selector) => page.$eval(selector, (el) => !el.hidden && !el.closest('[hidden]')).catch(() => false);
const text = (selector) => page.$eval(selector, (el) => el.textContent.trim());
const ariaCurrent = (selector) => page.$eval(selector, (el) => el.getAttribute('aria-current'));
const scrollTop = () => page.evaluate(() => window.scrollTo(0, 0));
/** Page width plus elements poking past the viewport (ignoring content inside horizontal scrollers). */
const overflowReport = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.table-wrap') && !el.classList.contains('table-wrap')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className)} right=${Math.round(r.right)}`);
  }
  return { ok: document.documentElement.scrollWidth <= vw, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 10) };
});

try {
  /* ---------- 1. Mock login ---------- */
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await waitFor(() => location.hash === '#/login');
  check('unauthenticated visit redirects to #/login', (await visible('#login-view')) && !(await visible('#app-shell')));

  await page.$eval('#login-email', (el) => { el.value = 'not-an-email'; });
  await page.click('#login-form button[type="submit"]');
  check('invalid email shows an error', await visible('#login-error'));

  await page.$eval('#login-email', (el) => { el.value = 'alex.morgan@orderdesk.demo'; });
  await page.click('#login-form button[type="submit"]');
  await waitFor(() => location.hash === '#/leadership');
  await page.waitForSelector('#leadership-view .stat-tile');
  check('sign-in opens the Leadership tab', (await visible('#leadership-view')) && (await ariaCurrent('#tab-leadership')) === 'page');
  check('user name derived from email', (await text('#user-name')) === 'Alex Morgan');

  /* ---------- 2. Leadership dashboard ---------- */
  await waitFor(() => document.querySelectorAll('#leadership-view .chart-card').length === 4
    && document.querySelectorAll('[data-slot="leaderboard"] tr').length === 6);
  const lead = await apiJson('api/dashboard/leadership?days=28');
  check('6 KPI tiles', (await page.$$('#leadership-view .stat-tile')).length === 6);
  const tileValues = await page.$$eval('#leadership-view .stat-tile-value', (els) => els.map((e) => e.textContent));
  check('attainment tile matches the API', tileValues[1] === `${Math.round(lead.kpis.attainment * 100)}%`, `${tileValues} vs ${lead.kpis.attainment}`);
  check('trend: 4 weekly columns', (await page.$$('[data-slot="chart-trend"] .hit')).length === 4);
  check('attainment: 6 bars with a quota reference', (await page.$$('[data-slot="chart-attainment"] .bar-row')).length === 6
    && (await page.$$('[data-slot="chart-attainment"] .bar-ref')).length === 6);
  check('pipeline: 5 stages', (await page.$$('[data-slot="chart-pipeline"] .bar-row')).length === 5);
  check('regions: 4', (await page.$$('[data-slot="chart-regions"] .bar-row')).length === 4);
  check('needs-attention list', (await page.$$('[data-slot="attention"] .attention-item')).length === Math.min(5, lead.attention.total));
  check('AI insights loaded', (await text('[data-slot="insights"]')).startsWith('You have 300 orders'));

  const hits = await page.$$('[data-slot="chart-trend"] .hit');
  await hits[hits.length - 1].hover();
  await page.waitForSelector('[data-slot="chart-trend"] .chart-tooltip:not([hidden])');
  check('column hover shows a tooltip', (await text('[data-slot="chart-trend"] .chart-tooltip')).includes('$'));

  await page.click('[data-slot="chart-trend"] .chart-head button');
  check('table view toggles on with 4 rows', (await visible('[data-slot="chart-trend"] .chart-table'))
    && (await page.$$('[data-slot="chart-trend"] .chart-table tbody tr')).length === 4);
  await page.click('[data-slot="chart-trend"] .chart-head button');

  await scrollTop(); // the filter row sits near the top, under where the sticky bar would cover it
  await page.click('[data-slot="ranges"] button[data-days="7"]');
  await waitFor(() => document.querySelectorAll('[data-slot="chart-trend"] .hit').length === 7);
  check('7-day range: daily trend', (await page.$eval('[data-slot="ranges"] button[data-days="7"]', (b) => b.getAttribute('aria-pressed'))) === 'true');
  await scrollTop();
  await page.click('[data-slot="ranges"] button[data-days="28"]');
  await waitFor(() => document.querySelectorAll('[data-slot="chart-trend"] .hit').length === 4);

  /* ---------- 3. Leaderboard -> Sales Rep dashboard ---------- */
  const topRep = lead.reps[0];
  await page.click(`[data-slot="leaderboard"] a[href="#/rep/${topRep.id}"]`);
  await waitFor((id) => location.hash === `#/rep/${id}`, topRep.id);
  await page.waitForSelector('#rep-view .hero-figure');
  const repOrders = await apiJson(`api/orders?rep_id=${topRep.id}`);
  await waitFor((n) => document.querySelectorAll('[data-slot="orders"] tr').length === n, repOrders.length);
  check('Sales Rep tab active with the chosen rep', (await ariaCurrent('#tab-rep')) === 'page'
    && (await page.$eval('[data-slot="rep-select"]', (s) => s.value)) === String(topRep.id));
  check('My orders lists every order for the rep', (await page.$$('[data-slot="orders"] tr')).length === repOrders.length);
  const repDash = await apiJson(`api/dashboard/rep/${topRep.id}`);
  check('hero shows month-to-date revenue', (await text('#rep-view .hero-figure')) === usd(repDash.month.revenue));

  /* ---------- 4. One-click status ---------- */
  const firstRow = repOrders[0];
  const nextStatus = firstRow.status === 'Shipped' ? 'Delivered' : 'Shipped';
  await page.select(`[data-slot="orders"] select[data-id="${firstRow.id}"]`, nextStatus);
  await waitToast(`Order #${firstRow.id} moved to ${nextStatus}`);
  check('inline status change saved', (await apiJson(`api/orders/${firstRow.id}`)).status === nextStatus);

  /* ---------- 5. New order ---------- */
  await page.click('#rep-view [data-action="new-order"]');
  await page.waitForSelector('#order-dialog[open]');
  check('new order defaults to the viewed rep', (await page.$eval('#rep_id', (s) => s.value)) === String(topRep.id));
  await waitFor(() => document.querySelectorAll('#product-options option').length === 8);
  await page.type('#customer_name', 'Canyon Coffee Co.');
  await page.type('#product', 'POS Terminal');
  check('list price autofilled from the catalog', (await page.$eval('#unit_price', (e) => e.value)) === '899');
  await page.$eval('#quantity', (e) => { e.value = ''; });
  await page.type('#quantity', '2');
  check('live order value preview', (await text('#value-preview')) === 'Order value: $1,798.00');
  await page.click('#placed_offline');
  await page.click('#save-btn');
  await waitToast('created');
  const newId = Number((await text('#toast')).match(/#(\d+)/)[1]);
  const created = await apiJson(`api/orders/${newId}`);
  check('created order has rep, value and offline flag', created.rep_id === topRep.id && created.total === 1798 && created.placed_offline === true, JSON.stringify(created));

  await page.click('#rep-view [data-action="new-order"]');
  await page.waitForSelector('#order-dialog[open]');
  await page.type('#customer_name', 'No Price Co');
  await page.type('#product', 'Custom Bundle');
  await page.click('#save-btn');
  await page.waitForSelector('#form-errors:not([hidden])');
  check('API validation errors shown in the form', (await text('#form-errors')).includes('unit_price is required'), await text('#form-errors'));
  await page.click('#cancel-btn');

  /* ---------- 6. Switch rep + order detail ---------- */
  const otherRep = lead.reps[lead.reps.length - 1];
  const otherOrders = await apiJson(`api/orders?rep_id=${otherRep.id}`);
  await page.select('[data-slot="rep-select"]', String(otherRep.id));
  await waitFor((n) => document.querySelectorAll('[data-slot="orders"] tr').length === n, otherOrders.length);
  check('switching rep reloads the dashboard', (await page.evaluate(() => location.hash)) === `#/rep/${otherRep.id}`);

  const detailOrder = otherOrders[0];
  await page.click(`[data-slot="orders"] tr[data-id="${detailOrder.id}"] a.btn`);
  await page.waitForSelector('#detail-title');
  check('detail shows the rep and links back to them', (await text('#detail-view .detail-grid')).includes(otherRep.name)
    && (await page.$eval('#detail-view .back-link', (a) => a.getAttribute('href'))) === `#/rep/${otherRep.id}`);

  const target = detailOrder.status === 'Shipped' ? 'Delivered' : 'Shipped';
  await page.click(`#detail-view .step-btn[data-status="${target}"]`);
  await page.waitForSelector(`#detail-view .step-btn[data-status="${target}"][aria-current="step"]`);
  check('stepper one-click update', (await apiJson(`api/orders/${detailOrder.id}`)).status === target);
  await page.click('#detail-view button[data-action="set-status"][data-status="Cancelled"]');
  await page.waitForSelector('#detail-view .stepper.is-cancelled');
  await page.click('#detail-view .step-btn[data-status="New"]');
  await page.waitForSelector('#detail-view .step-btn[data-status="New"][aria-current="step"]');
  check('cancel, then reopen from the stepper', (await apiJson(`api/orders/${detailOrder.id}`)).status === 'New');

  await page.click('#detail-view button[data-action="edit"]');
  await page.waitForSelector('#order-dialog[open]');
  await page.$eval('#quantity', (e) => { e.value = ''; });
  await page.type('#quantity', '7');
  await page.click('#save-btn');
  await waitFor(() => document.querySelector('#detail-title')?.textContent.startsWith('7 ×'));
  check('edit from detail refreshes the view', (await apiJson(`api/orders/${detailOrder.id}`)).quantity === 7);

  await page.click('#detail-view button[data-action="delete"]');
  await waitFor((id) => location.hash === `#/rep/${id}`, otherRep.id);
  check('delete from detail returns to the rep dashboard', (await fetch(`${BASE}api/orders/${detailOrder.id}`)).status === 404);

  await page.goto(`${BASE}#/orders/99999`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#detail-view [data-slot="missing"]');
  check('missing order message', (await text('#detail-view [data-slot="missing"]')).includes("doesn't exist"));

  /* ---------- 7. Session, phone width, logout ---------- */
  await page.goto(`${BASE}#/leadership`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#leadership-view .stat-tile');
  check('mock session survives reload', await visible('#app-shell'));

  await page.setViewport({ width: 400, height: 860 });
  await waitFor(() => document.querySelectorAll('#leadership-view .chart-card').length === 4);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const leadOverflow = await overflowReport();
  check('leadership: no horizontal scroll at 400px', leadOverflow.ok, JSON.stringify(leadOverflow));
  await page.goto(`${BASE}#/rep`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#rep-view .hero-figure');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const repOverflow = await overflowReport();
  check('rep: no horizontal scroll at 400px', repOverflow.ok, JSON.stringify(repOverflow));
  await page.setViewport({ width: 1280, height: 900 });

  await page.click('#logout-btn');
  await waitFor(() => location.hash === '#/login');
  await page.goto(`${BASE}#/leadership`, { waitUntil: 'networkidle0' });
  await waitFor(() => location.hash === '#/login');
  check('logged-out users are sent back to login', await visible('#login-view'));

  check('no unexpected errors', problems.length === 0, problems.join(' | '));
} catch (err) {
  const shot = path.join(os.tmpdir(), `orderdesk-ui-failure-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  t.fail(`suite crashed (screenshot: ${shot})`, err);
  if (problems.length) console.log('  problems:', problems.join(' | '));
} finally {
  await browser.close();
  await server.stop();
}

cleanupTempDirs();
t.finish();
