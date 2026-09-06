import type { Employee } from '../types'

/**
 * De wijzigingshistoriek van een dossier leesbaar maken.
 *
 * Het log bewaart kolomnamen en uuid's -- dat hoort ook, want een naam kan
 * later veranderen en het log moet blijven kloppen. Maar op het scherm leest
 * "standaard_verantwoordelijke_id: 8f3c… → a91b…" als niets.
 */

/** Leesbare namen voor `client_change_log.veld`. */
export const VELD_LABEL: Record<string, string> = {
  vertrouwelijk: 'Vertrouwelijk',
  standaard_verantwoordelijke_id: 'Standaard verantwoordelijke',
  toegang_vertrouwelijk_verleend: 'Toegang tot dit vertrouwelijke dossier verleend',
  boekjaar_einde_maand: 'Boekjaareinde (maand)',
  boekjaar_einde_dag: 'Boekjaareinde (dag)',
  btw_regime: 'Btw-regime',
  btw_aangifte_frequentie: 'Btw-aangiftefrequentie',
  actief: 'Actief',
  // Geschreven door de archiveringstrigger (migratie 0026): hoeveel taken het
  // archiveren van dit dossier gekost heeft.
  taken_geannuleerd_bij_archivering: 'Taken geannuleerd bij het archiveren',
  // Migratie 0059: de openstaande taken volgden de nieuwe verantwoordelijke.
  taken_volgen_verantwoordelijke: 'Openstaande taken mee verplaatst',
}

export function veldLabel(veld: string): string {
  return VELD_LABEL[veld] ?? veld
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * Vervangt elk uuid in de waarde door de naam van die medewerker.
 *
 * Bewust op de hele tekst en niet op de waarde als geheel: sommige regels zijn
 * één uuid, andere een zinnetje met een uuid erin ("6 openstaande taken
 * stonden op …"). Een uuid dat bij niemand hoort blijft staan zoals het is --
 * een verwijderde of onbekende medewerker verzinnen we niet.
 */
export function logWaarde(
  waarde: string | null,
  employees: Pick<Employee, 'id' | 'naam'>[]
): string {
  if (!waarde) return '—'
  return waarde.replace(UUID, (gevonden) => {
    const wie = employees.find((e) => e.id.toLowerCase() === gevonden.toLowerCase())
    return wie ? wie.naam : gevonden
  })
}
