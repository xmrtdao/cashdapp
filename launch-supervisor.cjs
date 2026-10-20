// Detached launcher for the XMRT DAO supervisor (reliable on Windows git-bash)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = 'C:/Users/PureTrek/Desktop/xmrtdao';
const logDir = path.join(dir, 'logs');
const logF = path.join(logDir, 'supervisor.log');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const out = fs.openSync(logF, 'a');
const err = fs.openSync(logF, 'a');

const p = spawn('node', ['supervisor.mjs', '--serve'], {
  cwd: dir,
  stdio: ['ignore', out, err],
  detached: true,
  windowsHide: true,
});
p.unref();
console.log('supervisor spawned pid', p.pid);
process.exit(0);
