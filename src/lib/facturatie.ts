import type { Employee, FactuurpostMetRelaties } from '../types'

/** De regels achter het scherm Te factureren (migratie 0069). */

/** Afvinken is de stap die geld betekent: zelfde grens als de databank. */
export function magAfvinken(employee: Pick<Employee, 'rol' | 'mag_goedkeuren'> | null): boolean {
  return !!employee && (employee.rol === 'kantoorbeheerder' || employee.mag_goedkeuren)
}

/** Per klant, alfabetisch. Een factuur maak je per klant, dus zo hoort de lijst te lezen. */
export function perKlant(posten: FactuurpostMetRelaties[]): { klant: FactuurpostMetRelaties['client']; posten: FactuurpostMetRelaties[] }[] {
  const groepen = new Map<string, { klant: FactuurpostMetRelaties['client']; posten: FactuurpostMetRelaties[] }>()
  for (const post of posten) {
    const groep = groepen.get(post.client_id) ?? { klant: post.client, posten: [] }
    groep.posten.push(post)
    groepen.set(post.client_id, groep)
  }
  return [...groepen.values()].sort((a, b) => a.klant.naam.localeCompare(b.klant.naam, 'nl'))
}

/** Vandaag als ISO-datum, in de tijdzone van wie het scherm gebruikt. */
export function vandaag(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Iets op de lijst gezet of afgevinkt, ergens in de app: wie de lijst toont, laadt opnieuw. */
export const FACTUURPOSTEN_GEWIJZIGD = 'taskflow:factuurposten-gewijzigd'

export function meldFactuurpostenGewijzigd(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FACTUURPOSTEN_GEWIJZIGD))
}
