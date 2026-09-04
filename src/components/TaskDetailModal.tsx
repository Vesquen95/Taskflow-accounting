import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { StatusBadge } from './StatusBadge'
import { WachtDuurBadge } from './WachtDuurBadge'
import { UrgencyBadge } from './UrgencyBadge'
import { dagenVerschil, formatDate, formatDateTime } from '../lib/urgency'
import { supabase } from '../lib/supabase'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useTeams } from '../hooks/useTeams'
import { collegasVoorDossier } from '../lib/teams'
import type { Employee, TaskInstanceWithRelations, TaskStatus, TaskStatusLog } from '../types'
import { reportError } from '../lib/errorMessage'
import {
  annulatieActie,
  CHECKLIST_HERINNERING,
  gaatLangsGoedkeuring,
  EINDSTATUSSEN,
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
  onReassign: (taskId: string, employeeId: string | null) => Promise<void>
  onMarkReviewHandled: (taskId: string) => Promise<void>
  /** Optioneel: schermen die een deadline laten verzetten geven dit mee.
   *  Zonder handler blijft de deadline een leesbaar gegeven. */
  onDueDateChange?: (taskId: string, dueDate: string) => Promise<void>
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

/** Hoever wijkt de afgesproken deadline af van de wettelijke datum? Dat
 *  verschil is de hele reden om beide te tonen. */
function afwijkingTekst(wettelijk: string, effectief: string): string {
  const dagen = dagenVerschil(wettelijk, effectief)
  if (dagen === 0) return 'zelfde dag als de wettelijke datum'
  const woord = Math.abs(dagen) === 1 ? 'dag' : 'dagen'
  return dagen > 0
    ? `${dagen} ${woord} na de wettelijke datum`
    : `${Math.abs(dagen)} ${woord} vóór de wettelijke datum`
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
  onDueDateChange,
}: TaskDetailModalProps) {
  const { employee } = useCurrentEmployee()
  const { leden } = useTeams()
  const [log, setLog] = useState<TaskStatusLogWithActor[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // '' is de bak van het team: nog niemand. Een aparte lege stand en geen
  // null, zodat de keuzelijst er gewoon een optie van kan maken.
  const [reassignTo, setReassignTo] = useState(task.toegewezen_medewerker_id ?? '')
  const [nieuweDeadline, setNieuweDeadline] = useState(task.due_date)

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
  // De keuzelijst volgt het team van het dossier. Geen afscherming -- dat doet
  // de databank -- maar wel het verschil tussen zes zinvolle namen en vijftig.
  const collegas = collegasVoorDossier(employees, leden, task.client.team_id, task.toegewezen_medewerker_id)

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

  // De wettelijke datum is een ijkpunt, geen instelling: hij verschuift niet
  // mee (migratie 0013 weigert dat zelfs buiten de kalenderpijplijn om).
  const isWettelijk = task.obligation_type?.categorie === 'wettelijk'
  const handmatigVerzet = task.due_date_handmatig_op !== null
  const afgesloten = EINDSTATUSSEN.includes(task.status)
  const magVerzetten = Boolean(onDueDateChange) && !afgesloten
  const naWettelijkeDatum = isWettelijk && nieuweDeadline > task.due_date_wettelijk

  async function handleDueDate() {
    if (!onDueDateChange || !nieuweDeadline || nieuweDeadline === task.due_date) return
    setBusy(true)
    setError(null)
    try {
      // Enkel de effectieve datum: due_date_handmatig_op en de logregel komen
      // van de databank (0013). Sluiten na afloop, want de taak in dit scherm
      // is dan verouderd — de lijst eronder herlaadt.
      await onDueDateChange(task.id, nieuweDeadline)
      onClose()
    } catch (err) {
      setError(reportError(err, 'De deadline verzetten is mislukt'))
    } finally {
      setBusy(false)
    }
  }

  async function handleReassign(naar: string | null = reassignTo || null) {
    if (naar === (task.toegewezen_medewerker_id ?? null)) return
    setBusy(true)
    setError(null)
    try {
      await onReassign(task.id, naar)
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
          <WachtDuurBadge sinds={task.wacht_op_klant_sinds} />
          <UrgencyBadge dueDate={task.due_date} status={task.status} categorie={task.obligation_type?.categorie} />
          {task.review_vereist && (
            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Review vereist
            </span>
          )}
          {handmatigVerzet && (
            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Afgesproken deadline
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
              {task.due_date_verschoven && !handmatigVerzet && (
                <span className="ml-1 text-xs text-slate-400">
                  (wettelijk: {formatDate(task.due_date_wettelijk)}, verschoven door weekend/feestdag)
                </span>
              )}
              {task.voorlopige_datum && <span className="ml-1 text-xs text-amber-600">(voorlopige datum)</span>}
              {handmatigVerzet && (
                <span className="mt-0.5 block text-xs text-amber-700">
                  {`Handmatig verzet op ${formatDateTime(task.due_date_handmatig_op)} — wettelijk: ${formatDate(
                    task.due_date_wettelijk
                  )} (${afwijkingTekst(task.due_date_wettelijk, task.due_date)})`}
                </span>
              )}
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

          {/* Ligt de taak nog in de bak van het team, dan is "ik doe dit" de
              handeling die je hier komt doen. Eén knop in plaats van jezelf
              opzoeken in een keuzelijst. */}
          {task.toegewezen_medewerker_id === null && employee && (
            <button
              type="button"
              disabled={busy}
              onClick={() => handleReassign(employee.id)}
              className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Ik neem dit op
            </button>
          )}

          <div className="flex gap-2">
            <select
              aria-label="Verantwoordelijke"
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">— nog niemand, in de bak van het team —</option>
              {collegas.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.naam}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || (reassignTo || null) === (task.toegewezen_medewerker_id ?? null)}
              onClick={() => handleReassign()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Herverdeel
            </button>
          </div>
        </div>

        {magVerzetten && (
          <div className="space-y-1.5 rounded-md border border-slate-200 p-3">
            <label htmlFor="nieuwe-deadline" className="text-xs font-medium uppercase text-slate-400">
              Nieuwe deadline
            </label>
            <div className="flex gap-2">
              <input
                id="nieuwe-deadline"
                type="date"
                value={nieuweDeadline}
                onChange={(e) => setNieuweDeadline(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                disabled={busy || !nieuweDeadline || nieuweDeadline === task.due_date}
                onClick={handleDueDate}
                className="whitespace-nowrap rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Deadline verzetten
              </button>
            </div>
            {/* Voor een wettelijke verplichting is dit geen administratieve
                handeling maar een besluit: de wettelijke datum blijft staan en
                te laat indienen heeft gevolgen. Dat hoort op het scherm, niet
                in een handleiding. */}
            <p className="text-xs text-slate-500">
              {isWettelijk
                ? `Je verzet de werkdatum van het kantoor. Dat verschuift de wettelijke deadline niet: de wettelijke datum blijft ${formatDate(
                    task.due_date_wettelijk
                  )}, en later indienen dan die datum kan boetes of nalatigheidsintresten opleveren. Dit is een besluit, geen correctie.`
                : `Deze taak heeft geen wettelijke deadline; de datum is een afspraak van het kantoor. Ter vergelijking blijft de oorspronkelijk berekende datum ${formatDate(
                    task.due_date_wettelijk
                  )} bewaard.`}
            </p>
            {naWettelijkeDatum && (
              <p
                role="alert"
                aria-label="Datum na de wettelijke deadline"
                className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
              >
                {`De gekozen datum ligt na de wettelijke deadline van ${formatDate(
                  task.due_date_wettelijk
                )}. De verplichting is dan te laat ingediend; de wettelijke datum schuift niet mee.`}
              </p>
            )}
          </div>
        )}

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
            {/* Het kantoor werkt met checklists per categorie. Taskflow beheert
                die niet, maar het moment waarop ze vergeten worden is wél te
                vatten: bij het doorsturen, want dan geef je het dossier uit
                handen. In de takenlijst staat dit als een bevestiging vóór de
                stap; hier zou een venster in een venster komen, dus staat het
                er als tekst bij de knoppen. */}
            {volgendeStappen.some(gaatLangsGoedkeuring) && (
              <p className="text-xs text-slate-500">{CHECKLIST_HERINNERING}</p>
            )}
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
