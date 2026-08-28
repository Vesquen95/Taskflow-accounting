import { useMemo, useState } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { TaskTable } from '../components/TaskTable'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ErrorState } from '../components/ErrorState'
import { getUrgencyBand, urgencySortWeight } from '../lib/urgency'
import type { TaskInstanceWithRelations } from '../types'

/** Escalatie-/overdue-queue (§4 point 5): te laat of dicht bij de deadline,
 * op ernst gesorteerd. Wettelijke verplichtingen krijgen strengere/eerdere
 * urgentiebanden dan service-rapportering (zie src/lib/urgency.ts), dus
 * die komen hier vanzelf eerder binnen dan service-werk met dezelfde
 * kalenderafstand tot de deadline. */
export function EscalatiePage() {
  const { employee } = useCurrentEmployee()
  const { employees } = useEmployees()
  const { tasks, loading, error, reload, updateStatus, reassign, bulkReassign, bulkUpdateStatus, markReviewHandled } =
    useTaskInstances({})
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  const escalated = useMemo(() => {
    return tasks
      .map((t) => ({ task: t, band: getUrgencyBand(t.due_date, t.status, t.obligation_type?.categorie) }))
      .filter((x) => x.band === 'te_laat' || x.band === 'vandaag' || x.band === 'deze_week')
      .sort((a, b) => urgencySortWeight(a.band) - urgencySortWeight(b.band) || a.task.due_date.localeCompare(b.task.due_date))
      .map((x) => x.task)
  }, [tasks])

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Escalatie-queue</h1>
        <p className="text-sm text-slate-500">
          Taken die te laat zijn of op korte termijn vervallen zonder dat ze al zijn ingediend/afgerond. Wettelijke
          verplichtingen escaleren vroeger dan service-werk.
        </p>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : (
        <TaskTable
          tasks={escalated}
          employees={employees}
          onOpenTask={setOpenTask}
          onBulkReassign={bulkReassign}
          onBulkStatus={bulkUpdateStatus}
          currentEmployee={employee}
          onStatusChange={updateStatus}
          emptyMessage="Geen escalaties — alles onder controle."
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
