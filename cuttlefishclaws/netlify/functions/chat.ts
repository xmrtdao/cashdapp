import type { Handler } from '@netlify/functions'

// Maps site agent IDs to crew agent names
const AGENT_MAP: Record<string, string> = {
  trib:      'trib',
  arch:      'arch',
  builder:   'trib',     // investor agents route through Trib
  sovereign: 'krakenor', // research/intelligence queries go to Krakenor
  nautiloid: 'nautiloid',
  krakenor:  'krakenor',
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method not allowed' }
  }

  const apiUrl  = process.env.TRIB_API_URL   // e.g. https://xxx.trycloudflare.com
  const apiKey  = process.env.TRIB_API_KEY   // tributary-crew-2026

  if (!apiUrl) {
    // Crew offline — return graceful fallback
    return json(200, {
      response: "Trib is currently offline. The crew operates on a scheduled cycle. Leave a message via the invest form and we'll follow up directly.",
      crew_online: false,
    })
  }

  let body: { agentId?: string; message?: string }
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { error: 'Invalid JSON' })
  }

  const agentId  = body.agentId || 'trib'
  const message  = body.message?.trim()
  const crewAgent = AGENT_MAP[agentId] || 'trib'

  if (!message) return json(400, { error: 'message required' })

  try {
    const resp = await fetch(`${apiUrl}/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey || '',
      },
      body: JSON.stringify({ agent: crewAgent, task: message }),
      signal: AbortSignal.timeout(29000), // Netlify functions timeout at 30s
    })

    if (!resp.ok) {
      const err = await resp.text()
      console.error('[chat fn] crew error:', resp.status, err)
      return json(200, {
        response: "The crew is processing. Try again in a moment.",
        crew_online: true,
        error: resp.status,
      })
    }

    const data = await resp.json()
    return json(200, {
      response: data.response || '(no response)',
      crew_online: true,
    })
  } catch (e: any) {
    console.error('[chat fn] fetch error:', e.message)
    return json(200, {
      response: "Crew unreachable right now. Drop a note via the invest form and Trib will follow up directly.",
      crew_online: false,
    })
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function json(status: number, body: object) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  }
}
