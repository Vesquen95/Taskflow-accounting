import { useState } from 'react'
import { useClientDetail } from '../hooks/useClientDetail'
import { useEmployees } from '../hooks/useEmployees'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { ErrorState } from '../components/ErrorState'
import { StatusBadge } from '../components/StatusBadge'
import { UrgencyBadge } from '../components/UrgencyBadge'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ClientFormModal, type ClientFormValues } from '../components/ClientFormModal'
import { ClientObligationFormModal } from '../components/ClientObligationFormModal'
import { AdhocTaskFormModal } from '../components/AdhocTaskFormModal'
import { formatDate } from '../lib/urgency'
import { supabase } from '../lib/supabase'
import type { TaskInstanceWithRelations, TaskStatus } from '../types'

/** Klantdossier (§4 point 3): alle verplichtingen, status/historiek,
 * komende deadlines, verantwoordelijke, notities per klant. */
export function KlantDossierPage({ clientId, navigate }: { clientId: string; navigate: (view: string, param?: string) => void }) {
  const { client, obligations, tasks, loading, error, reload, addObligation, deactivateObligation, createAdhocTask } =
    useClientDetail(clientId)
  const { employees } = useEmployees()
  const { obligationTypes } = useObligationTypes()
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [showAddObligation, setShowAddObligation] = useState(false)
  const [showAdhoc, setShowAdhoc] = useState(false)

  async function handleEdit(values: ClientFormValues) {
    const { error: err } = await supabase
      .from('clients')
      .update({
        naam: values.naam.trim(),
        ondernemingsnummer: values.ondernemingsnummer.trim() || null,
        rechtsvorm: values.rechtsvorm.trim() || null,
        boekjaar_einde_maand: values.boekjaar_einde_maand,
        boekjaar_einde_dag: values.boekjaar_einde_dag,
        btw_regime: values.btw_regime,
        btw_aangifte_frequentie: values.btw_regime === 'periodieke_aangever' ? values.btw_aangifte_frequentie || 'kwartaal' : null,
        mandataris: values.mandataris,
        vertrouwelijk: values.vertrouwelijk,
        standaard_verantwoordelijke_id: values.standaard_verantwoordelijke_id || null,
        actief: values.actief,
      })
      .eq('id', clientId)
    if (err) throw err
    await reload()
  }

  async function updateTaskStatus(taskId: string, status: TaskStatus) {
    const { error: err } = await supabase.from('task_instances').update({ status }).eq('id', taskId)
    if (err) throw err
    await reload()
  }

  async function reassignTask(taskId: string, toegewezen_medewerker_id: string) {
    const { error: err } = await supabase.from('task_instances').update({ toegewezen_medewerker_id }).eq('id', taskId)
    if (err) throw err
    await reload()
  }

  async function markReviewHandled(taskId: string) {
    const { error: err } = await supabase.from('task_instances').update({ review_vereist: false }).eq('id', taskId)
    if (err) throw err
    await reload()
  }

  if (error) {
    return (
      <div className="p-6">
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  if (loading || !client) {
    return <p className="p-6 text-sm text-slate-400">Laden…</p>
  }

  const activeObligations = obligations.filter((o) => o.actief && !o.geldig_tot)
  const historicalObligations = obligations.filter((o) => !(o.actief && !o.geldig_tot))
  // `tasks` comes back due_date-descending (useful for history "most
  // recent first") — the upcoming/open list reads better soonest-first.
  const upcoming = tasks
    .filter((t) => !['ingediend_afgerond', 'geannuleerd'].includes(t.status))
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
  const history = tasks.filter((t) => ['ingediend_afgerond', 'geannuleerd'].includes(t.status))

  return (
    <div className="p-6">
      <button type="button" onClick={() => navigate('klanten')} className="mb-3 text-sm text-slate-500 hover:text-slate-800">
        ← Terug naar klantenlijst
      </button>

      <div className="mb-6 flex items-start justify-between rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
            {client.vertrouwelijk && <span aria-label="Vertrouwelijke klant">🔒</span>}
            {client.naam}
            {!client.actief && (
              <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                Inactief
              </span>
            )}
          </h1>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase text-slate-400">Ondernemingsnr.</dt>
              <dd>{client.ondernemingsnummer ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Rechtsvorm</dt>
              <dd>{client.rechtsvorm ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Boekjaareinde</dt>
              <dd>
                {client.boekjaar_einde_dag}/{client.boekjaar_einde_maand}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">BTW-regime</dt>
              <dd>
                {client.btw_regime}
                {client.btw_aangifte_frequentie ? ` (${client.btw_aangifte_frequentie})` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Mandataris</dt>
              <dd>{client.mandataris ? 'Ja' : 'Nee'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Standaard verantwoordelijke</dt>
              <dd>{employees.find((e) => e.id === client.standaard_verantwoordelijke_id)?.naam ?? '—'}</dd>
            </div>
          </dl>
        </div>
        <button type="button" onClick={() => setShowEdit(true)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Bewerken
        </button>
      </div>

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Verplichtingen</h2>
          <button type="button" onClick={() => setShowAddObligation(true)} className="text-sm font-medium text-brand-600 hover:text-brand-700">
            + Verplichting toevoegen
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Geldig vanaf</th>
                <th className="px-3 py-2">Geldig tot</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeObligations.map((o) => (
                <tr key={o.id}>
                  <td className="px-3 py-2 font-medium text-slate-800">{o.obligation_type.naam}</td>
                  <td className="px-3 py-2 text-slate-600">{formatDate(o.geldig_vanaf)}</td>
                  <td className="px-3 py-2 text-slate-600">—</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      Actief
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => deactivateObligation(o.id)} className="text-xs font-medium text-red-600 hover:text-red-700">
                      Deactiveren
                    </button>
                  </td>
                </tr>
              ))}
              {activeObligations.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-slate-400">
                    Nog geen actieve verplichtingen geconfigureerd.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {historicalObligations.length > 0 && (
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer">Historiek ({historicalObligations.length})</summary>
            <ul className="mt-1 space-y-1">
              {historicalObligations.map((o) => (
                <li key={o.id}>
                  {o.obligation_type.naam}: {formatDate(o.geldig_vanaf)} — {o.geldig_tot ? formatDate(o.geldig_tot) : 'lopend'}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Openstaande taken</h2>
          <button type="button" onClick={() => setShowAdhoc(true)} className="text-sm font-medium text-brand-600 hover:text-brand-700">
            + Ad-hoc taak
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Verplichting</th>
                <th className="px-3 py-2">Periode</th>
                <th className="px-3 py-2">Deadline</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Verantwoordelijke</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {upcoming.map((t) => (
                <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenTask(t)}>
                  <td className="px-3 py-2 font-medium text-slate-800">{t.obligation_type?.naam ?? t.title}</td>
                  <td className="px-3 py-2 text-slate-500">{t.periode_label ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {formatDate(t.due_date)}
                      <UrgencyBadge dueDate={t.due_date} status={t.status} categorie={t.obligation_type?.categorie} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-3 py-2 text-slate-600">{t.toegewezen_medewerker?.naam ?? '—'}</td>
                </tr>
              ))}
              {upcoming.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-slate-400">
                    Geen openstaande taken.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {history.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Historiek</h2>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <tbody className="divide-y divide-slate-100">
                {history.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenTask(t)}>
                    <td className="px-3 py-2 text-slate-700">{t.obligation_type?.naam ?? t.title}</td>
                    <td className="px-3 py-2 text-slate-500">{t.periode_label ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{formatDate(t.due_date)}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={t.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {openTask && (
        <TaskDetailModal
          task={openTask}
          employees={employees}
          onClose={() => setOpenTask(null)}
          onStatusChange={updateTaskStatus}
          onReassign={reassignTask}
          onMarkReviewHandled={markReviewHandled}
        />
      )}
      {showEdit && <ClientFormModal client={client} employees={employees} onClose={() => setShowEdit(false)} onSubmit={handleEdit} />}
      {showAddObligation && (
        <ClientObligationFormModal
          obligationTypes={obligationTypes.filter((ot) => !activeObligations.some((a) => a.obligation_type_id === ot.id))}
          employees={employees}
          onClose={() => setShowAddObligation(false)}
          onSubmit={addObligation}
        />
      )}
      {showAdhoc && (
        <AdhocTaskFormModal
          employees={employees}
          defaultAssigneeId={client.standaard_verantwoordelijke_id}
          onClose={() => setShowAdhoc(false)}
          onSubmit={createAdhocTask}
        />
      )}
    </div>
  )
}
