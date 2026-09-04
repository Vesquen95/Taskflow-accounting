import type { MedewerkerNiveau } from '../types'

/** De zes graden van het kantoor, van laag naar hoog. De volgorde is de
 *  rangorde: ze bepaalt waar de grens van het goedkeuringsrecht ligt. */
export const NIVEAUS: { waarde: MedewerkerNiveau; label: string }[] = [
  { waarde: 'junior', label: 'Junior' },
  { waarde: 'senior', label: 'Senior' },
  { waarde: 'supervisor', label: 'Supervisor' },
  { waarde: 'manager', label: 'Manager' },
  { waarde: 'director', label: 'Director' },
  { waarde: 'partner', label: 'Partner' },
]

/** Vanaf manager mag je aangiftes goedkeuren.
 *
 *  Dezelfde regel als niveau_mag_goedkeuren() in de databank (0042). Twee
 *  plekken, want het scherm moet het kunnen tonen vóór er iets opgeslagen is
 *  -- maar de databank blijft de handhaving, en deze functie belooft niets
 *  wat zij zou weigeren. */
export function niveauMagGoedkeuren(niveau: MedewerkerNiveau | null): boolean {
  if (!niveau) return false
  return ['manager', 'director', 'partner'].includes(niveau)
}

export function niveauLabel(niveau: MedewerkerNiveau | null): string {
  return NIVEAUS.find((n) => n.waarde === niveau)?.label ?? '—'
}
