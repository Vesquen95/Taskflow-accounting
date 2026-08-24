import type { DueStatus } from '../types'

function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export function getDueStatus(dueDate: string | null): DueStatus {
  if (!dueDate) return null
  const today = startOfDay(new Date())
  const due = startOfDay(new Date(`${dueDate}T00:00:00`))
  const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return 'overdue'
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  return 'upcoming'
}

export function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return ''
  const due = new Date(`${dueDate}T00:00:00`)
  return due.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

export const dueStatusLabel: Record<Exclude<DueStatus, null>, string> = {
  overdue: 'Te laat',
  today: 'Vandaag',
  tomorrow: 'Morgen',
  upcoming: 'Gepland',
}

export const dueStatusClasses: Record<Exclude<DueStatus, null>, string> = {
  overdue: 'bg-red-100 text-red-700 border-red-300',
  today: 'bg-amber-100 text-amber-800 border-amber-300',
  tomorrow: 'bg-blue-100 text-blue-700 border-blue-300',
  upcoming: 'bg-slate-100 text-slate-600 border-slate-300',
}
