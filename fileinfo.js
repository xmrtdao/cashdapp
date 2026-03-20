import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { readFileSync } from 'node:fs';

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const filepath = url.searchParams.get('filepath');

    if (!filepath) {
      return new Response(JSON.stringify({ error: 'Missing filepath parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const fileContent = readFileSync(filepath, { encoding: 'utf8' });

    return new Response(
      JSON.stringify({ success: true, filepath: filepath, content: fileContent }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});