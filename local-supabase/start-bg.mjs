const { spawn } = require('child_process');
const p = spawn('node', ['server.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  windowsHide: true,
  cwd: __dirname
});
p.unref();
console.log('local-sb PID:', p.pid);
// Keep alive for 30s to let it initialize, then exit
setTimeout(() => process.exit(0), 30000);
