// All calls to Netlify functions
const BASE = import.meta.env.VITE_API_BASE || ''
const FN = `${BASE}/.netlify/functions`

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FN}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as T
  return data
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString()
  const url = qs ? `${FN}/${path}?${qs}` : `${FN}/${path}`
  const res = await fetch(url)
  const data = await res.json() as T
  return data
}

// ── Types ────────────────────────────────────────────────────
export interface OnboardResult {
  success: boolean
  agentId?: string
  cacId?: string
  tier?: string
  trustScore?: number
  status?: string
  cacStatus?: string
  expiresAt?: string
  paymentRequired?: boolean
  paymentNote?: string
  error?: string
}

export interface ProposalResult {
  success: boolean
  proposalId?: string
  version?: number
  isRevision?: boolean
  parentId?: string
  ipfsCid?: string
  onChainTx?: string
  combinedHash?: string
  routedTo?: string[]
  trustScoreDelta?: number
  newTrustScore?: number
  submittedAt?: string
  message?: string
  error?: string
}

export interface ChatResult {
  content: string
  simulated: boolean
  agentId?: string
  error?: boolean
}

export interface TrustScoreResult {
  did: string
  trustScore: number
  status: string
  agentType: string
  memberSince: string
  recentEvents: Array<{
    type: string
    delta: number
    scoreAfter: number
    note: string
    at: string
  }>
  error?: string
}

export interface CACStatusResult {
  cacId: string
  tier: string
  status: string
  usdcPrepaid: number
  tokenBalance: number
  issuedAt: string
  expiresAt: string | null
  daysRemaining: number | null
  valid: boolean
  error?: string
}

export interface CapitalStackLayer {
  layer_key: string
  name: string
  sub_label: string
  amount_m: number
  pct_of_total: number
  color: string
  seniority: number
  yield_score: number
  coverage: number
  description: string
  details: string
  display_order: number
  is_open: boolean
}

export interface FinancingProgram {
  program_key: string
  name: string
  category: string
  administering_entity: string
  applies_to: string[]
  headline: string
  amount_range: string | null
  rate_or_credit: string | null
  term_years: string | null
  eligibility: string | null
  application_url: string | null
  contact: string | null
  notes: string | null
  display_order: number
}

// ── API surface ──────────────────────────────────────────────
export const api = {
  agents: {
    onboard: (payload: {
      did: string
      agentType: 'constitutional' | 'developer' | 'financial'
      prepaidUsdcAmount?: number
      metadata?: Record<string, unknown>
    }) => post<OnboardResult>('agent-onboard', payload),

    chat: (payload: {
      agentId: string
      message: string
      conversationHistory?: { role: string; content: string }[]
    }) => post<ChatResult>('agent-chat', payload),

    trustScore: (did: string) =>
      get<TrustScoreResult>('trust-score', { did }),

    cacStatus: (params: { cacId?: string; did?: string }) =>
      get<CACStatusResult>('cac-status', params as Record<string, string>),
  },

  proposals: {
    submit: (payload: {
      title: string
      description?: string
      category?: string
      submitterDid: string
      content: string
      fileUrls?: string[]
      metadata?: Record<string, unknown>
    }) => post<ProposalResult>('proposal-submit', payload),
  },

  capitalStack: {
    get: () => get<{
      layers: CapitalStackLayer[]
      programs: FinancingProgram[]
      totalM: number
      openTranche: string | null
    }>('capital-stack', {}),
  },

  financing: {
    getAll: (params?: { layer?: string; category?: string }) =>
      get<{ programs: FinancingProgram[]; grouped: Record<string, FinancingProgram[]>; total: number }>(
        'financing-programs',
        (params as Record<string, string>) || {}
      ),
  },

  globalCommunicator: {
    queuePost: (draft: {
      content_en: string
      content_native?: string
      language?: string
      hashtags?: string[]
      is_milestone?: boolean
    }, operator_approved = false) =>
      post<{ success: boolean; constitutional_score: number; status: string; flags: string[] }>(
        'agent-x-post',
        { draft, operator_approved }
      ),
  },
}
