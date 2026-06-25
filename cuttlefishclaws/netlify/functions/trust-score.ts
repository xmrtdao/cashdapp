import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight()
  if (event.httpMethod !== 'GET') return err('Method not allowed', 405)

  const did = event.queryStringParameters?.did
  if (!did) return err('did query parameter is required')

  const { data: agent, error } = await supabase
    .from('agents')
    .select('trust_score, status, agent_type, created_at')
    .eq('did', did)
    .single()

  if (error || !agent) {
    return err('Agent not found', 404)
  }

  const { data: events } = await supabase
    .from('trust_events')
    .select('event_type, delta, score_after, note, created_at')
    .eq('agent_did', did)
    .order('created_at', { ascending: false })
    .limit(5)

  return ok({
    did,
    trustScore: Number(agent.trust_score),
    status: agent.status,
    agentType: agent.agent_type,
    memberSince: agent.created_at,
    recentEvents: (events || []).map(e => ({
      type: e.event_type,
      delta: Number(e.delta),
      scoreAfter: Number(e.score_after),
      note: e.note,
      at: e.created_at,
    })),
  })
}
