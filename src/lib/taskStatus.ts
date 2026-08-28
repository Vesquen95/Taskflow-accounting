import type { Employee, TaskInstance, TaskStatus } from '../types'
import { reportError } from './errorMessage'

/**
 * Eén bron van waarheid in de app voor "welke statusstap mag deze medewerker
 * nu zetten op deze taak".
 *
 * De databank beslist — `enforce_task_instance_transition` (migratie 0011)
 * is en blijft de handhaving. Dit bestand is de *spiegel* van die trigger
 * voor het scherm: wat de databank zou weigeren, hoort niet als keuze op het
 * scherm te staan.
 *
 * Waarom het bestaat: die kennis stond half in TaskDetailModal (een kopie
 * van de whitelist zónder de goedkeuringsvoorwaarde) en helemaal niet in
 * TaskTable. Gevolg in productie: 204 van de 252 openstaande taken
 * — alle wettelijke taken met `vereist_goedkeuring` — boden
 * "Ingediend/afgerond" aan, en elke klik daarop faalde. Twee kopieën van een
 * regel zijn één kopie te veel; vanaf nu leest elk scherm hier.
 *
 * De drie ingrediënten die samen bepalen wat mag:
 *   1. de huidige status van de taak,
 *   2. `vereist_goedkeuring` van de taak,
 *   3. `mag_goedkeuren` van de ingelogde medewerker.
 */

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Open',
  in_uitvoering: 'In uitvoering',
  wacht_op_klant: 'Wacht op klant',
  wacht_op_goedkeuring: 'Wacht op goedkeuring',
  ingediend_afgerond: 'Ingediend/afgerond',
  geannuleerd: 'Geannuleerd',
}

/** Statussen waarin een taak afgesloten is: de trigger weigert elke wijziging. */
export const EINDSTATUSSEN: readonly TaskStatus[] = ['ingediend_afgerond', 'geannuleerd']

/**
 * Letterlijke kopie van de whitelist in `enforce_task_instance_transition`
 * (migratie 0011, blok (a)). Vooruit overslaan mag, terug naar `open` niet.
 * Deze tabel alléén volstaat niet — zie `overgangToegestaan`.
 */
const DB_WHITELIST: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd'],
  in_uitvoering: ['wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd'],
  wacht_op_klant: ['in_uitvoering', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd'],
  wacht_op_goedkeuring: ['in_uitvoering', 'ingediend_afgerond', 'geannuleerd'],
  ingediend_afgerond: [],
  geannuleerd: [],
}

/** De drie ingrediënten, losgekoppeld van de databasetypes zodat de regels puur testbaar blijven. */
export interface StatusContext {
  status: TaskStatus
  vereistGoedkeuring: boolean
  magGoedkeuren: boolean
}

export function statusContext(
  task: Pick<TaskInstance, 'status' | 'vereist_goedkeuring'>,
  employee: Pick<Employee, 'mag_goedkeuren'> | null | undefined
): StatusContext {
  return {
    status: task.status,
    vereistGoedkeuring: task.vereist_goedkeuring,
    // Geen medewerker geladen = geen goedkeuringsrecht. Nooit optimistisch
    // gokken: dat is precies hoe je een knop toont die de databank weigert.
    magGoedkeuren: employee?.mag_goedkeuren === true,
  }
}

/**
 * `voortgang` = een stap vooruit (of terug) in de werkstroom.
 * `annulatie` = de taak afbreken. Bewust een aparte soort: annuleren mag
 * altijd en door iedereen, maar het is géén vervolgstap. Een taak in
 * wacht_op_goedkeuring heeft voor een medewerker zonder goedkeuringsrecht
 * dus nul vervolgstappen — met annuleren nog steeds beschikbaar.
 */
export type StatusActieSoort = 'voortgang' | 'annulatie'

export interface StatusActie {
  /** De status waar de taak na afloop van alle stappen staat. */
  doel: TaskStatus
  label: string
  /**
   * De statuswijzigingen die na elkaar geschreven moeten worden. Meestal één.
   * Twee bij "Afronden" op een goedkeuringsplichtige taak: de databank eist
   * de tussenstap `wacht_op_goedkeuring`, dus die zetten we zelf.
   */
  stappen: readonly TaskStatus[]
  soort: StatusActieSoort
}

/** De tekst die het scherm toont wanneer er voor deze persoon niets te doen valt. */
export const WACHT_OP_GOEDKEURDER_UITLEG =
  'Deze taak wacht op goedkeuring. Enkel medewerkers met goedkeuringsrecht kunnen ze goedkeuren of terugsturen.'

/** Korte variant voor een title/tooltip op een niet-doorklikbare statusbadge. */
export const WACHT_OP_GOEDKEURDER_KORT = 'Wacht op iemand met goedkeuringsrecht'

/**
 * Zou de databank deze overgang aanvaarden? Spiegelt, in dezelfde volgorde,
 * de controles van `enforce_task_instance_transition` (migratie 0011).
 */
export function overgangToegestaan(
  van: TaskStatus,
  naar: TaskStatus,
  ctx: Pick<StatusContext, 'vereistGoedkeuring' | 'magGoedkeuren'>
): boolean {
  // Afgesloten taak: elke wijziging wordt geweigerd.
  if (EINDSTATUSSEN.includes(van)) return false
  if (!DB_WHITELIST[van].includes(naar)) return false

  // "Deze taak vereist geen goedkeuring (categorie is geen 'wettelijk')".
  if (naar === 'wacht_op_goedkeuring' && !ctx.vereistGoedkeuring) return false

  // Kern van F-3: een goedkeuringsplichtige taak kan nooit rechtstreeks
  // afgerond worden, enkel via wacht_op_goedkeuring.
  if (naar === 'ingediend_afgerond' && ctx.vereistGoedkeuring && van !== 'wacht_op_goedkeuring') return false

  // Uit wacht_op_goedkeuring komen — goedkeurend of afkeurend — mag enkel
  // wie mag_goedkeuren heeft. Annuleren valt hier bewust buiten, net als in
  // de trigger.
  if (van === 'wacht_op_goedkeuring' && (naar === 'ingediend_afgerond' || naar === 'in_uitvoering')) {
    return ctx.magGoedkeuren
  }

  return true
}

function voortgangsLabel(van: TaskStatus, naar: TaskStatus): string {
  if (naar === 'wacht_op_goedkeuring') return 'Dien in voor goedkeuring'
  if (van === 'wacht_op_goedkeuring' && naar === 'in_uitvoering') return 'Terugsturen (afkeuren)'
  if (van === 'wacht_op_goedkeuring' && naar === 'ingediend_afgerond') return 'Goedkeuren'
  if (naar === 'ingediend_afgerond') return 'Afronden'
  return STATUS_LABEL[naar]
}

function enkeleStap(van: TaskStatus, naar: TaskStatus, soort: StatusActieSoort = 'voortgang'): StatusActie {
  return { doel: naar, label: voortgangsLabel(van, naar), stappen: [naar], soort }
}

/**
 * De weg naar afgerond. Drie gevallen:
 *  - taak zonder goedkeuringsvereiste: rechtstreeks afronden;
 *  - goedkeuringsplichtige taak, gebruiker mag goedkeuren: indienen én
 *    goedkeuren in één actie (PLAN §7 punt 3 laat vier ogen technisch toe,
 *    met een waarschuwing in de UI). Op een eenmanskantoor was dit anders
 *    twee identieke handelingen na elkaar;
 *  - goedkeuringsplichtige taak, gebruiker mag niet goedkeuren: geen
 *    afrondactie — enkel indienen voor goedkeuring.
 */
function afrondActie(ctx: StatusContext): StatusActie | null {
  if (overgangToegestaan(ctx.status, 'ingediend_afgerond', ctx)) {
    return enkeleStap(ctx.status, 'ingediend_afgerond')
  }
  if (
    overgangToegestaan(ctx.status, 'wacht_op_goedkeuring', ctx) &&
    overgangToegestaan('wacht_op_goedkeuring', 'ingediend_afgerond', ctx)
  ) {
    return {
      doel: 'ingediend_afgerond',
      label: 'Afronden (indienen en zelf goedkeuren)',
      stappen: ['wacht_op_goedkeuring', 'ingediend_afgerond'],
      soort: 'voortgang',
    }
  }
  return null
}

/** Alles wat deze medewerker nu met deze taak mag doen, annulatie inbegrepen. */
export function beschikbareStatusActies(ctx: StatusContext): StatusActie[] {
  const acties: StatusActie[] = []
  if (EINDSTATUSSEN.includes(ctx.status)) return acties

  for (const doel of ['in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring'] as const) {
    if (overgangToegestaan(ctx.status, doel, ctx)) acties.push(enkeleStap(ctx.status, doel))
  }

  const afronden = afrondActie(ctx)
  if (afronden) acties.push(afronden)

  if (overgangToegestaan(ctx.status, 'geannuleerd', ctx)) {
    acties.push(enkeleStap(ctx.status, 'geannuleerd', 'annulatie'))
  }

  return acties
}

/** Enkel de stappen vooruit — annuleren is geen vervolgstap. */
export function voortgangsActies(ctx: StatusContext): StatusActie[] {
  return beschikbareStatusActies(ctx).filter((a) => a.soort === 'voortgang')
}

export function annulatieActie(ctx: StatusContext): StatusActie | null {
  return beschikbareStatusActies(ctx).find((a) => a.soort === 'annulatie') ?? null
}

/**
 * De taak staat stil tot iemand mét goedkeuringsrecht ze oppakt: dat is een
 * mededeling, geen doodlopende keuzelijst.
 */
export function wachtOpGoedkeurder(ctx: StatusContext): boolean {
  return ctx.status === 'wacht_op_goedkeuring' && !ctx.magGoedkeuren
}

/**
 * De keten waarin het kantoor een taak afwerkt, één stap per klik:
 *   service (geen goedkeuring): open → in uitvoering → afgerond
 *   wettelijk: open → in uitvoering → wacht op goedkeuring → afgerond
 * Wacht op klant is een zijstap, geen ketenstap: daaruit is "de klant
 * antwoordde" (in uitvoering) de logische voortzetting.
 */
const KETEN: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['in_uitvoering'],
  in_uitvoering: ['wacht_op_goedkeuring', 'ingediend_afgerond'],
  wacht_op_klant: ['in_uitvoering'],
  wacht_op_goedkeuring: ['ingediend_afgerond'],
  ingediend_afgerond: [],
  geannuleerd: [],
}

/**
 * De volgende stap voor de doorklikbare statusbadge, of `null` wanneer er
 * voor deze medewerker geen stap is (afgesloten taak, of wachten op een
 * goedkeurder). Bewust altijd één statuswijziging: doorklikken moet
 * voorspelbaar zijn, dus geen verborgen dubbelsprong.
 */
export function volgendeStatusActie(ctx: StatusContext): StatusActie | null {
  for (const doel of KETEN[ctx.status]) {
    if (overgangToegestaan(ctx.status, doel, ctx)) return enkeleStap(ctx.status, doel)
  }
  return null
}

/**
 * Een actie die halverwege stukliep. De eerste stap(pen) zijn wél
 * doorgevoerd: de taak staat op `bereikt`. Dat is een zichtbare, herstelbare
 * toestand — maar dan moet de melding dat ook zeggen in plaats van te doen
 * alsof er niets veranderde.
 */
export class StatusActieOnderbroken extends Error {
  constructor(
    readonly bereikt: TaskStatus,
    readonly mislukt: TaskStatus,
    readonly oorzaak: unknown
  ) {
    super(`Statusactie onderbroken na ${bereikt}, ${mislukt} is mislukt`)
    this.name = 'StatusActieOnderbroken'
  }
}

/**
 * Voert de stappen van een actie na elkaar uit. Stopt bij de eerste fout en
 * geeft die door; faalt er een latere stap, dan komt er een
 * `StatusActieOnderbroken` uit die de bereikte tussentoestand meedraagt.
 */
export async function voerStatusActieUit(
  taskId: string,
  actie: StatusActie,
  zetStatus: (taskId: string, status: TaskStatus) => Promise<void>
): Promise<void> {
  for (let i = 0; i < actie.stappen.length; i++) {
    const stap = actie.stappen[i]
    try {
      await zetStatus(taskId, stap)
    } catch (err) {
      if (i === 0) throw err
      throw new StatusActieOnderbroken(actie.stappen[i - 1], stap, err)
    }
  }
}

/** Vertaalt de fout van `voerStatusActieUit` naar een melding voor het scherm. */
export function statusActieFoutmelding(err: unknown, standaard = 'Statuswijziging is mislukt'): string {
  if (err instanceof StatusActieOnderbroken) {
    return reportError(
      err.oorzaak,
      `De taak staat nu op "${STATUS_LABEL[err.bereikt]}", maar de stap naar "${STATUS_LABEL[err.mislukt]}" is mislukt. ` +
        `Ze blijft op "${STATUS_LABEL[err.bereikt]}" staan`
    )
  }
  return reportError(err, standaard)
}
