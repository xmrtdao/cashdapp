import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight()
  if (event.httpMethod !== 'GET') return err('Method not allowed', 405)

  const [stackResult, programsResult] = await Promise.all([
    supabase
      .from('capital_stack')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true }),
    supabase
      .from('financing_programs')
      .select('program_key, name, category, administering_entity, applies_to, headline, amount_range, rate_or_credit, term_years, eligibility, application_url, contact, notes, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true }),
  ])

  if (stackResult.error) {
    console.error('[capital-stack] stack error:', stackResult.error)
    return err('Failed to load capital stack', 500)
  }

  const layers = stackResult.data || []
  const programs = programsResult.data || []
  const totalM = layers.reduce((sum, l) => sum + Number(l.amount_m), 0)

  return ok({
    layers,
    programs,
    totalM: Math.round(totalM * 1000) / 1000,
    openTranche: layers.find(l => l.is_open)?.layer_key || null,
  })
}
