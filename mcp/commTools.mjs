import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'suite', '.env') });

// Lazy client — only created on first use so missing .env doesn't crash startup
let _supabase = null;
function getClient() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

/**
 * Send a message to another agent via the inbox_messages table.
 */
export async function sendMessageToAgent(toAgent, message, options = {}) {
    const { fromAgent = 'Antigravity' } = options;
    const { data, error } = await getClient()
        .from('inbox_messages')
        .insert([{
            to_agent: toAgent,
            from_agent: fromAgent,
            content: message,
            status: 'PENDING'
        }]);
    if (error) throw error;
    return data;
}

/**
 * Get details of a specific task.
 */
export async function getTaskDetails(taskId) {
    const { data, error } = await getClient()
        .from('tasks')
        .select('*')
        .eq('id', taskId)
        .single();
    if (error) throw error;
    return data;
}

/**
 * Check the status of a specific task.
 */
export async function checkTaskStatus(taskId) {
    const { data, error } = await getClient()
        .from('tasks')
        .select('status, result, error_message')
        .eq('id', taskId)
        .single();
    if (error) throw error;
    return data;
}
