import type { Employee, TaskInstanceWithRelations, TaskStatus } from '../types'
import type { BulkResultaat } from '../lib/bulkActie'
import { TaskTable } from './TaskTable'
import { EmptyState } from './EmptyState'
import { groepeerInBlokken } from '../lib/werkstromen'

interface TaskBlocksProps {
  tasks: TaskInstanceWithRelations[]
  employees: Employee[]
  onOpenTask: (task: TaskInstanceWithRelations) => void
  /** Doorgegeven aan TaskTable; geven een verslag per taak terug (src/lib/bulkActie.ts). */
  onBulkReassign?: (taskIds: string[], employeeId: string) => Promise<BulkResultaat>
  onBulkStatus?: (taskIds: string[], status: TaskStatus) => Promise<BulkResultaat>
  /** Doorgegeven aan TaskTable: samen maken deze twee de status doorklikbaar
   *  naar de volgende stap. Zonder de medewerker weet het scherm niet wie er
   *  mag goedkeuren, en blijft de status een label. */
  currentEmployee?: Employee | null
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>
  emptyMessage?: string
}

/** De kop van een maandblok: "september 2026". Het jaartal moet erbij: met het
 *  venster "Alles" loopt de lijst tot 2029, en dan zijn september 2026 en
 *  september 2027 niet uit elkaar te houden. */
function blokTitel(maand: string): string {
  return new Date(`${maand}-01T00:00:00`).toLocaleDateString('nl-BE', {
    month: 'long',
    year: 'numeric',
  })
}

/**
 * De takenlijst zoals het kantoor ze afwerkt: in blokken per maand.
 *
 * "We werken taken af per takenblok, niet per klant." Eén maand, alle dossiers
 * eronder, en de bulkacties per blok — zo doe je een hele deadlinemaand in één
 * beweging in plaats van dossier per dossier.
 *
 * De blokkop noemt enkel de maand. De exacte dag herhalen in de kop maakte de
 * lijst dubbel: die staat al per regel in de kolom Deadline, waar hij hoort.
 *
 * Wat te laat is staat als één blok bovenaan, niet uitgesmeerd over losse
 * maanden: achterstand pak je als geheel aan.
 */
export function TaskBlocks({
  tasks,
  employees,
  onOpenTask,
  onBulkReassign,
  onBulkStatus,
  currentEmployee,
  onStatusChange,
  emptyMessage = 'Geen taken in dit venster.',
}: TaskBlocksProps) {
  const blokken = groepeerInBlokken(tasks)

  if (blokken.length === 0) {
    return <EmptyState title={emptyMessage} />
  }

  return (
    <div className="space-y-5">
      {blokken.map((blok) => {
        const teLaat = blok.maand === null
        return (
          <section key={blok.maand ?? 'te-laat'}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2
                className={`text-sm font-semibold ${teLaat ? 'text-red-700' : 'text-slate-800'}`}
              >
                {teLaat ? 'Te laat' : blokTitel(blok.maand!)}
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
              currentEmployee={currentEmployee}
              onStatusChange={onStatusChange}
            />
          </section>
        )
      })}
    </div>
  )
}
