import type { TaskStatus } from '../types'

/**
 * Het archiveren van een klant, aan de kant van het scherm.
 *
 * De databank doet het echte werk (migratie 0026): zet een klant op inactief,
 * dan annuleert een trigger al zijn nog niet afgesloten taken en schrijft
 * daar per taak een regel voor in task_status_log. Het scherm hoeft dat niet
 * na te bootsen — het moet alleen vóóraf kunnen zeggen hoeveel taken het gaat
 * kosten, want dat is niet terug te draaien.
 *
 * Daarom staat de statusregel hier één keer, gedeeld door de bevestiging en
 * door het waarschuwinkje in het klantformulier, en niet twee keer half.
 */

/** Statussen die de databank als afgesloten beschouwt: die blijven staan. */
const AFGESLOTEN_TAAKSTATUSSEN: readonly TaskStatus[] = ['ingediend_afgerond', 'geannuleerd']

/** Werk dat gebeurd is (of al afgesloten) — een archivering raakt dit niet. */
export function isAfgesloten(status: TaskStatus): boolean {
  return AFGESLOTEN_TAAKSTATUSSEN.includes(status)
}

/**
 * Hoeveel taken van deze klant er bij een archivering geannuleerd worden.
 *
 * Telt op wat het scherm ziet, en dat klopt: wie een dossier mag openen ziet
 * via de RLS ook alle taken ervan (can_access_task_row is dossier-breed zodra
 * je toegang hebt), dus dit getal is geen benadering.
 */
export function telTeAnnulerenTaken(taken: ReadonlyArray<{ status: TaskStatus }>): number {
  return taken.filter((t) => !isAfgesloten(t.status)).length
}

/** "1 openstaande taak" / "12 openstaande taken" — enkelvoud is geen detail. */
export function omschrijfOpenstaandeTaken(aantal: number): string {
  return aantal === 1 ? '1 openstaande taak' : `${aantal} openstaande taken`
}
