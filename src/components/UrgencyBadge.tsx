import type { ObligationCategorie, TaskStatus } from '../types'
import { getUrgencyBand, urgencyClasses, urgencyLabel } from '../lib/urgency'

export function UrgencyBadge({
  dueDate,
  status,
  categorie,
}: {
  dueDate: string
  status: TaskStatus
  categorie: ObligationCategorie | null | undefined
}) {
  const band = getUrgencyBand(dueDate, status, categorie)
  if (!band) return null
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${urgencyClasses[band]}`}>
      {urgencyLabel[band]}
    </span>
  )
}
