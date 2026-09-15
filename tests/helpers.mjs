/**
 * Shared helpers for the OrderDesk test suites.
 *
 * Every suite starts its own server on a free port with a throwaway data directory and
 * blanks the settings a developer's .env could set, so tests never touch real data or
 * call real services.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Empty values win over .env because process.loadEnvFile never overwrites variables that are already set. */
export const ISOLATED_ENV = {
  MCP_API_KEY: '',
  MCP_PORT: '',
  MCP_ALLOW_WRITES: '',
  DEVREV_PAT: '',
  DEVREV_DRY_RUN: '',
  STORE_ENGINE: '',
};

const tempDirs = [];

export function tempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `orderdesk-${label}-`));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
}

/** Start server.js; resolves once `readyText` appears in its output. */
export function startServer({ env = {}, readyText = 'running at', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...ISOLATED_ENV, ...env } });
    let log = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start in time:\n${log}`));
    }, timeoutMs);
    const onData = (chunk) => {
      log += chunk;
      if (log.includes(readyText)) {
        clearTimeout(timer);
        resolve({ child, log: () => log, stop: () => stopProcess(child) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}) before it was ready:\n${log}`));
    });
  });
}

/** Minimal PASS/FAIL reporter; sets the exit code when the suite finishes. */
export function createReporter(suite) {
  let passed = 0;
  let failed = 0;
  console.log(`\n# ${suite}`);
  return {
    check(name, condition, extra = '') {
      if (condition) {
        passed += 1;
        console.log(`  PASS  ${name}`);
      } else {
        failed += 1;
        console.log(`  FAIL  ${name}${extra !== '' ? `  -> ${String(extra).slice(0, 500)}` : ''}`);
      }
    },
    fail(name, err) {
      failed += 1;
      console.log(`  FAIL  ${name}: ${err?.stack || err}`);
    },
    finish() {
      console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
      process.exitCode = failed ? 1 : 0;
      return failed === 0;
    },
  };
}
