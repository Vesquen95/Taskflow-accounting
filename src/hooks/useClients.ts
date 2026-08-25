import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Client } from '../types'

/** Escape characters that are syntactically significant in a PostgREST
 * filter value (`,` separates or-conditions, `(`/`)` group them, and
 * `%`/`*` are ilike/pattern wildcards) before interpolating user input into
 * a `.or()`/`.ilike()` filter string. Without this, a search term
 * containing e.g. a comma silently corrupts the filter into unrelated
 * conditions instead of matching the literal substring. */
function escapePostgrestFilterValue(value: string): string {
  return value.replace(/[,()%*\\]/g, (char) => `\\${char}`)
}

export interface ClientFilters {
  zoekterm?: string
  actief?: boolean | 'alle'
  mandataris?: boolean | 'alle'
  rechtsvorm?: string | 'alle'
  verantwoordelijkeId?: string | 'alle'
}

const DEFAULT_FILTERS: ClientFilters = { actief: true, mandataris: 'alle', rechtsvorm: 'alle', verantwoordelijkeId: 'alle' }

/** Klantenlijst/zoekscherm (§4 point 8). RLS (can_access_client) already
 * hides confidential clients this employee has no reason to see — this
 * hook only adds further, non-security filtering on top of that. */
export function useClients(initialFilters: ClientFilters = DEFAULT_FILTERS) {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<ClientFilters>(initialFilters)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let query = supabase.from('clients').select('*').order('naam', { ascending: true })

      if (filters.actief === true) query = query.eq('actief', true)
      if (filters.actief === false) query = query.eq('actief', false)
      if (filters.mandataris === true) query = query.eq('mandataris', true)
      if (filters.mandataris === false) query = query.eq('mandataris', false)
      if (filters.rechtsvorm && filters.rechtsvorm !== 'alle') query = query.eq('rechtsvorm', filters.rechtsvorm)
      if (filters.verantwoordelijkeId && filters.verantwoordelijkeId !== 'alle') {
        query = query.eq('standaard_verantwoordelijke_id', filters.verantwoordelijkeId)
      }
      if (filters.zoekterm && filters.zoekterm.trim().length > 0) {
        const term = escapePostgrestFilterValue(filters.zoekterm.trim())
        query = query.or(`naam.ilike.%${term}%,ondernemingsnummer.ilike.%${term}%`)
      }

      const { data, error: err } = await query
      if (err) throw err
      setClients((data ?? []) as Client[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kon klanten niet laden.')
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    load()
  }, [load])

  async function createClient(input: Omit<Client, 'id' | 'firm_id' | 'created_at'> & { firm_id: string }) {
    const { data, error: err } = await supabase.from('clients').insert(input).select().single()
    if (err) throw err
    await load()
    return data as Client
  }

  async function updateClient(id: string, updates: Partial<Omit<Client, 'id' | 'firm_id' | 'created_at'>>) {
    const { error: err } = await supabase.from('clients').update(updates).eq('id', id)
    if (err) throw err
    await load()
  }

  return { clients, loading, error, filters, setFilters, reload: load, createClient, updateClient }
}
