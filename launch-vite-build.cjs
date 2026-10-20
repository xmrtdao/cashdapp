// Detached vite build — runs in background, polls child, exits with vite's code.
// Uses createRequire to avoid ESM/CJS issues.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = 'C:/Users/PureTrek/Desktop/xmrtdao/suite';
const logDir = 'C:/Users/PureTrek/Desktop/xmrtdao/logs';
fs.mkdirSync(logDir, { recursive: true });
const outPath = path.join(logDir, 'vite-build-out.log');
const errPath = path.join(logDir, 'vite-build-err.log');
const out = fs.openSync(outPath, 'w');
const err = fs.openSync(errPath, 'w');

// Use --max-old-space-size high, and pass NODE_OPTIONS env so esbuild workers
// (forked child processes) inherit it.
const env = Object.assign({}, process.env, {
  NODE_OPTIONS: '--max-old-space-size=6144',
});

const child = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'info'],
  {
    cwd,
    env,
    stdio: ['ignore', out, err],
    detached: true,
    windowsHide: true,
  }
);
child.unref();
console.log(`vite build spawned pid ${child.pid}, logs at ${outPath}`);

// Wait for child to exit, then exit with its code.
const start = Date.now();
const interval = setInterval(() => {
  try {
    process.kill(child.pid, 0); // probe
    if (Date.now() - start > 360000) {
      console.log('timed out after 6 min');
      try { process.kill(child.pid); } catch (e) {}
      clearInterval(interval);
      process.exit(124);
    }
  } catch (e) {
    // exited
    clearInterval(interval);
    // node may not have set exitCode on detached — poll files for size
    setTimeout(() => {
      try {
        const outSize = fs.statSync(outPath).size;
        const errSize = fs.statSync(errPath).size;
        console.log(`vite build finished. out=${outSize}B err=${errSize}B elapsed=${Math.round((Date.now()-start)/1000)}s`);
      } catch (e) {}
      process.exit(child.exitCode || 0);
    }, 1000);
  }
}, 3000);