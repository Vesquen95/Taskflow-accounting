import { useMemo, useState } from 'react'
import type { Employee, TaskInstanceWithRelations, TaskStatus } from '../types'
import type { BulkResultaat } from '../lib/bulkActie'
import { TaskStatusControl } from './TaskStatusControl'
import { TaskBulkBar } from './TaskBulkBar'
import { UrgencyBadge } from './UrgencyBadge'
import { formatDate } from '../lib/urgency'
import { taakNaam } from '../lib/taakLabel'
import { EmptyState } from './EmptyState'
import { TaakKaart } from './TaakKaart'
import { useKleinScherm } from '../hooks/useKleinScherm'

interface TaskTableProps {
  tasks: TaskInstanceWithRelations[]
  employees: Employee[]
  onOpenTask: (task: TaskInstanceWithRelations) => void
  /** Bulkacties geven een verslag per taak terug i.p.v. te gooien — zie src/lib/bulkActie.ts. */
  onBulkReassign?: (taskIds: string[], employeeId: string) => Promise<BulkResultaat>
  onBulkStatus?: (taskIds: string[], status: TaskStatus) => Promise<BulkResultaat>
  /**
   * De ingelogde medewerker. Nodig om te weten welke statusstap deze persoon
   * mag zetten (`mag_goedkeuren`); zonder haar blijft de status een label.
   */
  currentEmployee?: Employee | null
  /** Aanwezig = de status is doorklikbaar naar de volgende stap. */
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>
  showClientColumn?: boolean
}

export function TaskTable({
  tasks,
  employees,
  onOpenTask,
  onBulkReassign,
  onBulkStatus,
  currentEmployee,
  onStatusChange,
  showClientColumn = true,
}: TaskTableProps) {
  // Eén grens voor de hele app (zie src/hooks/useKleinScherm.ts). Op de hook
  // schakelen en niet op CSS-klassen: met `hidden md:block` staan beide
  // varianten tegelijk in de DOM, en dan leest een schermlezer elke taak twee
  // keer en bestaan er twee knoppen voor dezelfde status.
  const kleinScherm = useKleinScherm()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [statusFout, setStatusFout] = useState<string | null>(null)
  // Op de zichtbare rijen, niet op de omvang van de set: na een bulkactie kan
  // een aangevinkte taak uit de lijst verdwenen zijn (ze voldoet niet meer
  // aan de filters), en dan zou een vergelijking op aantal liegen.
  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id))
  const canBulk = !!(onBulkReassign || onBulkStatus)

  // In lijstvolgorde, niet in aanvinkvolgorde: het verslag leest zo mee met
  // de tabel eronder.
  const selectedTasks = useMemo(() => tasks.filter((t) => selected.has(t.id)), [tasks, selected])

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

  // Vangnet. In de app komt het niet voor: TaskBlocks is de enige die deze
  // tabel gebruikt en rendert alleen blokken die taken bevatten — de lege
  // stand hoort daar, per venster, met een tekst die de werkstroom noemt.
  if (tasks.length === 0) {
    return <EmptyState title="Geen taken gevonden voor deze filters." />
  }

  // Op een telefoon: een kaart per taak. Zeven kolommen passen niet op 390
  // pixels, en zijwaarts schuiven om de deadline te zien is geen lezen maar
  // zoeken. Aanvinken en bulkacties staan hier bewust niet -- dat is
  // bureauwerk, en het kantoor vroeg voor onderweg alleen opzoeken en de
  // status verzetten.
  if (kleinScherm) {
    return (
      <>
        {statusFout && (
          <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {statusFout}
          </p>
        )}
        <ul className="space-y-2">
          {tasks.map((task) => (
            <TaakKaart
              key={task.id}
              task={task}
              onOpen={onOpenTask}
              currentEmployee={currentEmployee}
              onStatusChange={onStatusChange}
              onStatusFout={setStatusFout}
            />
          ))}
        </ul>
      </>
    )
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      {statusFout && (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {statusFout}
        </p>
      )}
      {canBulk && (
        <TaskBulkBar
          geselecteerd={selectedTasks}
          employees={employees}
          currentEmployee={currentEmployee}
          onBulkReassign={onBulkReassign}
          onBulkStatus={onBulkStatus}
          onNaActie={(nogGeselecteerd) => setSelected(new Set(nogGeselecteerd))}
        />
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
                {taakNaam(task)}
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
                <TaskStatusControl
                  task={task}
                  currentEmployee={currentEmployee}
                  onStatusChange={onStatusChange}
                  onError={setStatusFout}
                />
              </td>
              <td className="max-w-[160px] truncate px-3 py-2 text-slate-600">
                {task.toegewezen_medewerker?.naam ?? (
                  // Geen streepje: niemand op een taak is geen ontbrekend
                  // gegeven maar een toestand waar iemand iets mee moet doen.
                  <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                    Nog niemand
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  )
}
