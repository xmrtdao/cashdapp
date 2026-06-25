import type { Handler } from '@netlify/functions'

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method not allowed' }
  }

  const apiUrl = process.env.TRIB_API_URL
  const apiKey = process.env.TRIB_API_KEY

  let body: Record<string, string>
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { error: 'Invalid JSON' })
  }

  if (!body.email) return json(400, { error: 'email required' })

  // If crew is online, forward to it
  if (apiUrl) {
    try {
      await fetch(`${apiUrl}/investor-inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey || '' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
    } catch (e: any) {
      console.error('[inquiry fn] crew forward failed:', e.message)
      // Continue — we still confirm to the user
    }
  }

  return json(200, {
    status: 'received',
    message: "Trib has your inquiry. Expect a response within 24 hours.",
  })
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
