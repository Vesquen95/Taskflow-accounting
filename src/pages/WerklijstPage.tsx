import { useState } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { TaskTable } from '../components/TaskTable'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ErrorState } from '../components/ErrorState'
import { STATUS_LABEL } from '../lib/taskStatus'
import type { TaskInstanceWithRelations, TaskStatus } from '../types'

const STATUS_OPTIONS: TaskStatus[] = ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']

export function WerklijstPage() {
  const { employee } = useCurrentEmployee()
  const { employees } = useEmployees()
  const { tasks, loading, error, filters, setFilters, reload, updateStatus, reassign, bulkReassign, bulkUpdateStatus, markReviewHandled } =
    useTaskInstances({})
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Werklijst</h1>
          <p className="text-sm text-slate-500">Alle openstaande taken, kantoorbreed — te laat eerst.</p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Zoeken</label>
          <input
            type="text"
            placeholder="Klant, verplichting…"
            value={filters.zoekterm ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, zoekterm: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Status</label>
          <select
            value={filters.status?.[0] ?? 'alle'}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value === 'alle' ? undefined : [e.target.value as TaskStatus] }))
            }
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="alle">Alle actieve statussen</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Medewerker</label>
          <select
            value={filters.toegewezenAan ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, toegewezenAan: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="alle">Alle medewerkers</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={!!filters.overdueOnly}
            onChange={(e) => setFilters((f) => ({ ...f, overdueOnly: e.target.checked }))}
          />
          Alleen te laat
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={!!filters.reviewVereist}
            onChange={(e) => setFilters((f) => ({ ...f, reviewVereist: e.target.checked }))}
          />
          Alleen review vereist
        </label>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : (
        <TaskTable
          tasks={tasks}
          employees={employees}
          onOpenTask={setOpenTask}
          onBulkReassign={bulkReassign}
          onBulkStatus={bulkUpdateStatus}
          currentEmployee={employee}
          onStatusChange={updateStatus}
        />
      )}

      {openTask && (
        <TaskDetailModal
          task={openTask}
          employees={employees}
          onClose={() => setOpenTask(null)}
          onStatusChange={updateStatus}
          onReassign={reassign}
          onMarkReviewHandled={markReviewHandled}
        />
      )}
    </div>
  )
}
