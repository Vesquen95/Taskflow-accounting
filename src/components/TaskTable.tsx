import { useMemo, useState } from 'react'
import type { Employee, TaskInstanceWithRelations, TaskStatus } from '../types'
import { StatusBadge } from './StatusBadge'
import { UrgencyBadge } from './UrgencyBadge'
import { formatDate } from '../lib/urgency'
import { EmptyState } from './EmptyState'

interface TaskTableProps {
  tasks: TaskInstanceWithRelations[]
  employees: Employee[]
  onOpenTask: (task: TaskInstanceWithRelations) => void
  onBulkReassign?: (taskIds: string[], employeeId: string) => Promise<void>
  onBulkStatus?: (taskIds: string[], status: TaskStatus) => Promise<void>
  showClientColumn?: boolean
  emptyMessage?: string
}

const BULK_STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'in_uitvoering', label: 'In uitvoering' },
  { value: 'wacht_op_klant', label: 'Wacht op klant' },
  { value: 'geannuleerd', label: 'Geannuleerd' },
]

export function TaskTable({
  tasks,
  employees,
  onOpenTask,
  onBulkReassign,
  onBulkStatus,
  showClientColumn = true,
  emptyMessage = 'Geen taken gevonden voor deze filters.',
}: TaskTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const allSelected = tasks.length > 0 && selected.size === tasks.length
  const canBulk = !!(onBulkReassign || onBulkStatus)

  const selectedIds = useMemo(() => Array.from(selected), [selected])

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(tasks.map((t) => t.id)))
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (tasks.length === 0) {
    return <EmptyState title={emptyMessage} />
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      {canBulk && selected.size > 0 && (
        <div className="flex items-center gap-3 border-b border-slate-200 bg-brand-50 px-4 py-2 text-sm">
          <span className="font-medium text-brand-800">{selected.size} geselecteerd</span>
          {onBulkReassign && (
            <label className="flex items-center gap-1 text-slate-600">
              Herverdeel naar
              <select
                className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                defaultValue=""
                onChange={async (e) => {
                  const value = e.target.value
                  if (!value) return
                  await onBulkReassign(selectedIds, value)
                  setSelected(new Set())
                  e.target.value = ''
                }}
              >
                <option value="" disabled>
                  Kies medewerker…
                </option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.naam}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onBulkStatus && (
            <label className="flex items-center gap-1 text-slate-600">
              Zet status op
              <select
                className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                defaultValue=""
                onChange={async (e) => {
                  const value = e.target.value as TaskStatus | ''
                  if (!value) return
                  await onBulkStatus(selectedIds, value)
                  setSelected(new Set())
                  e.target.value = ''
                }}
              >
                <option value="" disabled>
                  Kies status…
                </option>
                {BULK_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            {canBulk && (
              <th className="w-8 px-3 py-2">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Selecteer alle taken" />
              </th>
            )}
            {showClientColumn && <th className="px-3 py-2">Klant</th>}
            <th className="px-3 py-2">Verplichting</th>
            <th className="px-3 py-2">Periode</th>
            <th className="px-3 py-2">Deadline</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Verantwoordelijke</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {tasks.map((task) => (
            <tr
              key={task.id}
              className="cursor-pointer hover:bg-slate-50"
              onClick={() => onOpenTask(task)}
            >
              {canBulk && (
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(task.id)}
                    onChange={() => toggleOne(task.id)}
                    aria-label={`Selecteer taak ${task.title ?? task.obligation_type?.naam ?? ''}`}
                  />
                </td>
              )}
              {showClientColumn && (
                <td className="max-w-[180px] truncate px-3 py-2 font-medium text-slate-800">
                  {task.client?.vertrouwelijk && (
                    <span title="Vertrouwelijke klant" className="mr-1" aria-label="Vertrouwelijk">
                      🔒
                    </span>
                  )}
                  {task.client?.naam ?? '—'}
                </td>
              )}
              <td className="max-w-[220px] truncate px-3 py-2 text-slate-700">
                {task.obligation_type?.naam ?? task.title ?? 'Ad-hoc taak'}
                {task.review_vereist && (
                  <span className="ml-2 inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                    review
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-slate-500">{task.periode_label ?? '—'}</td>
              <td className="whitespace-nowrap px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-slate-700">{formatDate(task.due_date)}</span>
                  <UrgencyBadge dueDate={task.due_date} status={task.status} categorie={task.obligation_type?.categorie} />
                  {task.due_date_verschoven && (
                    <span title="Verschoven t.o.v. de wettelijke datum door weekend/feestdag" className="text-slate-400">
                      ↷
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={task.status} />
              </td>
              <td className="max-w-[160px] truncate px-3 py-2 text-slate-600">{task.toegewezen_medewerker?.naam ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
