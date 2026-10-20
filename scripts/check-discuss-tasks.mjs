#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_PORT = 8080;
const RELAY_URL = `http://localhost:${RELAY_PORT}`;
const STATE_FILE = join(__dirname, '..', 'relay-data', 'discuss-state.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { announced: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { announced: {} }; }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchTasks() {
  try {
    const res = await fetch(`${RELAY_URL}/api/suite/tasks?limit=50&status_in=DISCUSS`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('[ERROR] Failed to fetch tasks:', e.message);
    return [];
  }
}

async function fetchFleetMessages(limit = 200) {
  try {
    const res = await fetch(`${RELAY_URL}/api/fleet-chat/messages?limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.messages || [];
  } catch (e) {
    console.error('[ERROR] Failed to fetch fleet messages:', e.message);
    return [];
  }
}

function getMention(assignee) {
  if (!assignee) return '';
  const cleanName = assignee.replace(/-001$/, '');
  const known = ['hermes', 'eliza', 'alice', 'vex'];
  if (known.includes(cleanName.toLowerCase())) {
    return `@${cleanName.toLowerCase()}`;
  }
  return `@${cleanName}`;
}

function isTaskMentioned(taskId, messages) {
  if (!messages || !messages.length) return false;
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return messages.some(msg => {
    const msgTime = new Date(msg.created_at || msg.timestamp || Date.now()).getTime();
    if (msgTime < oneDayAgo) return false;
    const text = (msg.content || msg.message || msg.text || '').toLowerCase();
    return text.includes(taskId.toLowerCase());
  });
}

async function postFleetChat(content) {
  try {
    const res = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'hermes-agent', message: content })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log('[OK] Posted fleet chat:', data.message_id || 'sent');
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to post fleet chat:', e.message);
    return false;
  }
}

async function main() {
  console.log('=== Check DISCUSS Tasks ===');
  const tasks = await fetchTasks();
  if (!tasks.length) {
    console.log('[INFO] No tasks in DISCUSS stage.');
    return;
  }
  console.log(`[INFO] Found ${tasks.length} task(s) in DISCUSS stage.`);

  const messages = await fetchFleetMessages(200);
  console.log(`[INFO] Fetched ${messages.length} fleet chat messages.`);

  const state = loadState();
  let postedCount = 0;

  for (const task of tasks) {
    const taskId = task.id;
    const title = task.title || 'Untitled';
    const desc = task.description || 'No description provided.';
    const assignee = task.assignee_agent_id;
    const mention = getMention(assignee);

    const alreadyAnnounced = state.announced[taskId];
    const recentlyDiscussed = isTaskMentioned(taskId, messages);

    if (alreadyAnnounced && recentlyDiscussed) {
      console.log(`[SKIP] Task ${taskId} already announced and discussed recently.`);
      continue;
    }
    if (recentlyDiscussed && !alreadyAnnounced) {
      state.announced[taskId] = Date.now();
      console.log(`[SKIP] Task ${taskId} already discussed in fleet chat (marking).`);
      continue;
    }
    if (alreadyAnnounced && !recentlyDiscussed) {
      console.log(`[SKIP] Task ${taskId} already announced but not yet discussed.`);
      continue;
    }

    const text = `📢 **Task Discussion Needed**

**Title:** ${title}
**ID:** \`${taskId}\`
${mention ? `**Assignee:** ${mention}` : ''}

${desc}

> Please review and share your thoughts in fleet chat or update the task status when ready.
`.trim();

    const ok = await postFleetChat(text);
    if (ok) {
      state.announced[taskId] = Date.now();
      postedCount++;
    }
  }

  saveState(state);
  console.log(`=== Done. Posted ${postedCount} announcement(s). ===`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
