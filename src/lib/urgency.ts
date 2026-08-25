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
 * Compliance-critical ("wettelijk") obligations get stricter, earlier
 * urgency bands than service work (docs/PLAN.md §4 point 5): the same
 * "5 days left" is merely "binnenkort" for a service report but already
 * "deze_week" for a statutory deadline.
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

/** Lower = more urgent, for sorting a task list "te laat eerst" (§4.2). */
const URGENCY_SORT_WEIGHT: Record<Exclude<UrgencyBand, null>, number> = {
  te_laat: 0,
  vandaag: 1,
  deze_week: 2,
  binnenkort: 3,
  later: 4,
}

export function urgencySortWeight(band: UrgencyBand): number {
  return band === null ? 5 : URGENCY_SORT_WEIGHT[band]
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
