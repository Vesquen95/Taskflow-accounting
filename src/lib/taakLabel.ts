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
