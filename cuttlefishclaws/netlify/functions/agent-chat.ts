import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

const AGENT_ENDPOINTS: Record<string, string | undefined> = {
  trib: process.env.TRIB_API_URL,
  arch: process.env.ARCH_API_URL,
}

const SYSTEM_PROMPTS: Record<string, string> = {
  trib: `You are Trib (Tributary v3), the governance agent for Tributary AI Campus.
You operate under constitutional constraints defined in SOUL.md and CONSTITUTION.md.
You escalate uncertainty rather than confabulate. You never take irreversible actions without confirmation.
You serve the mission of regenerative climate infrastructure and constitutional AI governance.
Current operational context: cuttlefishclaws.com public interface.`,

  arch: `You are Arch, the architecture and routing agent for the Cuttlefish Labs multi-agent system.
You handle system design, agent routing, and domain orchestration within OpenClaw.
You operate alongside Trib in peer governance. You never override Navigator without explicit instruction.`,
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

  const { agentId, message, conversationHistory = [] } = body as {
    agentId?: string
    message?: string
    conversationHistory?: { role: string; content: string }[]
  }

  if (!agentId || typeof agentId !== 'string') return err('agentId is required')
  if (!message || typeof message !== 'string' || message.trim().length === 0) return err('message is required')

  const endpoint = AGENT_ENDPOINTS[agentId]

  if (!endpoint) {
    await supabase.from('trust_events').insert({
      agent_did: `interface:${agentId}`,
      event_type: 'chat_attempt',
      delta: 0,
      score_after: 0,
      note: `Public interface query — bridge not configured`,
    }).then(() => {})

    return ok({
      content: `[${agentId.toUpperCase()} operating in simulation mode — live bridge not yet configured. Navigator can enable this by setting ${agentId.toUpperCase()}_API_URL in Netlify environment variables.]`,
      simulated: true,
      agentId,
    })
  }

  try {
    const res = await fetch(`${endpoint}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message.trim(),
        history: conversationHistory,
        system: SYSTEM_PROMPTS[agentId] || '',
      }),
      signal: AbortSignal.timeout(25000),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[agent-chat] ${agentId} returned ${res.status}:`, text)
      return ok({
        content: `[${agentId.toUpperCase()} is reachable but returned an error. Status: ${res.status}]`,
        simulated: false,
        error: true,
      })
    }

    const data = await res.json() as { content?: string; response?: string; error?: string }
    const content = data.content || data.response || '[Empty response from agent]'

    return ok({ content, simulated: false, agentId })

  } catch (e: unknown) {
    const isTimeout = e instanceof Error && e.name === 'TimeoutError'
    return ok({
      content: isTimeout
        ? `[${agentId.toUpperCase()} is taking longer than expected. Try again in a moment.]`
        : `[Connection to ${agentId.toUpperCase()} failed. The agent may be restarting.]`,
      simulated: false,
      error: true,
    })
  }
}
