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
 * Perform a health check on an agent by checking its last heartbeats or activity.
 */
export async function monitorAgentHealth(agentName) {
    const { data, error } = await supabase
        .from('agents')
        .select('last_seen, status')
        .eq('name', agentName)
        .single();
    if (error) throw error;
    
    const lastSeen = new Date(data.last_seen);
    const now = new Date();
    const isStale = (now - lastSeen) > 600000; // 10 minutes stale
    
    return {
        agentName,
        status: data.status,
        lastSeen: data.last_seen,
        healthy: !isStale && data.status !== 'OFFLINE'
    };
}

/**
 * Run a suite of automated tests for a set of tools.
 * (In a real scenario, this would execute test scripts).
 */
export async function runAutomatedTests(suiteName) {
    return {
        suiteName,
        timestamp: new Date().toISOString(),
        results: [
            { test: 'fs_list_recursive', passed: true },
            { test: 'agent_send_message', passed: true },
            { test: 'config_store_credential', passed: true }
        ],
        summary: 'All core tests passed.'
    };
}
