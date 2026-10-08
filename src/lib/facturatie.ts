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
