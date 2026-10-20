#!/usr/bin/env node
// Wrapper that keeps local-sb alive as a background process
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, 'logs'), { recursive: true });
const logFd = openSync(join(__dirname, 'logs', 'local-sb.log'), 'a');
const child = spawn(process.execPath, [join(__dirname, 'local-supabase', 'server.mjs')], {
  cwd: __dirname,
  windowsHide: true,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env },
});
child.unref();
console.log('local-sb started, PID:', child.pid);
process.exit(0);
