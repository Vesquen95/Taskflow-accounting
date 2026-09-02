import { useState } from 'react'
import type { MouseEvent } from 'react'
import type { Employee, TaskInstance, TaskStatus } from '../types'
import { StatusBadge } from './StatusBadge'
import {
  CHECKLIST_HERINNERING,
  gaatLangsGoedkeuring,
  STATUS_LABEL,
  statusActieFoutmelding,
  statusContext,
  voerStatusActieUit,
  volgendeStatusActie,
  wachtOpGoedkeurder,
  WACHT_OP_GOEDKEURDER_KORT,
} from '../lib/taskStatus'
import { Modal } from './Modal'

interface TaskStatusControlProps {
  task: Pick<TaskInstance, 'id' | 'status' | 'vereist_goedkeuring'>
  /** De ingelogde medewerker: zijn `mag_goedkeuren` bepaalt mee wat mag. */
  currentEmployee?: Pick<Employee, 'mag_goedkeuren'> | null
  /** Zonder handler blijft de status een gewoon label. */
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>
  onError?: (melding: string | null) => void
}

/**
 * De status als bedieningselement: één klik zet de taak naar de volgende
 * stap in haar keten. Welke stap dat is (en of er er wel één is) komt uit
 * src/lib/taskStatus.ts, dezelfde bron als het detailvenster — dus nooit een
 * klik die de databank weigert.
 *
 * Staat de taak op "wacht op goedkeuring" en heeft deze medewerker geen
 * goedkeuringsrecht, dan is de badge geen knop maar een mededeling: er is
 * voor hem of haar niets te doen tot een goedkeurder ze oppakt.
 */
export function TaskStatusControl({ task, currentEmployee, onStatusChange, onError }: TaskStatusControlProps) {
  const [busy, setBusy] = useState(false)
  // Alleen gezet wanneer de stap langs goedkeuring gaat; dan komt er eerst een
  // bevestiging met de checklistherinnering.
  const [bevestigen, setBevestigen] = useState(false)
  const ctx = statusContext(task, currentEmployee)
  const actie = onStatusChange ? volgendeStatusActie(ctx) : null

  if (!actie) {
    return (
      <StatusBadge
        status={task.status}
        title={wachtOpGoedkeurder(ctx) ? WACHT_OP_GOEDKEURDER_KORT : undefined}
      />
    )
  }

  async function voerUit() {
    if (!onStatusChange || !actie) return
    setBusy(true)
    onError?.(null)
    try {
      await voerStatusActieUit(task.id, actie, onStatusChange)
    } catch (err) {
      onError?.(statusActieFoutmelding(err))
    } finally {
      setBusy(false)
      setBevestigen(false)
    }
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // De rij zelf opent het detailvenster; de statusknop doet dat niet mee.
    event.stopPropagation()
    if (!actie) return
    // Eén extra klik, en enkel op de stap waar het dossier uit handen gaat.
    // De andere overgangen blijven wat ze waren: één klik.
    if (gaatLangsGoedkeuring(actie)) {
      setBevestigen(true)
      return
    }
    void voerUit()
  }

  return (
    <>
      <StatusBadge
        status={task.status}
        onClick={handleClick}
        disabled={busy}
        title={`Volgende stap: ${actie.label}`}
        ariaLabel={`Status ${STATUS_LABEL[task.status]} — volgende stap: ${actie.label}`}
      />
      {bevestigen && (
        <span onClick={(e) => e.stopPropagation()} role="presentation">
          <Modal
            title={actie.label}
            onClose={() => setBevestigen(false)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setBevestigen(false)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void voerUit()}
                  className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {actie.label}
                </button>
              </>
            }
          >
            <p className="text-sm text-slate-700">{CHECKLIST_HERINNERING}</p>
          </Modal>
        </span>
      )}
    </>
  )
}
