import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { StatusBadge } from './StatusBadge'
import { UrgencyBadge } from './UrgencyBadge'
import { formatDate, formatDateTime } from '../lib/urgency'
import { supabase } from '../lib/supabase'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import type { Employee, TaskInstanceWithRelations, TaskStatus, TaskStatusLog } from '../types'
import { reportError } from '../lib/errorMessage'
import {
  annulatieActie,
  STATUS_LABEL,
  statusActieFoutmelding,
  statusContext,
  voerStatusActieUit,
  voortgangsActies,
  wachtOpGoedkeurder,
  WACHT_OP_GOEDKEURDER_UITLEG,
  type StatusActie,
} from '../lib/taskStatus'

interface TaskDetailModalProps {
  task: TaskInstanceWithRelations
  employees: Employee[]
  onClose: () => void
  onStatusChange: (taskId: string, status: TaskStatus) => Promise<void>
  onReassign: (taskId: string, employeeId: string) => Promise<void>
  onMarkReviewHandled: (taskId: string) => Promise<void>
}

const EVENT_LABEL: Record<string, string> = {
  status_wijziging: 'Statuswijziging',
  due_date_herberekend: 'Deadline herberekend',
  toewijzing_gewijzigd: 'Herverdeeld',
  review_gemarkeerd: 'Gemarkeerd voor review',
  review_afgehandeld: 'Review afgehandeld',
  goedkeuring_gegeven: 'Goedgekeurd',
  goedkeuring_geweigerd: 'Goedkeuring geweigerd',
  taak_aangemaakt: 'Taak aangemaakt',
  taak_inhoud_gewijzigd: 'Inhoud gewijzigd',
}

const TRIGGER_BRON_LABEL: Record<string, string> = {
  medewerker_actie: 'door een medewerker',
  kalender_herberekening: 'door de wettelijke kalender',
  av_opvolging_automatisch: 'door de AV-opvolging',
}

/** De historiek toont wie iets deed, niet alleen wat er gebeurde. */
type TaskStatusLogWithActor = TaskStatusLog & {
  actor: Pick<Employee, 'id' | 'naam'> | null
}

export function TaskDetailModal({
  task,
  employees,
  onClose,
  onStatusChange,
  onReassign,
  onMarkReviewHandled,
}: TaskDetailModalProps) {
  const { employee } = useCurrentEmployee()
  const [log, setLog] = useState<TaskStatusLogWithActor[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reassignTo, setReassignTo] = useState(task.toegewezen_medewerker_id)

  useEffect(() => {
    let active = true
    setLogLoading(true)
    supabase
      .from('task_status_log')
      // De actor en de notitie horen erbij: zonder wie en waarom beantwoordt
      // het audittrail niet de vraag waarvoor het bestaat.
      .select('*, actor:employees!task_status_log_actor_employee_id_fkey(id,naam)')
      .eq('task_instance_id', task.id)
      .order('created_at', { ascending: false })
      .then(({ data, error: err }) => {
        if (!active) return
        if (!err) setLog((data ?? []) as TaskStatusLogWithActor[])
        setLogLoading(false)
      })
    return () => {
      active = false
    }
  }, [task.id])

  // Welke stappen mogen, komt uit src/lib/taskStatus.ts — dezelfde bron als
  // de doorklikbare status in de takenlijst, en een getrouwe spiegel van
  // enforce_task_instance_transition (migratie 0011). De databank blijft de
  // handhaving; dit scherm belooft alleen niets wat zij zou weigeren.
  const ctx = statusContext(task, employee)
  const volgendeStappen = voortgangsActies(ctx)
  const annuleren = annulatieActie(ctx)

  // §5/§7: four-eyes is allowed, but the UI must warn (non-blocking) when
  // the approver is the same person as the assignee.
  const showFourEyesWarning =
    task.status === 'wacht_op_goedkeuring' && employee?.id === task.toegewezen_medewerker_id

  async function handleStatusActie(actie: StatusActie) {
    setBusy(true)
    setError(null)
    try {
      // Een actie kan uit meerdere stappen bestaan (indienen + zelf
      // goedkeuren). Loopt de tweede stap stuk, dan staat de taak op de
      // tussenstatus en zegt de melding dat ook.
      await voerStatusActieUit(task.id, actie, onStatusChange)
      onClose()
    } catch (err) {
      setError(statusActieFoutmelding(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleReassign() {
    if (reassignTo === task.toegewezen_medewerker_id) return
    setBusy(true)
    setError(null)
    try {
      await onReassign(task.id, reassignTo)
    } catch (err) {
      setError(reportError(err, 'Herverdelen is mislukt'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={task.obligation_type?.naam ?? task.title ?? 'Ad-hoc taak'} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={task.status} />
          <UrgencyBadge dueDate={task.due_date} status={task.status} categorie={task.obligation_type?.categorie} />
          {task.review_vereist && (
            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Review vereist
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <dt className="text-xs font-medium uppercase text-slate-400">Klant</dt>
            <dd className="text-slate-800">
              {task.client?.vertrouwelijk && <span aria-label="Vertrouwelijk">🔒 </span>}
              {task.client?.naam ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-400">Periode</dt>
            <dd className="text-slate-800">{task.periode_label ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-400">Deadline</dt>
            <dd className="text-slate-800">
              {formatDate(task.due_date)}
              {task.due_date_verschoven && (
                <span className="ml-1 text-xs text-slate-400">
                  (wettelijk: {formatDate(task.due_date_wettelijk)}, verschoven door weekend/feestdag)
                </span>
              )}
              {task.voorlopige_datum && <span className="ml-1 text-xs text-amber-600">(voorlopige datum)</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-400">Herkomst</dt>
            <dd className="text-slate-800">{task.bron_type === 'automatisch_gegenereerd' ? 'Automatisch gegenereerd' : 'Ad-hoc'}</dd>
          </div>
        </dl>

        {task.review_reden && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{task.review_reden}</p>
        )}

        {task.description && <p className="text-slate-600">{task.description}</p>}

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase text-slate-400">Verantwoordelijke</label>
          <div className="flex gap-2">
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.naam}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || reassignTo === task.toegewezen_medewerker_id}
              onClick={handleReassign}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Herverdeel
            </button>
          </div>
        </div>

        {task.review_vereist && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onMarkReviewHandled(task.id).then(onClose)}
            className="w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
          >
            Markeer review als afgehandeld
          </button>
        )}

        {showFourEyesWarning && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Let op: jij bent zowel de verantwoordelijke als de goedkeurder van deze taak (four-eyes-principe niet gerespecteerd).
            Dit is technisch toegelaten, maar wordt best vermeden.
          </p>
        )}

        {wachtOpGoedkeurder(ctx) && (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">{WACHT_OP_GOEDKEURDER_UITLEG}</p>
        )}

        {volgendeStappen.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase text-slate-400">Status wijzigen</label>
            <div className="flex flex-wrap gap-2">
              {volgendeStappen.map((actie) => (
                <button
                  key={actie.label}
                  type="button"
                  disabled={busy}
                  onClick={() => handleStatusActie(actie)}
                  className={
                    actie.doel === 'ingediend_afgerond'
                      ? 'rounded-md border border-brand-600 bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50'
                      : 'rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50'
                  }
                >
                  {actie.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Annuleren is geen vervolgstap maar het afbreken van de taak: aparte
            plaats, rustiger vormgeving, en het blijft beschikbaar ook wanneer
            er verder niets te doen valt (zoals wachten op een goedkeurder). */}
        {annuleren && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleStatusActie(annuleren)}
            className="text-xs font-medium text-slate-400 underline underline-offset-2 hover:text-red-600 disabled:opacity-50"
          >
            {annuleren.label}
          </button>
        )}

        <div>
          <h3 className="mb-1.5 text-xs font-medium uppercase text-slate-400">Historiek</h3>
          {logLoading ? (
            <p className="text-xs text-slate-400">Laden…</p>
          ) : log.length === 0 ? (
            <p className="text-xs text-slate-400">Geen historiek.</p>
          ) : (
            <ul className="max-h-40 space-y-1.5 overflow-y-auto text-xs text-slate-500">
              {log.map((entry) => (
                <li key={entry.id} className="border-b border-slate-100 pb-1.5 last:border-0">
                  <div>
                    <span className="font-medium text-slate-700">{EVENT_LABEL[entry.event_type] ?? entry.event_type}</span>
                    {entry.nieuw_status && <span> → {STATUS_LABEL[entry.nieuw_status]}</span>}
                    {entry.nieuwe_due_date && <span> → {formatDate(entry.nieuwe_due_date)}</span>}
                    <span className="ml-1 text-slate-400">
                      ({entry.actor?.naam ? `${entry.actor.naam}, ` : ''}
                      {TRIGGER_BRON_LABEL[entry.trigger_bron] ?? entry.trigger_bron}, {formatDateTime(entry.created_at)})
                    </span>
                  </div>
                  {entry.notitie && <div className="mt-0.5 text-slate-500">{entry.notitie}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  )
}
