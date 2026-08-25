import type { TaskStatus } from '../types'

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Open',
  in_uitvoering: 'In uitvoering',
  wacht_op_klant: 'Wacht op klant',
  wacht_op_goedkeuring: 'Wacht op goedkeuring',
  ingediend_afgerond: 'Ingediend/afgerond',
  geannuleerd: 'Geannuleerd',
}

const STATUS_CLASSES: Record<TaskStatus, string> = {
  open: 'bg-slate-100 text-slate-700 border-slate-300',
  in_uitvoering: 'bg-blue-100 text-blue-700 border-blue-300',
  wacht_op_klant: 'bg-purple-100 text-purple-700 border-purple-300',
  wacht_op_goedkeuring: 'bg-amber-100 text-amber-800 border-amber-300',
  ingediend_afgerond: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  geannuleerd: 'bg-slate-100 text-slate-400 border-slate-200 line-through',
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}
