/**
 * relay/tools/monitor.mjs — System monitoring and telemetry
 * 
 * Provides real-time system metrics:
 *   - CPU / Memory / Disk usage
 *   - Relay uptime and request counts
 *   - Task handler statistics
 *   - External service health (Supabase, Ollama, GitHub)
 */

import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DATA_DIR = join(__dirname, '..', '..', 'relay-data');

/**
 * Get system resource usage
 */
export function getSystemResources() {
  const info = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: process.uptime(),
    memory: {},
    cpu: {},
  };

  // Memory
  const memUsage = process.memoryUsage();
  info.memory = {
    rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
    external: Math.round(memUsage.external / 1024 / 1024) + ' MB',
  };

  // CPU info (cross-platform)
  try {
    if (process.platform === 'win32') {
      const cpu = execSync('wmic cpu get loadpercentage /value', { encoding: 'utf8', timeout: 5000 });
      const match = cpu.match(/LoadPercentage=(\d+)/);
      if (match) info.cpu.usage = `${match[1]}%`;
      
      const mem = execSync('wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /value', { encoding: 'utf8', timeout: 5000 });
      const freeMatch = mem.match(/FreePhysicalMemory=(\d+)/);
      const totalMatch = mem.match(/TotalVisibleMemorySize=(\d+)/);
      if (freeMatch && totalMatch) {
        const freeMB = Math.round(parseInt(freeMatch[1]) / 1024);
        const totalMB = Math.round(parseInt(totalMatch[1]) / 1024);
        info.memory.system = {
          total: `${totalMB} MB`,
          free: `${freeMB} MB`,
          used: `${totalMB - freeMB} MB`,
          usagePercent: `${Math.round(((totalMB - freeMB) / totalMB) * 100)}%`,
        };
      }
    } else {
      // Linux/Mac
      try {
        const cpuInfo = execSync("top -bn1 | grep 'Cpu(s)'", { encoding: 'utf8', timeout: 5000 });
        info.cpu.usage = cpuInfo.trim();
      } catch {}
      
      try {
        const memInfo = execSync('free -m | grep Mem', { encoding: 'utf8', timeout: 5000 });
        const parts = memInfo.trim().split(/\s+/);
        if (parts.length >= 3) {
          info.memory.system = {
            total: `${parts[1]} MB`,
            used: `${parts[2]} MB`,
            free: `${parts[3]} MB`,
            usagePercent: `${Math.round((parseInt(parts[2]) / parseInt(parts[1])) * 100)}%`,
          };
        }
      } catch {}
    }
  } catch (e) {
    info.cpu.error = e.message;
  }

  // Disk
  try {
    const relayLog = join(RELAY_DATA_DIR, '..', 'relay.log');
    if (existsSync(relayLog)) {
      const stats = statSync(relayLog);
      info.relayLogSize = `${Math.round(stats.size / 1024)} KB`;
    }
  } catch {}

  return info;
}

/**
 * Check external service health
 */
export async function checkExternalServices() {
  const services = {};

  // Supabase — uses SUPABASE_URL from env (defaults to local_sb) so Eliza reports
  // the correct backend; no longer hardcoded to the dead cloud Supabase.
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-dev-service-role-key';
    const res = await fetch(supabaseUrl + '/rest/v1/tasks?select=id&limit=1', {
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    services.supabase = {
      status: res.ok ? 'ok' : `error (${res.status})`,
      latency: null,
      url: supabaseUrl,
    };
  } catch (e) {
    services.supabase = { status: 'unreachable', error: e.message };
  }

  // Ollama
  try {
    const start = Date.now();
    const res = await fetch(`${process.env.OLLAMA_HOST || 'http://localhost:11434'}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    if (res.ok) {
      const data = await res.json();
      services.ollama = {
        status: 'ok',
        models: (data.models || []).map(m => m.name),
        latency: `${latency}ms`,
      };
    } else {
      services.ollama = { status: `error (${res.status})` };
    }
  } catch (e) {
    services.ollama = { status: 'unreachable', error: e.message };
  }

  // GitHub API
  try {
    const res = await fetch('https://api.github.com/repos/xmrtdao/mobilemonero', {
      headers: { 'User-Agent': 'xmrtdao-monitor' },
      signal: AbortSignal.timeout(10000),
    });
    services.github = {
      status: res.ok ? 'ok' : `error (${res.status})`,
    };
  } catch (e) {
    services.github = { status: 'unreachable', error: e.message };
  }

  // Hermes (phone agent)
  const hermesUrl = process.env.HERMES_ENDPOINT || 'http://192.168.14.115:9090';
  try {
    const res = await fetch(hermesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping' }),
      signal: AbortSignal.timeout(5000),
    });
    services.hermes = {
      status: res.ok ? 'ok' : `error (${res.status})`,
    };
  } catch (e) {
    services.hermes = { status: 'unreachable', error: e.message };
  }

  return services;
}

/**
 * Get relay request statistics
 */
export function getRelayStats() {
  // Count files in relay-data
  let activityCount = 0;
  try {
    const { readdirSync } = require('fs');
    // We don't persist request counts separately, rely on relay's activityLog
  } catch {}

  return {
    handlers: ['email-smtp-fix', 'alice-sidecar', 'knowledge-sync', 'device-registration', 'mining-dashboard', 'alice'],
    relayPort: parseInt(process.env.RELAY_PORT || '8080'),
    agentName: 'Eliza-Dev',
  };
}

/**
 * Get a full snapshot of the system state
 */
export async function getFullSnapshot() {
  const systemResources = getSystemResources();
  const externalServices = await checkExternalServices();
  const relayStats = getRelayStats();

  return {
    timestamp: new Date().toISOString(),
    system: systemResources,
    services: externalServices,
    relay: relayStats,
  };
}

export default { getSystemResources, checkExternalServices, getRelayStats, getFullSnapshot };
