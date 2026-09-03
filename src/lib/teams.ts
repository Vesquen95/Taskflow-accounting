import type { Team } from '../types'
import type { Teamlid } from '../hooks/useTeams'

/** Wat er op het scherm staat waar plaats is: "ZAV2 — Zaventem 2". De code is
 *  wat het kantoor uitspreekt, de naam maakt hem leesbaar voor wie nieuw is. */
export function teamLabel(team: Team): string {
  return `${team.code} — ${team.naam}`
}

/** Wat er in een tabelcel staat: alleen de code. Een kolom die "Zaventem 1"
 *  voluit schrijft, duwt de klantnaam weg. */
export function teamCode(teams: Team[], teamId: string | null | undefined): string | null {
  if (!teamId) return null
  return teams.find((t) => t.id === teamId)?.code ?? null
}

/** De teams waar deze medewerker in zit. Meervoudig lidmaatschap is normaal:
 *  een vennoot volgt twee teams op. */
export function teamsVan(leden: Teamlid[], employeeId: string | null | undefined): string[] {
  if (!employeeId) return []
  return leden.filter((l) => l.employee_id === employeeId).map((l) => l.team_id)
}

/**
 * De collega's die je kunt kiezen om werk aan te geven op dit dossier.
 *
 * Dit is een hulpmiddel, geen afscherming: wie het dossier niet mag zien,
 * krijgt het van de databank sowieso niet te zien (migratie 0039). Maar een
 * keuzelijst met vijftig namen waarvan er drie zinvol zijn, is een keuzelijst
 * waarin je de verkeerde aanklikt.
 *
 * Twee dingen blijven er bewust in staan:
 *
 *  - Heeft het dossier nog geen team, dan is er niets om op te schuinen en
 *    krijg je iedereen. Een lege lijst zou hier een dood scherm opleveren.
 *  - Wie de taak nu al heeft, blijft in de lijst staan, ook al zit hij niet
 *    (meer) in het team. Anders verdwijnt de huidige waarde uit haar eigen
 *    keuzelijst en lijkt het besturingselement kapot.
 */
export function collegasVoorDossier<T extends { id: string }>(
  medewerkers: T[],
  leden: Teamlid[],
  teamId: string | null | undefined,
  huidigeKeuze?: string | null
): T[] {
  if (!teamId) return medewerkers
  const inTeam = new Set(leden.filter((l) => l.team_id === teamId).map((l) => l.employee_id))
  const gefilterd = medewerkers.filter((m) => inTeam.has(m.id) || m.id === huidigeKeuze)
  // Staat er niemand in het team, dan is filteren erger dan niet filteren:
  // je zou geen enkele collega meer kunnen kiezen.
  return gefilterd.length > 0 ? gefilterd : medewerkers
}
