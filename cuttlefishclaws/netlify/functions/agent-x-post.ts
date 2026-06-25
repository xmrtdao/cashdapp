import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

const GC_DID = 'did:ethr:global-communicator-v1'
const TRUST_THRESHOLD_TRIB_APPROVAL = 85

interface PostDraft {
  content_en: string
  content_native?: string
  language?: string
  hashtags?: string[]
  is_milestone?: boolean
}

async function runConstitutionalCheck(draft: PostDraft): Promise<{ score: number; passed: boolean; flags: string[] }> {
  const flags: string[] = []

  // Hard blocks
  if (/guaranteed|promise.*return|will.*increase|investment.*return/i.test(draft.content_en)) {
    flags.push('FINANCIAL_PROMISE: Cannot guarantee returns')
  }
  if (/\bsoon\b|\bimminent\b|\blaunch.*today\b/i.test(draft.content_en)) {
    flags.push('TIMELINE_PROMISE: Avoid unverified timeline claims')
  }

  // Score (100 = clean, deduct for flags)
  const score = Math.max(0, 100 - flags.length * 25)
  return { score, passed: flags.length === 0, flags }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight()
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405)

  const body = JSON.parse(event.body || '{}') as {
    draft: PostDraft
    operator_approved?: boolean
  }

  const { draft, operator_approved = false } = body

  if (!draft?.content_en) return err('draft.content_en is required')

  // 1. Constitutional check
  const check = await runConstitutionalCheck(draft)

  if (!check.passed && !operator_approved) {
    // Log violation attempt
    await supabase.from('trust_events').insert({
      agent_did: GC_DID,
      event_type: 'constitutional_block',
      delta: -50,
      score_after: 28,  // TODO: read live score
      note: `Blocked post: ${check.flags.join('; ')}`,
    })
    return err(`Constitutional check failed: ${check.flags.join('; ')}`, 403)
  }

  // 2. Queue for Trib approval if score below threshold
  const needs_trib = check.score < TRUST_THRESHOLD_TRIB_APPROVAL && !operator_approved

  await supabase.from('agent_tasks').insert({
    task_type: needs_trib ? 'approve_post' : 'publish_post',
    assigned_to: 'trib',
    payload: {
      agent_did: GC_DID,
      draft,
      constitutional_score: check.score,
      flags: check.flags,
      needs_trib_approval: needs_trib,
      operator_approved,
      // TODO: x_post_id after live X API wired
    },
    priority: draft.is_milestone ? 1 : 5,
  })

  // 3. Trust event
  await supabase.from('trust_events').insert({
    agent_did: GC_DID,
    event_type: 'post_queued',
    delta: 0,
    score_after: 78,  // TODO: read live score
    note: `Post queued. Score: ${check.score}. Trib approval: ${needs_trib}`,
  })

  return ok({
    success: true,
    constitutional_score: check.score,
    flags: check.flags,
    status: needs_trib ? 'pending_trib_approval' : 'queued_for_publish',
    // x_post_id: null — wire when X handle confirmed
    message: needs_trib
      ? 'Draft queued for Trib approval (score below 85).'
      : 'Draft queued for publishing.',
  })
}
