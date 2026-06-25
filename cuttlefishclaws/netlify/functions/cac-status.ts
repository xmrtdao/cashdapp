import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight()
  if (event.httpMethod !== 'GET') return err('Method not allowed', 405)

  const { cacId, did } = event.queryStringParameters || {}

  if (!cacId && !did) return err('Provide either cacId or did as query parameter')

  let query = supabase
    .from('cac_credentials')
    .select('id, tier, status, usdc_prepaid, token_balance, issued_at, expires_at')

  if (cacId) {
    query = query.eq('id', cacId)
  } else {
    query = query.eq('agent_did', did!).order('created_at', { ascending: false }).limit(1)
  }

  const { data: cac, error } = await query.single()

  if (error || !cac) return err('CAC not found', 404)

  const now = new Date()
  const expires = cac.expires_at ? new Date(cac.expires_at) : null
  const isExpired = expires ? now > expires : false
  const daysRemaining = expires
    ? Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : null

  return ok({
    cacId: cac.id,
    tier: cac.tier,
    status: isExpired ? 'expired' : cac.status,
    usdcPrepaid: Number(cac.usdc_prepaid),
    tokenBalance: Number(cac.token_balance),
    issuedAt: cac.issued_at,
    expiresAt: cac.expires_at,
    daysRemaining,
    valid: cac.status === 'active' && !isExpired,
  })
}
