import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Team } from '../types'
import { reportError } from '../lib/errorMessage'

/** Eén rij uit de koppeltabel: deze medewerker zit in dit team. */
export interface Teamlid {
  employee_id: string
  team_id: string
}

/**
 * De teams van het kantoor en wie erin zit.
 *
 * Iedereen mag de teamlijst en de lidmaatschappen lezen -- je moet kunnen
 * weten bij wie een dossier hoort, ook als je er zelf niet in mag. Wijzigen
 * is voorbehouden aan een kantoorbeheerder: lid worden van een team ís
 * toegang krijgen, en dat is geen beslissing die je zelf neemt (migratie
 * 0038).
 */
export function useTeams() {
  const [teams, setTeams] = useState<Team[]>([])
  const [leden, setLeden] = useState<Teamlid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [teamsRes, ledenRes] = await Promise.all([
        supabase.from('teams').select('*').order('code', { ascending: true }),
        supabase.from('employee_teams').select('employee_id,team_id'),
      ])
      if (teamsRes.error) throw teamsRes.error
      if (ledenRes.error) throw ledenRes.error
      setTeams((teamsRes.data ?? []) as Team[])
      setLeden((ledenRes.data ?? []) as Teamlid[])
    } catch (err) {
      setError(reportError(err, 'Kon de teams niet laden'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function voegLidToe(employeeId: string, teamId: string) {
    const { error: err } = await supabase
      .from('employee_teams')
      .insert({ employee_id: employeeId, team_id: teamId })
    if (err) throw err
    await load()
  }

  async function verwijderLid(employeeId: string, teamId: string) {
    const { error: err } = await supabase
      .from('employee_teams')
      .delete()
      .eq('employee_id', employeeId)
      .eq('team_id', teamId)
    if (err) throw err
    await load()
  }

  return { teams, leden, loading, error, reload: load, voegLidToe, verwijderLid }
}
