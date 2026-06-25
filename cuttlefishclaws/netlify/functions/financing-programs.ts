import type { Handler } from '@netlify/functions'
import { supabase } from './_shared/supabase'
import { preflight, ok, err } from './_shared/cors'

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight()
  if (event.httpMethod !== 'GET') return err('Method not allowed', 405)

  const { layer, category } = event.queryStringParameters || {}

  let query = supabase
    .from('financing_programs')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true })

  if (layer) {
    query = query.contains('applies_to', [layer])
  }

  if (category) {
    query = query.eq('category', category)
  }

  const { data, error } = await query

  if (error) {
    console.error('[financing-programs]', error)
    return err('Failed to load programs', 500)
  }

  const grouped: Record<string, typeof data> = {}
  ;(data || []).forEach(p => {
    if (!grouped[p.category]) grouped[p.category] = []
    grouped[p.category]!.push(p)
  })

  return ok({
    programs: data || [],
    grouped,
    total: (data || []).length,
    filtered_by: { layer: layer || null, category: category || null },
  })
}
