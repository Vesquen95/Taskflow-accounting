import type { ObligationCategorie, TaskStatus, UrgencyBand } from '../types'

/** Statuses that are "done" from an urgency point of view — no badge, no
 * escalation, regardless of how close/far the due date is. */
const FINAL_STATUSES: TaskStatus[] = ['ingediend_afgerond', 'geannuleerd']

function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export function daysUntil(dueDate: string, today: Date = new Date()): number {
  const start = startOfDay(today)
  const due = startOfDay(new Date(`${dueDate}T00:00:00`))
  return Math.round((due.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * Wettelijke verplichtingen krijgen strengere, vroegere urgentiebanden dan
 * service-werk (docs/PLAN.md §4): dezelfde "nog 5 dagen" is voor een
 * servicerapport nog "binnenkort", maar voor een wettelijke deadline al
 * "deze week".
 */
export function getUrgencyBand(
  dueDate: string,
  status: TaskStatus,
  categorie: ObligationCategorie | null | undefined,
  today: Date = new Date()
): UrgencyBand {
  if (FINAL_STATUSES.includes(status)) return null

  const diff = daysUntil(dueDate, today)
  const isWettelijk = categorie !== 'service'

  if (diff < 0) return 'te_laat'
  if (diff === 0) return 'vandaag'

  if (isWettelijk) {
    if (diff <= 3) return 'deze_week'
    if (diff <= 7) return 'binnenkort'
    return 'later'
  }

  if (diff <= 5) return 'deze_week'
  if (diff <= 14) return 'binnenkort'
  return 'later'
}

export const urgencyLabel: Record<Exclude<UrgencyBand, null>, string> = {
  te_laat: 'Te laat',
  vandaag: 'Vandaag',
  deze_week: 'Deze week',
  binnenkort: 'Binnenkort',
  later: 'Later',
}

export const urgencyClasses: Record<Exclude<UrgencyBand, null>, string> = {
  te_laat: 'bg-red-100 text-red-700 border-red-300',
  vandaag: 'bg-amber-100 text-amber-800 border-amber-300',
  deze_week: 'bg-orange-100 text-orange-700 border-orange-300',
  binnenkort: 'bg-blue-100 text-blue-700 border-blue-300',
  later: 'bg-slate-100 text-slate-600 border-slate-300',
}

/**
 * Banden zonder boodschap. "Later" stond op vrijwel elke regel — een badge
 * die altijd oplicht, meldt niets. De band zelf blijft wél bestaan: hij
 * bepaalt de kleur en de toon van de badges die wél iets melden. Enkel de
 * badge zwijgt, zodat die andere banden ook opvallen.
 */
const STILLE_BANDEN: readonly UrgencyBand[] = ['later']

export function bandVerdientBadge(band: UrgencyBand): band is Exclude<UrgencyBand, null> {
  return band !== null && !STILLE_BANDEN.includes(band)
}

/**
 * Aantal dagen tussen twee ISO-dagen; positief wanneer `tot` later valt.
 * Gebruikt om te tonen hoever een handmatig afgesproken deadline van de
 * wettelijke datum afwijkt.
 */
export function dagenVerschil(vanIso: string, totIso: string): number {
  const van = startOfDay(new Date(`${vanIso}T00:00:00`))
  const tot = startOfDay(new Date(`${totIso}T00:00:00`))
  return Math.round((tot.getTime() - van.getTime()) / (1000 * 60 * 60 * 24))
}

export function formatDate(date: string | null): string {
  if (!date) return ''
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(datetime: string | null): string {
  if (!datetime) return ''
  const d = new Date(datetime)
  return d.toLocaleString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Hoelang een taak al op de klant wacht, in woorden.
 *
 * "Wacht op klant" is de enige status waarin het kantoor zelf niets kan doen,
 * en dus de status waarin werk het langst blijft liggen. Op het scherm zagen
 * alle wachtende taken er identiek uit: hetzelfde paarse bolletje, of het nu
 * twee dagen of vier maanden was. Het ene is geduld, het andere is bellen.
 *
 * De eenheid schuift mee met de duur, want "97 dagen" laat je zelf rekenen:
 * dagen tot twee weken, dan weken, en vanaf ruim twee maanden in maanden.
 */
export function wachtDuur(sinds: string | null | undefined, nu: Date = new Date()): string | null {
  if (!sinds) return null
  const begin = startOfDay(new Date(sinds))
  const dagen = Math.round((startOfDay(nu).getTime() - begin.getTime()) / (1000 * 60 * 60 * 24))
  // Een stempel uit de toekomst is onmogelijk maar niet ondenkbaar (een
  // klok die verspringt). Dan liever "vandaag" dan een negatief getal.
  if (dagen <= 0) return 'sinds vandaag'
  if (dagen === 1) return '1 dag'
  if (dagen < 14) return `${dagen} dagen`
  if (dagen < 70) {
    const weken = Math.round(dagen / 7)
    return `${weken} weken`
  }
  const maanden = Math.round(dagen / 30.4)
  return `${maanden} maanden`
}

/**
 * Vanaf wanneer een wachtend dossier aandacht verdient.
 *
 * Drie weken: korter dan dat is een klant die gewoon nog bezig is, langer
 * betekent dat de vraag waarschijnlijk ergens is blijven liggen. Bewust één
 * grens en geen reeks kleuren -- de status zelf zegt al dat er gewacht wordt.
 */
export const WACHT_LANG_VANAF_DAGEN = 21

export function wachtTeLang(sinds: string | null | undefined, nu: Date = new Date()): boolean {
  if (!sinds) return false
  const begin = startOfDay(new Date(sinds))
  const dagen = Math.round((startOfDay(nu).getTime() - begin.getTime()) / (1000 * 60 * 60 * 24))
  return dagen >= WACHT_LANG_VANAF_DAGEN
}
