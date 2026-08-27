import type { Employee, TaskInstanceWithRelations, TaskStatus } from '../types'
import { TaskTable } from './TaskTable'
import { EmptyState } from './EmptyState'
import { daysUntil, formatDate } from '../lib/urgency'
import { groepeerInBlokken } from '../lib/werkstromen'

interface TaskBlocksProps {
  tasks: TaskInstanceWithRelations[]
  employees: Employee[]
  onOpenTask: (task: TaskInstanceWithRelations) => void
  onBulkReassign?: (taskIds: string[], employeeId: string) => Promise<void>
  onBulkStatus?: (taskIds: string[], status: TaskStatus) => Promise<void>
  emptyMessage?: string
}

function blokTitel(due_date: string): string {
  const dagen = daysUntil(due_date)
  if (dagen === 0) return `Vandaag — ${formatDate(due_date)}`
  if (dagen === 1) return `Morgen — ${formatDate(due_date)}`
  const weekdag = new Date(`${due_date}T00:00:00`).toLocaleDateString('nl-BE', { weekday: 'long' })
  return `${weekdag} ${formatDate(due_date)}`
}

/**
 * De takenlijst zoals het kantoor ze afwerkt: in blokken per deadline.
 *
 * "We werken taken af per takenblok, niet per klant." Eén datum, alle dossiers
 * eronder, en de bulkacties per blok — zo doe je een hele deadlinedag in één
 * beweging in plaats van dossier per dossier.
 *
 * Wat te laat is staat als één blok bovenaan, niet uitgesmeerd over losse
 * dagen: achterstand pak je als geheel aan.
 */
export function TaskBlocks({
  tasks,
  employees,
  onOpenTask,
  onBulkReassign,
  onBulkStatus,
  emptyMessage = 'Geen taken in dit venster.',
}: TaskBlocksProps) {
  const blokken = groepeerInBlokken(tasks)

  if (blokken.length === 0) {
    return <EmptyState title={emptyMessage} />
  }

  return (
    <div className="space-y-5">
      {blokken.map((blok) => {
        const teLaat = blok.due_date === null
        return (
          <section key={blok.due_date ?? 'te-laat'}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2
                className={`text-sm font-semibold ${teLaat ? 'text-red-700' : 'text-slate-800'}`}
              >
                {teLaat ? 'Te laat' : blokTitel(blok.due_date!)}
              </h2>
              <span className="text-xs text-slate-500">
                {blok.taken.length} {blok.taken.length === 1 ? 'taak' : 'taken'}
              </span>
            </div>
            <TaskTable
              tasks={blok.taken}
              employees={employees}
              onOpenTask={onOpenTask}
              onBulkReassign={onBulkReassign}
              onBulkStatus={onBulkStatus}
            />
          </section>
        )
      })}
    </div>
  )
}
