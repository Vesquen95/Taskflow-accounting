import type { MouseEvent } from 'react'
import type { TaskStatus } from '../types'
import { STATUS_LABEL } from '../lib/taskStatus'

/**
 * "Open" is de standaardstatus en stond op bijna elke regel even luid als de
 * uitzonderingen. Hij mag niet verdwijnen — hij is juist het ding waarop je
 * klikt om vooruit te gaan — maar hij is nu rustig: geen gevulde chip, wel
 * leesbaar. Wat afwijkt van de standaard blijft opvallen.
 */
const STATUS_CLASSES: Record<TaskStatus, string> = {
  open: 'bg-white text-slate-500 border-slate-200',
  in_uitvoering: 'bg-blue-100 text-blue-700 border-blue-300',
  wacht_op_klant: 'bg-purple-100 text-purple-700 border-purple-300',
  wacht_op_goedkeuring: 'bg-amber-100 text-amber-800 border-amber-300',
  ingediend_afgerond: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  geannuleerd: 'bg-slate-100 text-slate-400 border-slate-200 line-through',
}

const BASIS = 'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium'

interface StatusBadgeProps {
  status: TaskStatus
  /**
   * Aanwezig = de badge is een knop naar de volgende stap. Zonder onClick
   * blijft het een gewoon label (het gedrag overal waar niet doorgeklikt
   * kan worden).
   */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  title?: string
  /** Voor de knopvariant: benoemt de volgende stap, niet enkel de status. */
  ariaLabel?: string
}

export function StatusBadge({ status, onClick, disabled, title, ariaLabel }: StatusBadgeProps) {
  const classes = `${BASIS} ${STATUS_CLASSES[status]}`

  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {STATUS_LABEL[status]}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`${classes} cursor-pointer transition hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 disabled:opacity-50`}
    >
      {STATUS_LABEL[status]}
    </button>
  )
}
