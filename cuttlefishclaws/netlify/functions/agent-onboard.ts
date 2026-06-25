import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

// Constitutional KYA rules
const KYA_RULES = {
  constitutional: { min_prepaid_usdc: 0,    trust_floor: 50, description: 'Core governance agents' },
  developer:      { min_prepaid_usdc: 500,  trust_floor: 50, description: 'Builders on Tributary' },
  financial:      { min_prepaid_usdc: 2000, trust_floor: 60, description: 'Financial/investor agents — enhanced KYA' },
} as const

type AgentType = keyof typeof KYA_RULES

function resolveCACTier(usdc: number): string {
  if (usdc >= 7500) return 'enterprise'
  if (usdc >= 2000) return 'studio'
  if (usdc >= 500)  return 'developer'
  return 'explorer'
}

function isValidDID(did: string): boolean {
  return /^did:[a-z]+:[a-zA-Z0-9._-]+/.test(did)
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight()
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return err('Invalid JSON body')
  }

  const {
    did,
    agentType,
    prepaidUsdcAmount = 0,
    metadata = {},
  } = body as {
    did?: string
    agentType?: string
    prepaidUsdcAmount?: number
    metadata?: Record<string, unknown>
  }

  if (!did || typeof did !== 'string') return err('did is required')
  if (!isValidDID(did)) return err('Invalid DID format. Expected: did:ethr:0x... or did:key:z...')
  if (!agentType || !(agentType in KYA_RULES)) {
    return err(`agentType must be one of: ${Object.keys(KYA_RULES).join(', ')}`)
  }

  const rules = KYA_RULES[agentType as AgentType]
  const prepaid = Number(prepaidUsdcAmount)

  if (Number.isNaN(prepaid) || prepaid < 0) return err('prepaidUsdcAmount must be a non-negative number')

  if (prepaid < rules.min_prepaid_usdc) {
    return err(
      `KYA failed: ${agentType} agents require minimum $${rules.min_prepaid_usdc} USDC prepaid. ` +
      `Received: $${prepaid}`,
      403
    )
  }

  const BANNED_DIDS: string[] = []
  if (BANNED_DIDS.includes(did)) {
    return err('DID is suspended from the Tributary network', 403)
  }

  const { data: existing } = await supabase
    .from('agents')
    .select('id, status, trust_score, cac_id')
    .eq('did', did)
    .single()

  if (existing?.status === 'active') {
    return err('DID already registered and active. Use /cac-status to check your credential.', 409)
  }

  if (existing?.status === 'suspended') {
    return err('DID is suspended. Contact Navigator to resolve.', 403)
  }

  const tier = resolveCACTier(prepaid)
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()

  const { data: cac, error: cacError } = await supabase
    .from('cac_credentials')
    .insert({
      agent_did: did,
      tier,
      usdc_prepaid: prepaid,
      status: prepaid > 0 ? 'active' : 'pending',
      expires_at: expiresAt,
    })
    .select('id, tier, status')
    .single()

  if (cacError) {
    console.error('[agent-onboard] CAC insert error:', cacError)
    return err('Failed to issue CAC credential', 500)
  }

  const agentName = (metadata as Record<string, unknown>)?.name as string | undefined
    || did.slice(0, 24)

  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .upsert({
      did,
      agent_type: agentType,
      name: agentName,
      cac_id: cac.id,
      trust_score: rules.trust_floor,
      status: 'active',
      metadata,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'did' })
    .select('id, trust_score, status')
    .single()

  if (agentError) {
    console.error('[agent-onboard] Agent upsert error:', agentError)
    return err('Failed to register agent', 500)
  }

  await supabase.from('trust_events').insert({
    agent_did: did,
    event_type: 'onboard',
    delta: rules.trust_floor,
    score_after: rules.trust_floor,
    note: `KYA passed. agentType=${agentType} tier=${tier} prepaid=$${prepaid}`,
  })

  await supabase.from('agent_tasks').insert({
    task_type: 'kya_check',
    assigned_to: 'trib',
    payload: {
      agent_id: agent.id,
      did,
      agent_type: agentType,
      tier,
      prepaid_usdc: prepaid,
      name: agentName,
      metadata,
    },
    priority: 3,
  })

  return ok({
    success: true,
    agentId: agent.id,
    cacId: cac.id,
    tier,
    trustScore: agent.trust_score,
    status: agent.status,
    cacStatus: cac.status,
    expiresAt,
    paymentRequired: prepaid === 0,
    paymentNote: prepaid === 0
      ? `Explorer tier active. Top up USDC to upgrade to developer ($500), studio ($2000), or enterprise ($7500).`
      : `$${prepaid} USDC prepaid on record. CAC ID: ${cac.id}`,
  }, 201)
}
