import type { Employee, MedewerkerNiveau } from '../types'

/**
 * Vanaf welke graad je het kantooroverzicht mag openen: supervisor en hoger.
 *
 * Dat is een LAGERE grens dan die voor goedkeuren (manager, zie
 * `niveauMagGoedkeuren`), en met opzet. Het kantoor: "Partners zijn meestal
 * lui en kijken hier niet veel en snel naar. Supervisor en manager zullen het
 * meeste moeten doen." Meekijken en tekenen zijn niet hetzelfde recht.
 *
 * Dezelfde regel als `niveau_mag_overzicht()` in de databank (0056). Twee
 * plekken, want het menu moet weten wat het mag tonen vóór er een query
 * vertrekt -- maar de databank blijft de handhaving, en deze functie belooft
 * niets wat zij zou weigeren.
 */
export function niveauMagOverzicht(niveau: MedewerkerNiveau | null): boolean {
  if (!niveau) return false
  return ['supervisor', 'manager', 'director', 'partner'].includes(niveau)
}

/**
 * Mag deze medewerker het overzicht openen?
 *
 * Een kantoorbeheerder mag er sowieso bij, ook zonder graad: die beheert het
 * kantoor. Voor de rest beslist de graad.
 */
export function magOverzichtZien(employee: Employee | null): boolean {
  if (!employee) return false
  return employee.rol === 'kantoorbeheerder' || niveauMagOverzicht(employee.niveau)
}
