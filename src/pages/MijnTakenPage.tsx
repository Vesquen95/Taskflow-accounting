import { useEffect, useState } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { TaskTable } from '../components/TaskTable'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ErrorState } from '../components/ErrorState'
import type { TaskInstanceWithRelations } from '../types'

/** Mijn taken (§4 point 1): a personal, cross-client worklist sorted on
 * urgency — this is just useTaskInstances scoped to "toegewezen aan mij". */
export function MijnTakenPage() {
  const { employee } = useCurrentEmployee()
  const { employees } = useEmployees()
  const { tasks, loading, error, filters, setFilters, reload, updateStatus, reassign, markReviewHandled } = useTaskInstances({})
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  useEffect(() => {
    if (employee) setFilters((f) => ({ ...f, toegewezenAan: employee.id }))
  }, [employee, setFilters])

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Mijn taken</h1>
        <p className="text-sm text-slate-500">Jouw openstaande taken, over alle klanten heen — te laat eerst.</p>
      </div>

      <label className="mb-4 flex items-center gap-1.5 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={!!filters.overdueOnly}
          onChange={(e) => setFilters((f) => ({ ...f, overdueOnly: e.target.checked }))}
        />
        Alleen te laat
      </label>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : (
        <TaskTable tasks={tasks} employees={employees} onOpenTask={setOpenTask} />
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
