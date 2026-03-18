import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'suite', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Update agent configuration (personality, tone, etc.) in the agents table.
 */
export async function updateAgentConfig(agentName, config) {
    const { data, error } = await supabase
        .from('agents')
        .update({ config: config })
        .eq('name', agentName);
    if (error) throw error;
    return data;
}

/**
 * Store external API keys (BYOK) in a local .env file or Supabase secrets.
 * For this implementation, we'll append to a local .env for simplicity and speed.
 */
export async function storeCredential(key, value) {
    const envPath = join(__dirname, '..', 'suite', '.env');
    const content = readFileSync(envPath, 'utf8');
    const lines = content.split('\n');
    let updated = false;
    const newLines = lines.map(line => {
        if (line.startsWith(`${key}=`)) {
            updated = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!updated) {
        newLines.push(`${key}=${value}`);
    }
    writeFileSync(envPath, newLines.join('\n'), 'utf8');
    return { success: true, key };
}

/**
 * List available skills (installed via clawhub).
 */
export async function listSkills() {
    // This could involve reading a lockfile or querying clawhub
    return {
        installed: [
            { name: 'video-frames', description: 'Placeholder for video processing' },
            { name: 'nano-banana-pro', description: 'Placeholder for advanced reasoning' }
        ]
    };
}
