import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/errorMessage'

/** Een gemelde wijziging van het boekjaareinde die nog op een beslissing
 *  wacht (migratie 0052). Zolang die openstaat, staan de jaartaken van dit
 *  dossier nog op het OUDE boekjaar. */
export interface BoekjaarWijziging {
  id: string
  client_id: string
  oude_maand: number
  oude_dag: number
  nieuwe_maand: number
  nieuwe_dag: number
  gemeld_op: string
}

/** Eén taak uit het voorstel: wat er nu staat, en of het herrekend kan
 *  worden. `reden` is gevuld precies wanneer dat niet kan. */
export interface BoekjaarWijzigingTaak {
  task_id: string
  verplichting: string
  periode_label: string | null
  periode_eind: string | null
  due_date: string
  status: string
  herzetbaar: boolean
  reden: string | null
}

/**
 * Het openstaande voorstel voor één dossier.
 *
 * Bewust twee stappen: `taken` laat zien wat er zou gebeuren, `doorvoeren`
 * voert het uit. Het kantoor vroeg uitdrukkelijk om automatisch herrekenen
 * mét een menselijke goedkeuring ertussen -- dus geen enkele van deze
 * functies wordt vanzelf aangeroepen.
 */
export function useBoekjaarWijziging(clientId: string | null) {
  const [wijziging, setWijziging] = useState<BoekjaarWijziging | null>(null)
  const [taken, setTaken] = useState<BoekjaarWijzigingTaak[]>([])
  const [loading, setLoading] = useState(true)
  const [bezig, setBezig] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!clientId) {
      setWijziging(null)
      setTaken([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('boekjaar_wijzigingen')
        .select('id, client_id, oude_maand, oude_dag, nieuwe_maand, nieuwe_dag, gemeld_op')
        .eq('client_id', clientId)
        .eq('status', 'open')
        .maybeSingle()
      if (err) throw err

      if (!data) {
        setWijziging(null)
        setTaken([])
        return
      }
      setWijziging(data as BoekjaarWijziging)

      const { data: rijen, error: takenErr } = await supabase.rpc('boekjaar_wijziging_taken', {
        p_wijziging_id: (data as BoekjaarWijziging).id,
      })
      if (takenErr) throw takenErr
      setTaken((rijen ?? []) as BoekjaarWijzigingTaak[])
    } catch (e) {
      setError(reportError(e, 'Het openstaande voorstel voor het boekjaareinde kon niet geladen worden.'))
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    void load()
  }, [load])

  /** Voert het voorstel uit. Geeft terug hoeveel taken herrekend zijn. */
  const doorvoeren = useCallback(async (): Promise<number> => {
    if (!wijziging) return 0
    setBezig(true)
    try {
      const { data, error: err } = await supabase.rpc('boekjaar_wijziging_toepassen', {
        p_wijziging_id: wijziging.id,
      })
      if (err) throw err
      await load()
      return (data as number) ?? 0
    } finally {
      setBezig(false)
    }
  }, [wijziging, load])

  /** Sluit het voorstel zonder iets te herrekenen. */
  const negeren = useCallback(async () => {
    if (!wijziging) return
    setBezig(true)
    try {
      const { error: err } = await supabase.rpc('boekjaar_wijziging_negeren', {
        p_wijziging_id: wijziging.id,
      })
      if (err) throw err
      await load()
    } finally {
      setBezig(false)
    }
  }, [wijziging, load])

  return { wijziging, taken, loading, bezig, error, doorvoeren, negeren, reload: load }
}
