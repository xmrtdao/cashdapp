/**
 * DSH Agent Daemon
 *
 * Polls agent-inbox/dsh/ for queued prompts, executes them via the
 * DeepSeek Harness headless CLI, and writes results to agent-outbox/dsh/.
 *
 * DSH is invoked as:
 *   node --import tsx/esm apps/cli/src/bin.ts --profile headless "<prompt>"
 *
 * The --profile headless mode runs a single prompt without the web GUI.
 */

import { startAgentDaemon } from './lib/agent-bridge.mjs';
import { spawn } from 'child_process';
import { join } from 'path';

const DSH_DIR = join(__dirname, '..', 'dsh');
const DSH_BIN = join(DSH_DIR, 'apps', 'cli', 'src', 'bin.ts');

// DSH uses its own model config; this is just for logging
const MODEL = process.env.DSH_AGENT_MODEL || 'deepseek-r1';

async function executePrompt(entry) {
  const prompt = entry.prompt;
  console.log(`[dsh-agent] executing prompt ${entry.id} (${prompt.length} chars)`);

  return new Promise((resolve, reject) => {
    const args = [
      '--import', 'tsx/esm',
      DSH_BIN,
      '--profile', 'headless',
      prompt,
    ];

    const proc = spawn('node', args, {
      cwd: DSH_DIR,
      env: { ...process.env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // 10-minute timeout
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('DSH agent timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.slice(0, 4000) || '(no output)');
      } else {
        reject(new Error(`DSH exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn DSH: ${e.message}`));
    });
  });
}

startAgentDaemon({
  agent: 'dsh',
  handler: executePrompt,
  pollMs: 3000,
  maxConcurrent: 1,
});
