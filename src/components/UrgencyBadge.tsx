import type { ObligationCategorie, TaskStatus } from '../types'
import { bandVerdientBadge, getUrgencyBand, urgencyClasses, urgencyLabel } from '../lib/urgency'

/**
 * Toont de urgentieband — maar alleen wanneer die iets te melden heeft.
 * "Later" (en een taak in een eindstatus) levert geen badge op: een label
 * dat op elke regel staat, draagt geen informatie en verdringt de banden
 * die wél aandacht vragen.
 */
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
  if (!bandVerdientBadge(band)) return null
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${urgencyClasses[band]}`}>
      {urgencyLabel[band]}
    </span>
  )
}
