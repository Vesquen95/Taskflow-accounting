import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { LegalCalendarEntry, PublicHoliday } from '../types'

/** Wettelijke-kalenderbeheer (§4 point 7): campaign deadlines +
 * feestdagen, both editable data (never hardcoded logic, per the ground
 * rules) — and the "Genereer taken nu" action that drives the recurrence
 * engine (see docs/PLAN.md §3.2 + the mechanism-choice note in
 * 0006_recurrence_engine.sql). */
export function useLegalCalendar() {
  const [entries, setEntries] = useState<LegalCalendarEntry[]>([])
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [entriesRes, holidaysRes] = await Promise.all([
        supabase.from('legal_calendar').select('*').order('jaar', { ascending: false }),
        supabase.from('public_holidays').select('*').order('datum', { ascending: true }),
      ])
      if (entriesRes.error) throw entriesRes.error
      if (holidaysRes.error) throw holidaysRes.error
      setEntries((entriesRes.data ?? []) as LegalCalendarEntry[])
      setHolidays((holidaysRes.data ?? []) as PublicHoliday[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kon de wettelijke kalender niet laden.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function addEntry(input: {
    obligation_type_id: string
    jaar: number
    scope: string | null
    deadline_datum: string
    is_override: boolean
    bron: string | null
    actorId: string
  }) {
    const { error: err } = await supabase.from('legal_calendar').insert({
      obligation_type_id: input.obligation_type_id,
      jaar: input.jaar,
      scope: input.scope,
      deadline_datum: input.deadline_datum,
      is_override: input.is_override,
      bron: input.bron,
      aangemaakt_door: input.actorId,
      gewijzigd_door: input.actorId,
    })
    if (err) throw err
    await load()
  }

  async function addHoliday(input: { jaar: number; datum: string; omschrijving: string; actorId: string }) {
    const { error: err } = await supabase.from('public_holidays').insert({
      jaar: input.jaar,
      datum: input.datum,
      omschrijving: input.omschrijving,
      aangemaakt_door: input.actorId,
      gewijzigd_door: input.actorId,
    })
    if (err) throw err
    await load()
  }

  async function generateTaskInstances(horizonMonths = 3, backfillMonths = 6): Promise<number> {
    const { data, error: err } = await supabase.rpc('generate_task_instances', {
      p_horizon_months: horizonMonths,
      p_backfill_months: backfillMonths,
    })
    if (err) throw err
    await load()
    return (data as number) ?? 0
  }

  return { entries, holidays, loading, error, reload: load, addEntry, addHoliday, generateTaskInstances }
}
