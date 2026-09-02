import type { TaskInstanceWithRelations } from '../types'

/**
 * Hoe een taak in tekst benoemd wordt. Eén plaats, zodat een melding en de
 * lijst dezelfde taak op dezelfde manier aanduiden.
 */

type TaakVoorLabel = Pick<TaskInstanceWithRelations, 'title' | 'obligation_type' | 'client' | 'periode_label'>

/** De korte naam zoals ze in de kolom "Verplichting" staat. */
export function taakNaam(task: Pick<TaakVoorLabel, 'title' | 'obligation_type'>): string {
  return task.obligation_type?.naam ?? task.title ?? 'Ad-hoc taak'
}

/**
 * De volledige aanduiding voor een melding buiten de rij zelf: zonder klant
 * en periode weet het kantoor bij tientallen gelijkaardige taken niet welke
 * taak bedoeld wordt.
 */
export function taakOmschrijving(task: TaakVoorLabel): string {
  const delen = [task.client?.naam, taakNaam(task), task.periode_label ?? undefined]
  return delen.filter((deel): deel is string => !!deel && deel.length > 0).join(' — ')
}

/**
 * De teruggaaf van buitenlandse btw als ad-hoc taak.
 *
 * Ze is geen terugkerende verplichting in Taskflow: niet elke klant heeft
 * buitenlandse btw, en meestal weet je het pas wanneer de facturen er zijn.
 * Maar de termijn is wél vast, en die telkens opnieuw uitrekenen is precies
 * waar een datum verkeerd gaat: je vraagt de btw van 2025 terug tegen
 * 30 september 2026, niet 2025.
 */
export const BUITENLANDSE_BTW_TITEL = 'Teruggaaf buitenlandse btw'

/** De titel voor één teruggaafjaar, bv. "Teruggaaf buitenlandse btw 2025". */
export function buitenlandseBtwTitel(jaar: number): string {
  return `${BUITENLANDSE_BTW_TITEL} ${jaar}`
}

/** De uiterste datum: 30 september van het jaar ná het teruggaafjaar. */
export function buitenlandseBtwDeadline(jaar: number): string {
  return `${jaar + 1}-09-30`
}

/** De jaren die je redelijkerwijs nog kunt indienen: het lopende jaar en de
 *  twee ervoor. Verder terug is de termijn hoe dan ook verstreken. */
export function buitenlandseBtwJaren(vandaag: Date = new Date()): number[] {
  const dit = vandaag.getFullYear()
  return [dit, dit - 1, dit - 2]
}
