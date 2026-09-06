import type { TaskInstanceWithRelations } from '../types'
import { leesVoorafbetaling, vaNaam } from './voorafbetaling'

/**
 * Hoe een taak in tekst benoemd wordt. Eén plaats, zodat een melding en de
 * lijst dezelfde taak op dezelfde manier aanduiden.
 */

type TaakVoorLabel = Pick<TaskInstanceWithRelations, 'title' | 'obligation_type' | 'client' | 'periode_label'>
type TaakVoorLabelMetPeriode = Pick<TaskInstanceWithRelations, 'title' | 'obligation_type' | 'periode_label'>

/** De korte naam zoals ze in de kolom "Verplichting" staat. */
export function taakNaam(task: Pick<TaakVoorLabel, 'title' | 'obligation_type'>): string {
  return task.obligation_type?.naam ?? task.title ?? 'Ad-hoc taak'
}

/**
 * De twee stukken waarmee een taak in een lijst staat: de verplichting en de
 * periode. Eén plaats, want elke lijst en elke tabel zet ze anders naast
 * elkaar en ze horen wel hetzelfde te zeggen.
 *
 * De vier voorafbetalingen dragen in de databank dezelfde naam, met alleen
 * "VA1-2026" in het periodelabel als verschil. Dat label valt weg zodra een
 * lijst de naam afkapt, en dan staan er vier regels die identiek lijken
 * terwijl VA1 zwaarder weegt dan VA4. Hier krijgt het nummer daarom een
 * plaats in de naam zelf, en blijft alleen het jaartal als periode over.
 */
export function taakRegel(task: TaakVoorLabelMetPeriode): {
  naam: string
  periode: string | null
} {
  const va = leesVoorafbetaling(task.obligation_type?.code, task.periode_label)
  if (va) return { naam: vaNaam(va.nummer), periode: va.jaar }
  return { naam: taakNaam(task), periode: task.periode_label }
}

/**
 * De volledige aanduiding voor een melding buiten de rij zelf: zonder klant
 * en periode weet het kantoor bij tientallen gelijkaardige taken niet welke
 * taak bedoeld wordt.
 */
export function taakOmschrijving(task: TaakVoorLabel): string {
  const regel = taakRegel(task)
  const delen = [task.client?.naam, regel.naam, regel.periode ?? undefined]
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
