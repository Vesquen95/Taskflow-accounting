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
