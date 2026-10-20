// Detached vite build launcher — v2
// Includes ROLLUP worker count + node max-old-space for the Rollup phase
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = 'C:/Users/PureTrek/Desktop/xmrtdao/suite';
const logDir = 'C:/Users/PureTrek/Desktop/xmrtdao/logs';
fs.mkdirSync(logDir, { recursive: true });
const ts = Date.now();
const outPath = path.join(logDir, `vite-build-${ts}.log`);
const errPath = path.join(logDir, `vite-build-${ts}-err.log`);

const outFd = fs.openSync(outPath, 'a');
const errFd = fs.openSync(errPath, 'a');

// Use --max-semi-space-size for esbuild's per-worker allocations,
// --max-old-space-size for Rollup's whole-program analysis.
const env = Object.assign({}, process.env, {
  NODE_OPTIONS: '--max-old-space-size=10240 --max-semi-space-size=512',
  ESBUILD_WORKERS: '1',     // single esbuild worker — no fork death
  VITE_CJS_IGNORE_WARNING: '1',
  FORCE_COLOR: '0',
  NO_COLOR: '1',
});

const child = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'build',
    '--logLevel', 'info',
    '--minify', 'false',   // skip minification to keep build fast + small peak mem
  ],
  {
    cwd,
    env,
    stdio: ['ignore', outFd, errFd],
    detached: true,
    windowsHide: true,
  }
);
child.unref();
console.log(`vite build spawned pid ${child.pid}`);

// Poll for completion
const start = Date.now();
const poll = setInterval(() => {
  try {
    process.kill(child.pid, 0);
  } catch (e) {
    clearInterval(poll);
    setTimeout(() => {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`vite build finished after ${elapsed}s`);
      // Check for output
      const assetsDir = path.join(cwd, 'dist', 'assets');
      if (fs.existsSync(assetsDir)) {
        const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js') && f.startsWith('index-'));
        console.log(`vite index files: ${files.join(', ') || 'NONE'}`);
      } else {
        console.log('dist/assets missing');
      }
      process.exit(0);
    }, 2000);
    return;
  }
  if (Date.now() - start > 480000) {
    console.log('timeout 8min, killing');
    try { process.kill(child.pid); } catch {}
    clearInterval(poll);
    process.exit(124);
  }
}, 3000);