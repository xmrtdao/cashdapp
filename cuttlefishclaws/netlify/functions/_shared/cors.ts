export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://cuttlefishclaws.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
}

export function preflight() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' }
}

export function ok(body: unknown, status = 200) {
  return { statusCode: status, headers: CORS_HEADERS, body: JSON.stringify(body) }
}

export function err(message: string, status = 400) {
  return { statusCode: status, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: message }) }
}
