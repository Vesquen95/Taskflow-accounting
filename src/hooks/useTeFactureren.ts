import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { FACTUURPOSTEN_GEWIJZIGD } from '../lib/facturatie'

const VERVERS_MS = 60_000

/**
 * Hoeveel posten er nog te factureren zijn: het getal naast "Te factureren"
 * in het menu (0069).
 *
 * Wat RLS je niet laat zien, telt niet mee -- het getal klopt dus met wat je
 * op het scherm zult vinden. Telt opnieuw bij elke schermwissel, bij terugkeer
 * naar het tabblad, elke minuut, en meteen wanneer ergens een post op de lijst
 * komt of afgevinkt wordt.
 */
export function useTeFactureren(sleutel: string): number {
  const [aantal, setAantal] = useState(0)

  const tel = useCallback(async () => {
    const { count, error } = await supabase
      .from('factuurposten')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'te_factureren')
    // Een mislukte telling is geen fout om te melden: het menu houdt de laatste stand.
    if (!error && typeof count === 'number') setAantal(count)
  }, [])

  useEffect(() => {
    void tel()
  }, [tel, sleutel])

  useEffect(() => {
    const klok = window.setInterval(() => void tel(), VERVERS_MS)
    const opnieuw = () => void tel()
    window.addEventListener('focus', opnieuw)
    window.addEventListener(FACTUURPOSTEN_GEWIJZIGD, opnieuw)
    return () => {
      window.clearInterval(klok)
      window.removeEventListener('focus', opnieuw)
      window.removeEventListener(FACTUURPOSTEN_GEWIJZIGD, opnieuw)
    }
  }, [tel])

  return aantal
}
