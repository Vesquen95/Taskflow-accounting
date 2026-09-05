import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/errorMessage'

/** Eén regel per team, met de vier risicogetallen (migratie 0056). */
export interface OverzichtRij {
  team_id: string | null
  team_code: string | null
  team_naam: string | null
  open_totaal: number
  te_laat: number
  te_laat_wettelijk: number
  niemand_op: number
  niemand_op_te_laat: number
  te_lang_bij_klant: number
  wacht_op_goedkeuring: number
}

/** Eén regel per medewerker voor het workload-scherm. */
export interface WorkloadRij {
  employee_id: string
  naam: string
  niveau: string | null
  open_totaal: number
  te_laat: number
  binnen_7_dagen: number
  binnen_31_dagen: number
  wacht_op_goedkeuring: number
}

/**
 * De getallen komen uit de databank en niet uit de browser.
 *
 * Het oude workload-dashboard haalde élke openstaande taak van het kantoor op
 * -- op de testomgeving 3.588 rijen met drie gejoinde objecten -- om er in de
 * browser 66 getallen van te maken. Er stond geen expliciete grens op die
 * query, dus de standaardgrens van PostgREST bepaalde stilzwijgend hoeveel er
 * meekwam. Een afgekapt totaal ziet er precies uit als een kloppend totaal.
 */
export function useKantooroverzicht() {
  const [rijen, setRijen] = useState<OverzichtRij[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.rpc('kantooroverzicht')
      if (err) throw err
      setRijen((data ?? []) as OverzichtRij[])
    } catch (e) {
      setError(reportError(e, 'Het overzicht kon niet geladen worden.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { rijen, loading, error, reload: load }
}

export function useWorkload() {
  const [rijen, setRijen] = useState<WorkloadRij[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.rpc('workload_per_medewerker')
      if (err) throw err
      setRijen((data ?? []) as WorkloadRij[])
    } catch (e) {
      setError(reportError(e, 'Het workload-overzicht kon niet geladen worden.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { rijen, loading, error, reload: load }
}
