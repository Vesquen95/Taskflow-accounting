import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { LegalCalendarEntry, PublicHoliday } from '../types'
import { reportError } from '../lib/errorMessage'

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
        // Bewust ook de ingetrokken feestdagen: het correctiepatroon is
        // append-only (migratie 0011/0012), dus de historie hoort zichtbaar
        // te blijven. Het beheerscherm toont ze doorstreept met wie/wanneer/
        // waarom; next_business_day() telt ze niet meer mee.
        supabase.from('public_holidays').select('*').order('datum', { ascending: true }),
      ])
      if (entriesRes.error) throw entriesRes.error
      if (holidaysRes.error) throw holidaysRes.error
      setEntries((entriesRes.data ?? []) as LegalCalendarEntry[])
      setHolidays((holidaysRes.data ?? []) as PublicHoliday[])
    } catch (err) {
      setError(reportError(err, 'Kon de wettelijke kalender niet laden'))
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

  /** Feestdagcorrectie (§3 punt 7): een foutieve feestdag wordt nooit
   * overschreven of verwijderd, maar ingetrokken met een verplichte reden.
   * De RPC is SECURITY DEFINER en doet zelf de kantoorbeheerder-check; de
   * knop in de UI is dus een gemak, geen beveiliging. */
  async function retractHoliday(input: { holidayId: string; reden: string }) {
    const reden = input.reden.trim()
    if (reden.length === 0) {
      throw new Error('Geef een reden op bij het intrekken van een feestdag')
    }
    const { error: err } = await supabase.rpc('retract_public_holiday', {
      p_holiday_id: input.holidayId,
      p_reden: reden,
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

  /** Vult de ontbrekende feestdagen van een reeks jaren aan (migratie 0023).
   *  De database rekent de bewegelijke feestdagen zelf uit vanuit Pasen, en
   *  verzet meteen de deadlines die erop terechtgekomen waren. */
  async function laadFeestdagen(vanJaar: number, totJaar: number): Promise<number> {
    const { data, error: err } = await supabase.rpc('laad_feestdagen', {
      p_van: vanJaar,
      p_tot: totJaar,
    })
    if (err) throw err
    await load()
    return (data as number) ?? 0
  }

  return { entries, holidays, loading, error, reload: load, addEntry, addHoliday, retractHoliday, generateTaskInstances, laadFeestdagen }
}
