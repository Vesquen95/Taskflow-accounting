import type { PublicHoliday } from '../types'

/** Zoveel maanden vooruit genereert de motor taken (migratie 0016/0021). */
const HORIZON_MAANDEN = 36

/** Belgie telt tien wettelijke feestdagen (wet van 4 januari 1974). Een jaar
 *  met minder is niet volledig ingevoerd. */
const FEESTDAGEN_PER_JAAR = 10

/**
 * Het laatste jaar waarvoor de kalender volledig is.
 *
 * Alleen volledige jaren tellen: een enkele losse feestdag in 2040 mag niet
 * doorgaan voor "2040 is in orde". Ingetrokken feestdagen tellen niet mee --
 * die zijn geen vrije dag meer en dus ook geen dekking.
 */
export function feestdagenDekking(holidays: PublicHoliday[]): number {
  const perJaar = new Map<number, number>()
  for (const h of holidays) {
    if (h.ingetrokken) continue
    perJaar.set(h.jaar, (perJaar.get(h.jaar) ?? 0) + 1)
  }
  let laatste = 0
  for (const [jaar, aantal] of perJaar) {
    if (aantal >= FEESTDAGEN_PER_JAAR && jaar > laatste) laatste = jaar
  }
  return laatste
}

/** Het laatste jaar waarin de motor nog taken kan plaatsen. */
export function horizonJaar(vandaag: Date = new Date()): number {
  const d = new Date(vandaag.getFullYear(), vandaag.getMonth(), 1)
  d.setMonth(d.getMonth() + HORIZON_MAANDEN)
  return d.getFullYear()
}

export interface DekkingStatus {
  dekkingTot: number
  horizonTot: number
  /** Aantal jaren dat de kalender tekortkomt; 0 wanneer ze ver genoeg loopt. */
  tekort: number
}

/**
 * Loopt de feestdagenkalender ver genoeg voor op de generatiehorizon?
 *
 * Dit is geen theoretische vraag. Toen de horizon op 36 maanden kwam te staan
 * terwijl de kalender in 2027 ophield, verschoof de motor voorbij dat jaar
 * alleen nog op weekends: een algemene vergadering belandde op 1 januari 2029,
 * Nieuwjaar. Niets in het systeem merkte dat op -- daarom staat de waarschuwing
 * nu op het beheerscherm, voor het misgaat in plaats van erna.
 */
export function dekkingStatus(
  holidays: PublicHoliday[],
  vandaag: Date = new Date()
): DekkingStatus {
  const dekkingTot = feestdagenDekking(holidays)
  const horizonTot = horizonJaar(vandaag)
  return { dekkingTot, horizonTot, tekort: Math.max(0, horizonTot - dekkingTot) }
}
