#!/usr/bin/env node
/**
 * tools/devrev-sync.js: command-line DevRev sync for OrderDesk.
 *
 *   node tools/devrev-sync.js setup   Create/update the "Order" custom object schema in DevRev
 *   node tools/devrev-sync.js sync    Push every local order to DevRev, remove ones deleted locally
 *   node tools/devrev-sync.js list    Show the orders currently stored in DevRev
 *
 * Add --dry-run to print the API requests without sending anything.
 * Reads DEVREV_PAT (and optional DEVREV_API_BASE / DEVREV_LEAF_TYPE) from .env.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }

const args = process.argv.slice(2);
if (args.includes('--dry-run')) process.env.DEVREV_DRY_RUN = '1';
const command = args.find((arg) => !arg.startsWith('--'));

const store = require('../store');
const devrev = require('../devrev');

const USAGE = `Usage: node tools/devrev-sync.js <setup|sync|list> [--dry-run]

  setup   Create/update the "Order" custom object schema in DevRev
  sync    Push every local order to DevRev and remove orders deleted locally
  list    Show the orders currently stored in DevRev`;

async function main() {
  if (!['setup', 'sync', 'list'].includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }

  const mode = devrev.mode();
  if (mode === 'disabled') {
    console.error('DEVREV_PAT is not set. Copy .env.example to .env and add your DevRev Personal Access Token, or re-run with --dry-run.');
    process.exitCode = 1;
    return;
  }
  const { apiBase, leafType } = devrev.status();
  console.log(`DevRev mode: ${mode} | ${apiBase} | leaf type "${leafType}"\n`);

  if (command === 'setup') {
    const result = await devrev.setupSchema();
    if (result) console.log(`Schema saved (${result.id}).`);
    console.log('\nNext steps:');
    console.log('  1. In DevRev, grant access to the Order object: Settings > User Management > Roles');
    console.log('  2. npm run devrev:sync');
    return;
  }

  if (command === 'sync') {
    store.init();
    const orders = await store.listOrders();
    console.log(`Syncing ${orders.length} local orders to DevRev...`);
    const summary = await devrev.syncAll(orders);
    console.log(`\nDone: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.failed} failed.`);
    summary.errors.forEach((e) => console.error(`  - ${e}`));
    if (summary.failed) process.exitCode = 1;
    return;
  }

  // list
  const objects = await devrev.listRemoteOrders();
  if (mode === 'dry-run') return;
  if (objects.length === 0) {
    console.log('No Order objects in DevRev yet. Run: npm run devrev:sync');
    return;
  }
  console.table(objects.map((o) => {
    const f = o.custom_fields || {};
    return {
      devrev_id: o.display_id,
      order: f.tnt__order_id,
      customer: f.tnt__customer_name,
      product: f.tnt__product,
      qty: f.tnt__quantity,
      status: f.tnt__status,
    };
  }));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
