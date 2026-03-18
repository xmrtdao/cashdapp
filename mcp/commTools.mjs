import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'suite', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Send a message to another agent via the inbox_messages table.
 */
export async function sendMessageToAgent(toAgent, message, options = {}) {
    const { fromAgent = 'Antigravity' } = options;
    const { data, error } = await supabase
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
    const { data, error } = await supabase
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
    const { data, error } = await supabase
        .from('tasks')
        .select('status, result, error_message')
        .eq('id', taskId)
        .single();
    if (error) throw error;
    return data;
}
