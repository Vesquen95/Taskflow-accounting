import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/errorMessage'
import type { Employee, TaskInstanceWithRelations } from '../types'

const SELECT =
  '*, client:clients!inner(id,naam,vertrouwelijk,actief,team_id), ' +
  'obligation_type:obligation_types(id,code,naam,categorie,werkstroom), ' +
  'toegewezen_medewerker:employees!task_instances_toegewezen_medewerker_id_fkey(id,naam), ' +
  'goedgekeurd:employees!task_instances_goedgekeurd_door_fkey(id,naam)'

/** Hoeveel regels er hoogstens komen. Meer is geen lijst om in te zoeken maar een archief. */
export const MAX_AFGEROND = 300

export type AfgerondeTaak = TaskInstanceWithRelations & { goedgekeurd: Pick<Employee, 'id' | 'naam'> | null }

export interface AfgerondFilters {
  /** Afgerond op of na deze ISO-datum. */
  vanaf: string
  team?: string | 'alle'
  toegewezenAan?: string | 'alle'
}

/**
 * Wat er sinds een datum afgerond werd (0070), het recentste eerst. RLS geldt
 * zoals overal: wat je niet mag zien, staat er niet in.
 */
export function useAfgerondeTaken(filters: AfgerondFilters) {
  const [taken, setTaken] = useState<AfgerondeTaak[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { vanaf, team, toegewezenAan } = filters

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    let query = supabase
      .from('task_instances')
      .select(SELECT)
      .eq('status', 'ingediend_afgerond')
      .gte('afgerond_op', vanaf)
    if (team && team !== 'alle') query = query.eq('client.team_id', team)
    if (toegewezenAan && toegewezenAan !== 'alle') query = query.eq('toegewezen_medewerker_id', toegewezenAan)
    const { data, error: err } = await query.order('afgerond_op', { ascending: false }).limit(MAX_AFGEROND)
    if (err) {
      setError(reportError(err))
      setTaken([])
    } else {
      setTaken((data ?? []) as unknown as AfgerondeTaak[])
    }
    setLoading(false)
  }, [vanaf, team, toegewezenAan])

  useEffect(() => {
    void load()
  }, [load])

  return { taken, loading, error, reload: load }
}
