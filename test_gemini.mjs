import { streamGoogle } from "file:///C:/Users/PureTrek/AppData/Roaming/npm/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/providers/google.js";
import fs from "fs";

const configPath = "C:/Users/PureTrek/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const apiKey = config.env.GEMINI_API_KEY;

const model = { id: 'gemini-2.0-flash', provider: 'google', input: ['text'], output: ['text'] };

// Schema exactly reproducing how OpenClaw interacts with tools
const context = {
    messages: [
        { role: 'user', content: 'use the send_email tool to send a test email to joeyleepcs@gmail.com' },
        { role: 'assistant', content: [{ type: 'toolCall', id: '123', name: 'send_email', arguments: { to: 'joeyleepcs@gmail.com' } }] },
        { role: 'toolResult', toolCallId: '123', toolName: 'send_email', isError: false, content: [{ type: 'text', text: 'Email sent successfully' }] },
        { role: 'user', content: 'did it work?' }
    ],
    tools: [{ name: 'send_email', description: 'desc', parameters: { type: 'object', properties: {} } }]
};

const options = {
    apiKey,
    onPayload: (p) => console.log('==============================\nGEMINI PAYLOAD:\n', JSON.stringify(p, null, 2), '\n==============================\n')
};

async function run() {
    try {
        const stream = streamGoogle(model, context, options);
        for await (const chunk of stream) {
            if (chunk.type === 'text_delta') process.stdout.write(chunk.delta);
            else if (chunk.type === 'error') console.error('STREAM ERROR:', chunk);
        }
        console.log('\n\n--- DONE ---');
    } catch (e) { console.error('CAUGHT ERROR:', e); }
}

run();
