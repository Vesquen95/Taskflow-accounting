/**
 * Wat het inlogscherm over de tijd zegt, vóór er iemand ingelogd is.
 *
 * Vóór het inloggen mag de pagina niets uit de databank lezen (RLS), dus
 * rekent ze zelf. Alleen wat zeker is: de datum, het weeknummer, en de
 * wettelijke datum van de btw-kwartaalaangifte -- de 25ste van de maand na het
 * kwartaal, sinds 2026 zonder uitstel naar de volgende werkdag (migratie 0048).
 * Dat is de termijn die elk dossier van het kantoor raakt.
 */

/** ISO-weeknummer: week 1 is de week met de eerste donderdag van het jaar. */
export function isoWeek(datum: Date): number {
  const d = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()))
  const dag = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dag)
  const jaarBegin = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - jaarBegin.getTime()) / 86_400_000 + 1) / 7)
}

export interface BtwTermijn {
  /** ISO-datum van de wettelijke termijn. */
  datum: string
  /** "Q3 2026": het kwartaal waarover aangegeven wordt. */
  kwartaal: string
  /** Hele dagen van vandaag tot de termijn; 0 = vandaag. */
  dagen: number
}

/** De eerstvolgende btw-kwartaaltermijn, vandaag inbegrepen. */
export function volgendeBtwKwartaal(vandaag: Date): BtwTermijn {
  const begin = new Date(vandaag.getFullYear(), vandaag.getMonth(), vandaag.getDate())
  // De termijnen vallen in januari, april, juli en oktober.
  for (let stap = 0; stap < 5; stap++) {
    const maand = Math.floor(begin.getMonth() / 3) * 3 + stap * 3
    const termijn = new Date(begin.getFullYear(), maand, 25)
    if (termijn >= begin) {
      // Het kwartaal dat net voorbij is: de termijn van januari gaat over Q4
      // van het jaar ervoor.
      const vorig = new Date(termijn.getFullYear(), termijn.getMonth() - 3, 1)
      const jaar = termijn.getFullYear()
      const m = String(termijn.getMonth() + 1).padStart(2, '0')
      return {
        datum: `${jaar}-${m}-25`,
        kwartaal: `Q${Math.floor(vorig.getMonth() / 3) + 1} ${vorig.getFullYear()}`,
        dagen: Math.round((termijn.getTime() - begin.getTime()) / 86_400_000),
      }
    }
  }
  throw new Error('Geen btw-termijn gevonden')
}

/** Dag van het jaar, 0 = 1 januari. Voor de stand op de wijzerplaat. */
export function dagVanHetJaar(datum: Date): number {
  const begin = new Date(datum.getFullYear(), 0, 1)
  const d = new Date(datum.getFullYear(), datum.getMonth(), datum.getDate())
  return Math.round((d.getTime() - begin.getTime()) / 86_400_000)
}
