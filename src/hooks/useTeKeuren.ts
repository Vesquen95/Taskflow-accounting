import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/** Hoe vaak het getal zichzelf ververst als je nergens klikt. Een collega die
 *  iets indient, hoort binnen de minuut zichtbaar te worden -- vaker vragen
 *  levert niets op voor een getal in een menu. */
const VERVERS_MS = 60_000

const GEWIJZIGD = 'taskflow:taakstatus-gewijzigd'

/** Roep dit aan nadat een status gewijzigd is. Wie op het goedkeuringsscherm
 *  zelf iets goedkeurt, hoort het getal meteen te zien zakken -- niet pas bij
 *  de volgende schermwissel of na een minuut. */
export function meldStatusGewijzigd(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GEWIJZIGD))
}

/**
 * Hoeveel aangiftes er op een goedkeuring wachten: het getal naast
 * "Goedkeuren" in het menu.
 *
 * Dezelfde afbakening als het goedkeuringsscherm zelf: elke taak met status
 * `wacht_op_goedkeuring`, zonder deadlinevenster, en wat RLS je niet laat
 * zien telt niet mee. Ook wat je zelf indiende telt mee, want het staat op
 * dat scherm (in een aparte lijst) en het wacht net zo goed.
 *
 * Alleen een telling (`head: true`): het menu heeft geen rijen nodig.
 *
 * `sleutel` ververst bij elke schermwissel. Wie net iets goedkeurde en
 * terugkeert naar de kalender, ziet het getal zakken zonder op de minuut te
 * wachten.
 */
export function useTeKeuren(actief: boolean, sleutel: string): number {
  const [aantal, setAantal] = useState(0)

  const tel = useCallback(async () => {
    if (!actief) return
    const { count, error } = await supabase
      .from('task_instances')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'wacht_op_goedkeuring')
    // Een mislukte telling is geen fout om te melden: het menu blijft gewoon
    // de laatste stand tonen.
    if (!error && typeof count === 'number') setAantal(count)
  }, [actief])

  useEffect(() => {
    void tel()
  }, [tel, sleutel])

  useEffect(() => {
    if (!actief) return
    const klok = window.setInterval(() => void tel(), VERVERS_MS)
    // Terug naar dit tabblad na een tijd elders: meteen bijwerken.
    const opFocus = () => void tel()
    window.addEventListener('focus', opFocus)
    window.addEventListener(GEWIJZIGD, opFocus)
    return () => {
      window.clearInterval(klok)
      window.removeEventListener('focus', opFocus)
      window.removeEventListener(GEWIJZIGD, opFocus)
    }
  }, [actief, tel])

  return actief ? aantal : 0
}
