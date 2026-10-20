// Detached launcher for local-sb (reliable on Windows git-bash)
const { spawn } = require('child_process');
const path = require('path');
const dir = 'C:/Users/PureTrek/Desktop/xmrtdao/local-supabase';
const log = 'C:/Users/PureTrek/Desktop/xmrtdao/logs/local-sb.log';
const fs = require('fs');
const out = fs.openSync(log, 'a');
const err = fs.openSync(log, 'a');
const p = spawn('node', ['server.mjs'], {
  cwd: dir,
  stdio: ['ignore', out, err],
  detached: true,
  windowsHide: true,
});
p.unref();
console.log('local-sb spawned pid', p.pid);
