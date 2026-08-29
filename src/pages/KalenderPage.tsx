import { useMemo, useState } from 'react'
import { useTaskInstances } from '../hooks/useTaskInstances'
import { useEmployees } from '../hooks/useEmployees'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { StatusBadge } from '../components/StatusBadge'
import { UrgencyBadge } from '../components/UrgencyBadge'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { formatDate } from '../lib/urgency'
import type { TaskInstanceWithRelations } from '../types'

/**
 * Kalender-/tijdlijnweergave (§4 point 4), sinds augustus 2026 het
 * hoofdscherm: dit is waar je binnenkomt.
 *
 * Bewust een lijst per maand en geen volledig maand-/weekraster — die keuze
 * uit v1 blijft staan: ze beantwoordt "hoeveel deadlines stapelen zich in
 * welke maand op, en bij wie" zonder de complexiteit van een kalenderraster.
 *
 * De status is hier een **label** en geen knop (docs/PLAN.md §4, beslist met
 * het kantoor). Dat verandert niet nu dit het eerste scherm is: je kijkt hier
 * naar de spreiding van deadlines, je werkt ze af in de werkstromen. Wie hier
 * toch iets wil wijzigen, opent de taak.
 */
export function KalenderPage() {
  const { employees } = useEmployees()
  const { tasks, loading, error, filters, setFilters, reload, updateStatus, reassign, markReviewHandled } = useTaskInstances({})
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<string, TaskInstanceWithRelations[]>()
    for (const t of tasks) {
      const key = t.due_date.slice(0, 7) // YYYY-MM
      const list = map.get(key) ?? []
      list.push(t)
      map.set(key, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [tasks])

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Kalender</h1>
          <p className="text-sm text-slate-500">Deadline-dichtheid per maand, kantoorbreed of per medewerker.</p>
        </div>
        <select
          aria-label="Medewerker"
          value={filters.toegewezenAan ?? 'alle'}
          onChange={(e) => setFilters((f) => ({ ...f, toegewezenAan: e.target.value }))}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="alle">Kantoorbreed</option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.naam}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        // Leesbaar en aankondigbaar: "Laden" mag niet op "je bent klaar"
        // lijken, en een schermlezer hoort het mee te krijgen.
        <p role="status" className="text-sm text-slate-600">
          Taken laden…
        </p>
      ) : grouped.length === 0 ? (
        // Vroeger "Geen taken binnen bereik" — maar er is op dit scherm geen
        // bereik te zien dat je kan verruimen. Als eerste scherm na het
        // inloggen moet de lege stand zeggen wat ze betekent en waar het werk
        // dan wél staat.
        <EmptyState
          title={
            filters.toegewezenAan && filters.toegewezenAan !== 'alle'
              ? 'Geen openstaande taken voor deze medewerker.'
              : 'Geen openstaande taken.'
          }
          description="Afgewerkte en geannuleerde taken staan niet in de kalender; die vind je in het klantdossier."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map(([month, monthTasks]) => (
            <div key={month} className="rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
                <h2 className="text-sm font-semibold text-slate-800">
                  {new Date(`${month}-01T00:00:00`).toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' })}
                </h2>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                  {monthTasks.length} taken
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {monthTasks.map((t) => (
                  <li key={t.id} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-slate-50" onClick={() => setOpenTask(t)}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-16 shrink-0 text-slate-400">{formatDate(t.due_date)}</span>
                      <span className="truncate font-medium text-slate-800">{t.client?.naam}</span>
                      <span className="truncate text-slate-500">{t.obligation_type?.naam ?? t.title}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <UrgencyBadge dueDate={t.due_date} status={t.status} categorie={t.obligation_type?.categorie} />
                      <StatusBadge status={t.status} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
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
