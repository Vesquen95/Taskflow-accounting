import { useEffect, useState } from 'react'

/**
 * Zit dit scherm onder de lg-grens van Tailwind (1024px)?
 *
 * Bewust een echte mediaquery en niet enkel CSS-klassen: het telefoonscherm is
 * geen ingekrompen versie van de kalender maar een ander scherm, met een eigen
 * vraag naar de databank. Twee schermen tegelijk renderen en er één verbergen
 * zou elke keer twee rondes naar Supabase kosten, en op een telefoonverbinding
 * is dat precies de ronde die je niet wil.
 *
 * De grens is dezelfde 1024px als `lg:` in de klassen. Zo kan er geen scherm
 * bestaan waar de zijbalk al vast staat maar de inhoud nog de telefoonversie
 * toont, of omgekeerd.
 */
export const KLEIN_SCHERM_QUERY = '(max-width: 1023.98px)'

export function useKleinScherm(): boolean {
  const [klein, setKlein] = useState(() => {
    // In een test- of serveromgeving bestaat matchMedia niet. Dan is de
    // computerversie de veilige aanname: dat is het scherm waar alles op staat.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(KLEIN_SCHERM_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(KLEIN_SCHERM_QUERY)
    // Meeluisteren, niet één keer meten: draai je de telefoon, of sleep je een
    // venster op de computer smaller, dan hoort het scherm mee te veranderen.
    const opWijziging = (e: MediaQueryListEvent) => setKlein(e.matches)
    mq.addEventListener('change', opWijziging)
    setKlein(mq.matches)
    return () => mq.removeEventListener('change', opWijziging)
  }, [])

  return klein
}
