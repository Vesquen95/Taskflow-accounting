import type { Employee, MedewerkerNiveau } from '../types'

/**
 * "Deze week" is vandaag plus zes dagen.
 *
 * Datzelfde getal staat in `weekoverzicht_voor()` (migratie 0043): het blok
 * "deze week" van de maandagmail is `due_date <= p_vandaag + 6`. Die twee
 * moeten hetzelfde betekenen -- anders leest een junior in de mail dat er drie
 * dingen zijn en ziet hij er vijf op het scherm, en dan gelooft hij geen van
 * beide meer.
 */
export const WEEK_DAGEN = 6

/**
 * Welke graden beginnen op hun eigen werk van deze week?
 *
 * Junior en senior. Het kantoor: "Junior en senior moeten hun taken van de
 * week zien." De graden daarboven sturen aan en beginnen dus kantoorbreed.
 *
 * Dit is een STANDAARD, geen muur. Een junior moet nog altijd bij de bak van
 * zijn team kunnen om werk op te nemen; de keuzelijsten blijven volledig. Wat
 * verandert is alleen waar hij binnenkomt.
 */
export function begintOpEigenWeek(niveau: MedewerkerNiveau | null): boolean {
  return niveau === 'junior' || niveau === 'senior'
}

/** De laatste dag van "deze week", als ISO-datum. */
export function eindeVanDeWeek(vandaag: string): string {
  const d = new Date(`${vandaag}T00:00:00`)
  d.setDate(d.getDate() + WEEK_DAGEN)
  return d.toISOString().slice(0, 10)
}

export interface Startfilters {
  /** Op wiens naam. Een medewerker-id, of 'alle' voor kantoorbreed. */
  toegewezenAan: string
  /** Bovengrens van het deadlinevenster, of undefined voor geen grens. */
  dueTot: string | undefined
}

/**
 * Waar deze medewerker binnenkomt op de kalender.
 *
 * Zonder medewerker (nog aan het laden) blijft alles staan zoals het was:
 * kantoorbreed en zonder bovengrens. Anders zou het scherm eerst iets anders
 * tonen dan waar het op uitkomt.
 */
export function startfiltersVoor(employee: Employee | null, vandaag: string): Startfilters {
  if (!employee || !begintOpEigenWeek(employee.niveau)) {
    return { toegewezenAan: 'alle', dueTot: undefined }
  }
  return { toegewezenAan: employee.id, dueTot: eindeVanDeWeek(vandaag) }
}
