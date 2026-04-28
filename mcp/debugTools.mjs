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
 * Log a detailed execution step to the eliza_activity_log.
 */
export async function logExecutionStep(agentName, action, details) {
    const { data, error } = await getClient()
        .from('eliza_activity_log')
        .insert([{
            agent_name: agentName,
            action: action,
            details: details,
            timestamp: new Date().toISOString()
        }]);
    if (error) throw error;
    return data;
}

/**
 * Introspect available tools (listing registered tools on the server).
 * (In a real scenario, this would inspect self).
 */
export async function introspectTools(server) {
    // This is a placeholder since the server instance is passed at runtime
    return {
        tools: [
            { name: 'fs_list_recursive', description: 'Recursive list' },
            { name: 'fs_search', description: 'Grep-like search' },
            { name: 'agent_send_message', description: 'Inter-agent messaging' }
        ]
    };
}

/**
 * Runtime console access (simulated).
 */
export async function getRuntimeConsole() {
    return {
        status: 'online',
        lastMessages: [
            'Agent started...',
            'Polling for tasks...',
            'Task 123 in progress...'
        ]
    };
}
