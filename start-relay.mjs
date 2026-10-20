#!/usr/bin/env node
// Wrapper to keep relay alive as background process
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['--max-old-space-size=512', join(__dirname, 'relay', 'server.js')], {
  cwd: __dirname,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));
child.on('exit', (c) => { console.log('relay exited:', c); process.exit(c || 0); });
process.on('SIGTERM', () => child.kill());
