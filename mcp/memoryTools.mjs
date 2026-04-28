import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DeepSeek LLM integration (OpenAI-compatible API)
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash'; // fast default; swap to deepseek-v4-pro for reasoning

async function deepseekChat(messages, options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || 'sk-7e1c19bc87e946d8b225841c028832a8';
  const model = options.model || DEEPSEEK_MODEL;
  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...options.extra,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Summarize long text content. Uses DeepSeek when available, falls back to heuristic.
 */
export async function summarizeContent(content, targetLength = 500) {
  if (content.length <= targetLength) return content;
  try {
    return await deepseekChat([
      { role: 'system', content: 'You are a concise summarizer. Summarize the following content faithfully.' },
      { role: 'user', content: content.slice(0, 8000) }, // cap to avoid token overrun
    ]);
  } catch {
    // Fallback: heuristic truncation
    const head = content.slice(0, targetLength / 2);
    const tail = content.slice(-targetLength / 2);
    return `${head}\n\n[... content truncated for summarization ...]\n\n${tail}`;
  }
}

/**
 * Enhanced memory recall: search through MEMORY.md and recent logs.
 */
export async function recallMemory(query) {
  const memoryPath = join(__dirname, '..', 'MEMORY.md');
  try {
    const memory = readFileSync(memoryPath, 'utf8');
    const sections = memory.split('##');
    const matches = sections.filter(s => s.toLowerCase().includes(query.toLowerCase()));
    return matches.map(m => `##${m}`).join('\n\n');
  } catch (err) {
    return 'No memory found.';
  }
}

/**
 * Integrate external knowledge via DeepSeek LLM or simulated fallback.
 */
export async function fetchExternalKnowledge(query) {
  try {
    const answer = await deepseekChat([
      { role: 'system', content: 'You are a knowledgeable research assistant. Answer concisely and accurately.' },
      { role: 'user', content: query },
    ]);
    return { query, source: 'DeepSeek LLM', answer };
  } catch (err) {
    return {
      query,
      source: 'Simulated External Search (DeepSeek unavailable)',
      results: [
        { title: `${query} Documentation`, url: `https://example.com/search?q=${encodeURIComponent(query)}` },
      ],
    };
  }
}

/**
 * Direct DeepSeek chat — exposed for agent use.
 */
export { deepseekChat };
