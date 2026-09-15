#!/usr/bin/env node
/**
 * tools/reset-db.js: delete the local database so the next start re-creates it
 * with fresh demo data (6 sales reps, 300 orders over 180 days).
 *
 * Stop the server first. Usage: npm run db:reset
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }

const DATA_DIR = process.env.DATA_DIR || ROOT;
const files = ['orders.db', 'orders.db-wal', 'orders.db-shm', 'orders.json']
  .map((name) => path.join(DATA_DIR, name))
  .filter((file) => fs.existsSync(file));

if (files.length === 0) {
  console.log('Nothing to reset: no database found.');
} else {
  for (const file of files) {
    fs.rmSync(file);
    console.log(`Deleted ${path.relative(ROOT, file) || file}`);
  }
  console.log('Done. Run npm start to create a fresh database with demo data.');
}
