import type { Employee, TaskInstanceWithRelations, TaskStatus } from '../types'
import { TaskStatusControl } from './TaskStatusControl'
import { UrgencyBadge } from './UrgencyBadge'
import { formatDate } from '../lib/urgency'
import { taakNaam } from '../lib/taakLabel'

interface TaakKaartProps {
  task: TaskInstanceWithRelations
  onOpen: (task: TaskInstanceWithRelations) => void
  currentEmployee?: Employee | null
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>
  onStatusFout?: (melding: string | null) => void
}

/**
 * Eén taak op een telefoon.
 *
 * De tabel heeft zeven kolommen. Die passen niet op 390 pixels, en zijwaarts
 * schuiven om de deadline te zien is geen lezen maar zoeken. Daarom hier onder
 * elkaar, in de volgorde waarin je ernaar kijkt: welke klant, wat, wanneer.
 *
 * De klantnaam staat bovenaan en niet de verplichting: bij honderd dossiers is
 * "welke klant" de eerste vraag, ook op een klein scherm.
 *
 * De status staat op een eigen regel onderaan, náást de kaartknop en niet
 * erin. Dat is geen opmaakkeuze: een knop binnen een knop is ongeldige HTML,
 * en dan wordt het toeval welke van de twee een tik opvangt. Zo heeft elk van
 * de twee dingen die je hier doet -- openen en de status verzetten -- een eigen
 * vlak dat groot genoeg is voor een duim.
 */
export function TaakKaart({ task, onOpen, currentEmployee, onStatusChange, onStatusFout }: TaakKaartProps) {
  return (
    <li className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="block w-full px-4 pt-3 text-left transition active:bg-slate-50"
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
            {task.client?.vertrouwelijk && (
              <span title="Vertrouwelijke klant" aria-label="Vertrouwelijk" className="mr-1">
                🔒
              </span>
            )}
            {task.client?.naam ?? '—'}
          </span>
          <UrgencyBadge
            dueDate={task.due_date}
            status={task.status}
            categorie={task.obligation_type?.categorie}
          />
        </span>

        <span className="mt-0.5 block truncate text-sm text-slate-600">
          {taakNaam(task)}
          {task.periode_label && <span className="text-slate-400"> · {task.periode_label}</span>}
          {task.review_vereist && (
            <span className="ml-2 inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              review
            </span>
          )}
        </span>
      </button>

      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
        <span className="min-w-0 truncate text-sm text-slate-700">
          {formatDate(task.due_date)}
          {task.due_date_verschoven && (
            <span
              title="Verschoven t.o.v. de wettelijke datum door weekend of feestdag"
              className="ml-1 text-slate-400"
            >
              ↷
            </span>
          )}
          {task.toegewezen_medewerker?.naam && (
            <span className="text-slate-400"> · {task.toegewezen_medewerker.naam}</span>
          )}
        </span>
        <TaskStatusControl
          task={task}
          currentEmployee={currentEmployee}
          onStatusChange={onStatusChange}
          onError={onStatusFout}
        />
      </div>
    </li>
  )
}
