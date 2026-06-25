import type { Handler } from '@netlify/functions'
import { createHash } from 'crypto'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

const VALID_CATEGORIES = [
  'symbionic_dcsf',
  'infrastructure',
  'governance',
  'climate',
  'compute',
  'finance',
  'general',
] as const

async function pinToIPFS(content: string, filename: string): Promise<string> {
  const jwt = process.env.PINATA_JWT
  if (!jwt) {
    console.warn('[proposal-submit] PINATA_JWT not set — skipping IPFS pin')
    return `local_${createHash('sha256').update(content).digest('hex').slice(0, 16)}`
  }

  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pinataContent: { content, filename },
      pinataMetadata: { name: filename, keyvalues: { source: 'cuttlefishclaws' } },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error('[proposal-submit] Pinata error:', text)
    return `ipfs_failed_${Date.now()}`
  }

  const data = await res.json() as { IpfsHash?: string }
  return data.IpfsHash || `ipfs_unknown_${Date.now()}`
}

async function anchorOnChain(hash: string, submitterDid: string): Promise<string> {
  // TODO: Replace stub with real viem call when GovernanceModule.sol is deployed to Base mainnet
  console.log(`[proposal-submit] Chain anchor stub — hash: ${hash.slice(0, 16)}, did: ${submitterDid.slice(0, 20)}`)
  return `pending_mainnet_${hash.slice(0, 24)}`
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
    title,
    description = '',
    category = 'general',
    submitterDid,
    content,
    fileUrls = [],
    metadata = {},
  } = body as {
    title?: string
    description?: string
    category?: string
    submitterDid?: string
    content?: string
    fileUrls?: string[]
    metadata?: Record<string, unknown>
  }

  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return err('title is required (min 3 characters)')
  }
  if (!submitterDid || typeof submitterDid !== 'string') {
    return err('submitterDid is required')
  }
  if (!content || typeof content !== 'string' || content.trim().length < 10) {
    return err('content is required (min 10 characters)')
  }
  if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
    return err(`category must be one of: ${VALID_CATEGORIES.join(', ')}`)
  }

  const { data: agent } = await supabase
    .from('agents')
    .select('id, trust_score, status')
    .eq('did', submitterDid)
    .single()

  if (!agent) {
    return err('Submitter DID not found. Complete agent onboarding at /api/agent-onboard first.', 403)
  }

  if (agent.status !== 'active') {
    return err(`Agent status is "${agent.status}". Must be active to submit proposals.`, 403)
  }

  const trustScore = Number(agent.trust_score)
  if (trustScore < 40) {
    return err(`Trust score too low (${trustScore}/100). Minimum 40 required to submit proposals.`, 403)
  }

  const bundle = JSON.stringify({
    title: title.trim(),
    description,
    category,
    content: content.trim(),
    fileUrls,
    metadata,
    submitterDid,
    timestamp: new Date().toISOString(),
  })
  const combinedHash = createHash('sha256').update(bundle).digest('hex')

  const { data: prior } = await supabase
    .from('proposals')
    .select('id, version')
    .eq('submitter_did', submitterDid)
    .eq('title', title.trim())
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  const version = prior ? prior.version + 1 : 1
  const parentId = prior ? prior.id : null

  const safeFilename = `${title.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}_v${version}.json`
  const ipfsCid = await pinToIPFS(bundle, safeFilename)
  const chainTx = await anchorOnChain(combinedHash, submitterDid)

  const routedTo = ['trib', 'arch', 'dao-voters']

  const { data: proposal, error: propError } = await supabase
    .from('proposals')
    .insert({
      title: title.trim(),
      description,
      category,
      submitter_did: submitterDid,
      version,
      parent_id: parentId,
      status: 'submitted',
      ipfs_cid: ipfsCid,
      chain_anchor_tx: chainTx,
      combined_hash: combinedHash,
      routed_to: routedTo,
      metadata: { ...metadata, fileUrls, content_preview: content.slice(0, 200) },
    })
    .select('id, created_at')
    .single()

  if (propError) {
    console.error('[proposal-submit] Insert error:', propError)
    return err('Failed to save proposal', 500)
  }

  const taskPayload = {
    proposal_id: proposal.id,
    title: title.trim(),
    category,
    version,
    submitter_did: submitterDid,
    ipfs_cid: ipfsCid,
    combined_hash: combinedHash,
  }

  await supabase.from('agent_tasks').insert([
    { task_type: 'review_proposal', assigned_to: 'trib', payload: taskPayload, priority: 4 },
    { task_type: 'review_proposal', assigned_to: 'arch', payload: taskPayload, priority: 4 },
  ])

  const newScore = Math.min(100, trustScore + 2)
  await supabase.from('agents').update({ trust_score: newScore }).eq('did', submitterDid)

  await supabase.from('trust_events').insert({
    agent_did: submitterDid,
    event_type: 'proposal_submit',
    delta: 2,
    score_after: newScore,
    reference: proposal.id,
    note: `Submitted: "${title.trim()}" v${version} · category=${category}`,
  })

  return ok({
    success: true,
    proposalId: proposal.id,
    version,
    isRevision: version > 1,
    parentId,
    ipfsCid,
    onChainTx: chainTx,
    combinedHash,
    routedTo,
    trustScoreDelta: +2,
    newTrustScore: newScore,
    submittedAt: proposal.created_at,
    message: version > 1
      ? `Revision v${version} submitted. Routed to Trib + Arch.`
      : `Proposal submitted and routed to constitutional agents.`,
  }, 201)
}
