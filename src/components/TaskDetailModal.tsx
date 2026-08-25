import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { StatusBadge } from './StatusBadge'
import { UrgencyBadge } from './UrgencyBadge'
import { formatDate, formatDateTime } from '../lib/urgency'
import { supabase } from '../lib/supabase'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import type { Employee, TaskInstanceWithRelations, TaskStatus, TaskStatusLog } from '../types'
import { reportError } from '../lib/errorMessage'

interface TaskDetailModalProps {
  task: TaskInstanceWithRelations
  employees: Employee[]
  onClose: () => void
  onStatusChange: (taskId: string, status: TaskStatus) => Promise<void>
  onReassign: (taskId: string, employeeId: string) => Promise<void>
  onMarkReviewHandled: (taskId: string) => Promise<void>
}

const NEXT_STATUS_OPTIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd'],
  in_uitvoering: ['wacht_op_klant', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd'],
  wacht_op_klant: ['in_uitvoering', 'wacht_op_goedkeuring', 'ingediend_afgerond', 'geannuleerd'],
  wacht_op_goedkeuring: ['ingediend_afgerond', 'in_uitvoering', 'geannuleerd'],
  ingediend_afgerond: [],
  geannuleerd: [],
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Open',
  in_uitvoering: 'In uitvoering',
  wacht_op_klant: 'Wacht op klant',
  wacht_op_goedkeuring: 'Wacht op goedkeuring',
  ingediend_afgerond: 'Ingediend/afgerond',
  geannuleerd: 'Geannuleerd',
}

const EVENT_LABEL: Record<string, string> = {
  status_wijziging: 'Statuswijziging',
  due_date_herberekend: 'Deadline herberekend',
  toewijzing_gewijzigd: 'Herverdeeld',
  review_gemarkeerd: 'Gemarkeerd voor review',
  review_afgehandeld: 'Review afgehandeld',
  goedkeuring_gegeven: 'Goedgekeurd',
  goedkeuring_geweigerd: 'Goedkeuring geweigerd',
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
  const [log, setLog] = useState<TaskStatusLog[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reassignTo, setReassignTo] = useState(task.toegewezen_medewerker_id)

  useEffect(() => {
    let active = true
    setLogLoading(true)
    supabase
      .from('task_status_log')
      .select('*')
      .eq('task_instance_id', task.id)
      .order('created_at', { ascending: false })
      .then(({ data, error: err }) => {
        if (!active) return
        if (!err) setLog((data ?? []) as TaskStatusLog[])
        setLogLoading(false)
      })
    return () => {
      active = false
    }
  }, [task.id])

  // Mirrors the server-side statusflow trigger (enforce_task_instance_
  // transition in 0004_domain_functions_triggers.sql) so the UI doesn't
  // offer actions the database would reject. The database remains the
  // real authority — this is only a UX improvement, not the enforcement.
  const nextOptions = NEXT_STATUS_OPTIONS[task.status].filter((s) => {
    if (s === 'wacht_op_goedkeuring' && !task.vereist_goedkeuring) return false
    if (task.status === 'wacht_op_goedkeuring' && (s === 'ingediend_afgerond' || s === 'in_uitvoering')) {
      return !!employee?.mag_goedkeuren
    }
    return true
  })

  // §5/§7: four-eyes is allowed, but the UI must warn (non-blocking) when
  // the approver is the same person as the assignee.
  const showFourEyesWarning =
    task.status === 'wacht_op_goedkeuring' && employee?.id === task.toegewezen_medewerker_id

  async function handleStatusChange(status: TaskStatus) {
    setBusy(true)
    setError(null)
    try {
      await onStatusChange(task.id, status)
      onClose()
    } catch (err) {
      setError(reportError(err, 'Statuswijziging is mislukt'))
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

        {task.status === 'wacht_op_goedkeuring' && !employee?.mag_goedkeuren && (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Deze taak wacht op goedkeuring. Enkel medewerkers met goedkeuringsrecht kunnen ze goedkeuren of terugsturen.
          </p>
        )}

        {nextOptions.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase text-slate-400">Status wijzigen</label>
            <div className="flex flex-wrap gap-2">
              {nextOptions.map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={busy}
                  onClick={() => handleStatusChange(status)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {status === 'wacht_op_goedkeuring'
                    ? 'Dien in voor goedkeuring'
                    : task.status === 'wacht_op_goedkeuring' && status === 'in_uitvoering'
                      ? 'Terugsturen (afkeuren)'
                      : task.status === 'wacht_op_goedkeuring' && status === 'ingediend_afgerond'
                        ? 'Goedkeuren'
                        : STATUS_LABEL[status]}
                </button>
              ))}
            </div>
          </div>
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
                  <span className="font-medium text-slate-700">{EVENT_LABEL[entry.event_type] ?? entry.event_type}</span>
                  {entry.nieuw_status && <span> → {STATUS_LABEL[entry.nieuw_status]}</span>}
                  {entry.nieuwe_due_date && <span> → {formatDate(entry.nieuwe_due_date)}</span>}
                  <span className="ml-1 text-slate-400">({formatDateTime(entry.created_at)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  )
}
