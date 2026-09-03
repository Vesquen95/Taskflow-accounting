import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Client } from '../types'
import { reportError } from '../lib/errorMessage'

/** Quote and escape a user-supplied value for use inside a PostgREST
 * `.or()` filter string. PostgREST honours backslash-escaping only inside
 * double quotes, so the value is wrapped in quotes and `"` / `\\` are escaped
 * within it. Without this, a search term containing a comma silently
 * corrupts the filter into unrelated conditions instead of matching the
 * literal substring, and a double quote produces a malformed query. */
function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`
}

export interface ClientFilters {
  zoekterm?: string
  actief?: boolean | 'alle'
  mandataris?: boolean | 'alle'
  rechtsvorm?: string | 'alle'
  verantwoordelijkeId?: string | 'alle'
  /** Het team dat het dossier draait. 'alle' = geen beperking, 'geen' = juist
   *  de dossiers die nog ingedeeld moeten worden. Dit filter dient om te
   *  focussen; afschermen doet de databank (migratie 0039). */
  teamId?: string | 'alle' | 'geen'
}

const DEFAULT_FILTERS: ClientFilters = { actief: true, mandataris: 'alle', rechtsvorm: 'alle', verantwoordelijkeId: 'alle', teamId: 'alle' }

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
      if (filters.teamId === 'geen') query = query.is('team_id', null)
      else if (filters.teamId && filters.teamId !== 'alle') query = query.eq('team_id', filters.teamId)
      if (filters.verantwoordelijkeId && filters.verantwoordelijkeId !== 'alle') {
        query = query.eq('standaard_verantwoordelijke_id', filters.verantwoordelijkeId)
      }
      if (filters.zoekterm && filters.zoekterm.trim().length > 0) {
        const term = quotePostgrestFilterValue(`%${filters.zoekterm.trim()}%`)
        query = query.or(`naam.ilike.${term},ondernemingsnummer.ilike.${term}`)
      }

      const { data, error: err } = await query
      if (err) throw err
      setClients((data ?? []) as Client[])
    } catch (err) {
      setError(reportError(err, 'Kon klanten niet laden'))
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    load()
  }, [load])

  /** Eén klant wegschrijven, zonder de lijst opnieuw op te halen. Bestaat
   *  apart voor de Excel-import: die maakt tot honderden klanten na elkaar
   *  aan, en één herlaadronde per rij zou dat scherm onbruikbaar traag maken.
   *  De import herlaadt zelf één keer als ze klaar is. */
  async function insertClient(input: Omit<Client, 'id' | 'firm_id' | 'created_at'> & { firm_id: string }) {
    const { data, error: err } = await supabase.from('clients').insert(input).select().single()
    if (err) throw err
    return data as Client
  }

  async function createClient(input: Omit<Client, 'id' | 'firm_id' | 'created_at'> & { firm_id: string }) {
    const nieuw = await insertClient(input)
    await load()
    return nieuw
  }

  /** De ondernemingsnummers van alle klanten die deze medewerker mag zien —
   *  ongefilterd, want een dubbel nummer moet ook opvallen tegenover een
   *  gearchiveerde klant. Niet waterdicht: RLS verbergt vertrouwelijke
   *  dossiers, dus de unieke index (firm_id, ondernemingsnummer) blijft de
   *  echte bewaker. Dit dient enkel om het dubbel werk vóóraf te tonen. */
  async function haalOndernemingsnummers(): Promise<string[]> {
    const { data, error: err } = await supabase.from('clients').select('ondernemingsnummer')
    if (err) throw err
    return ((data ?? []) as Array<{ ondernemingsnummer: string | null }>)
      .map((rij) => rij.ondernemingsnummer)
      .filter((nummer): nummer is string => typeof nummer === 'string' && nummer.length > 0)
  }

  async function updateClient(id: string, updates: Partial<Omit<Client, 'id' | 'firm_id' | 'created_at'>>) {
    const { error: err } = await supabase.from('clients').update(updates).eq('id', id)
    if (err) throw err
    await load()
  }

  return {
    clients,
    loading,
    error,
    filters,
    setFilters,
    reload: load,
    createClient,
    insertClient,
    updateClient,
    haalOndernemingsnummers,
  }
}
