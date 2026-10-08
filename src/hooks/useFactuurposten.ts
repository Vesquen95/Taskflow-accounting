import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/errorMessage'
import { FACTUURPOSTEN_GEWIJZIGD, meldFactuurpostenGewijzigd } from '../lib/facturatie'
import type { FactuurpostMetRelaties, FactuurpostStatus } from '../types'

const SELECT =
  '*, client:clients!inner(id,naam,vertrouwelijk,team_id), ' +
  'aangemaakt:employees!factuurposten_aangemaakt_door_fkey(id,naam), ' +
  'afgehandeld:employees!factuurposten_afgehandeld_door_fkey(id,naam)'

export interface FactuurpostFilters {
  status: FactuurpostStatus
  /** Alleen dit dossier (het klantdossier toont zijn eigen lijst). */
  clientId?: string
  /** Het team dat het dossier draait; 'alle' = geen beperking. Focus, geen
   *  afscherming: wat je niet mag zien, laat de databank er niet uit. */
  team?: string | 'alle'
}

export interface NieuwePost {
  clientId: string
  omschrijving: string
  uitgevoerdOp: string
  taskInstanceId?: string | null
  notitie?: string | null
}

/**
 * De lijst "te factureren" (migratie 0069).
 *
 * Lezen gaat rechtstreeks (RLS: wie het dossier mag zien, ziet zijn posten);
 * schrijven alleen via de drie databankfuncties, die zelf stempelen wie wat
 * deed en wie mag afvinken.
 */
export function useFactuurposten(filters: FactuurpostFilters) {
  const [posten, setPosten] = useState<FactuurpostMetRelaties[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { status, clientId, team } = filters

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    let query = supabase.from('factuurposten').select(SELECT).eq('status', status)
    if (clientId) query = query.eq('client_id', clientId)
    if (team && team !== 'alle') query = query.eq('client.team_id', team)
    // Open: oudste prestatie eerst, want die wacht het langst. Afgehandeld:
    // het recentst afgehandelde eerst, zoals een historiek.
    query =
      status === 'te_factureren'
        ? query.order('uitgevoerd_op', { ascending: true })
        : query.order('afgehandeld_op', { ascending: false }).limit(300)
    const { data, error: err } = await query
    if (err) {
      setError(reportError(err))
      setPosten([])
    } else {
      setPosten((data ?? []) as unknown as FactuurpostMetRelaties[])
    }
    setLoading(false)
  }, [status, clientId, team])

  useEffect(() => {
    void load()
  }, [load])

  // Vanuit een taak op de lijst gezet terwijl deze lijst openstaat (het
  // klantdossier, met het taakvenster erboven): meteen tonen.
  useEffect(() => {
    const opWijziging = () => void load()
    window.addEventListener(FACTUURPOSTEN_GEWIJZIGD, opWijziging)
    return () => window.removeEventListener(FACTUURPOSTEN_GEWIJZIGD, opWijziging)
  }, [load])

  async function toevoegen(post: NieuwePost) {
    const { error: err } = await supabase.rpc('factuurpost_toevoegen', {
      p_client_id: post.clientId,
      p_omschrijving: post.omschrijving,
      p_uitgevoerd_op: post.uitgevoerdOp,
      p_task_instance_id: post.taskInstanceId ?? null,
      p_notitie: post.notitie ?? null,
    })
    if (err) throw err
    meldFactuurpostenGewijzigd()
  }

  async function wijzigen(id: string, omschrijving: string, uitgevoerdOp: string, notitie: string | null) {
    const { error: err } = await supabase.rpc('factuurpost_wijzigen', {
      p_id: id,
      p_omschrijving: omschrijving,
      p_uitgevoerd_op: uitgevoerdOp,
      p_notitie: notitie,
    })
    if (err) throw err
    meldFactuurpostenGewijzigd()
  }

  async function afhandelen(ids: string[], nieuweStatus: FactuurpostStatus, factuurreferentie?: string) {
    const { error: err } = await supabase.rpc('factuurposten_afhandelen', {
      p_ids: ids,
      p_status: nieuweStatus,
      p_factuurreferentie: factuurreferentie ?? null,
    })
    if (err) throw err
    meldFactuurpostenGewijzigd()
  }

  return { posten, loading, error, reload: load, toevoegen, wijzigen, afhandelen }
}
