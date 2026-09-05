import { useState } from 'react'
import { useClientDetail } from '../hooks/useClientDetail'
import { useBoekjaarWijziging } from '../hooks/useBoekjaarWijziging'
import { useEmployees } from '../hooks/useEmployees'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { ErrorState } from '../components/ErrorState'
import { StatusBadge } from '../components/StatusBadge'
import { UrgencyBadge } from '../components/UrgencyBadge'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { ClientFormModal, type ClientFormValues } from '../components/ClientFormModal'
import { saveClientObligations, loadClientObligations, type ObligationSelection } from '../lib/clientObligations'
import { ClientObligationFormModal } from '../components/ClientObligationFormModal'
import { AdhocTaskFormModal } from '../components/AdhocTaskFormModal'
import { ClientArchiveModal } from '../components/ClientArchiveModal'
import { BoekjaarWijzigingPaneel } from '../components/BoekjaarWijzigingPaneel'
import { isAfgesloten, telTeAnnulerenTaken } from '../lib/klantArchief'
import { formatDate, formatDateTime } from '../lib/urgency'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/errorMessage'
import type { TaskInstanceWithRelations, TaskStatus } from '../types'

/** Leesbare namen voor client_change_log.veld — het log slaat kolomnamen op,
 *  het kantoor leest liever Nederlands. */
const CHANGE_FIELD_LABEL: Record<string, string> = {
  vertrouwelijk: 'Vertrouwelijk',
  standaard_verantwoordelijke_id: 'Standaard verantwoordelijke',
  toegang_vertrouwelijk_verleend: 'Toegang tot dit vertrouwelijke dossier verleend',
  boekjaar_einde_maand: 'Boekjaareinde (maand)',
  boekjaar_einde_dag: 'Boekjaareinde (dag)',
  btw_regime: 'Btw-regime',
  btw_aangifte_frequentie: 'Btw-aangiftefrequentie',
  actief: 'Actief',
  // Geschreven door de archiveringstrigger (migratie 0026): hoeveel taken het
  // archiveren van dit dossier gekost heeft.
  taken_geannuleerd_bij_archivering: 'Taken geannuleerd bij het archiveren',
}

/** Klantdossier (§4 point 3): alle verplichtingen, status/historiek,
 * komende deadlines, verantwoordelijke, notities per klant. */
export function KlantDossierPage({ clientId, navigate }: { clientId: string; navigate: (view: string, param?: string) => void }) {
  const {
    client,
    obligations,
    tasks,
    changeLog,
    loading,
    error,
    reload,
    addObligation,
    deactivateObligation,
    setObligationEinddatum,
    createAdhocTask,
    archiveClient,
    reactivateClient,
  } = useClientDetail(clientId)
  const { employees } = useEmployees()
  // Nodig voor het teamveld in het klantformulier: het team weghalen mag sinds
  // 0045 alleen een kantoorbeheerder.
  const { employee } = useCurrentEmployee()
  const { obligationTypes } = useObligationTypes()
  // Staat er nog een gewijzigd boekjaareinde open? Dan staan de jaartaken van
  // dit dossier op het OUDE ritme, en hoort dat bovenaan te staan -- niet
  // ergens in het log (migratie 0052).
  const boekjaar = useBoekjaarWijziging(clientId)
  const [openTask, setOpenTask] = useState<TaskInstanceWithRelations | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [bestaandeVerplichtingen, setBestaandeVerplichtingen] = useState<ObligationSelection[]>([])
  const codePerTypeId = Object.fromEntries(obligationTypes.map((t) => [t.id, t.code]))
  const [showAddObligation, setShowAddObligation] = useState(false)
  const [showAdhoc, setShowAdhoc] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [heractiveren, setHeractiveren] = useState(false)

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
    // Verplichtingen bij- en afzetten hoort bij het opslaan, niet bij een
    // aparte knop (docs/PLAN.md §10).
    await saveClientObligations(clientId, values.obligations, codePerTypeId)
    await reload()
    // Een gewijzigd boekjaareinde meldt zich hier (0052); het paneel bovenaan
    // hoort dat meteen te tonen in plaats van pas na een verversing.
    await boekjaar.reload()
  }

  /** Heractiveren vraagt geen bevestiging: er gaat niets verloren, en de
   *  taken van de nog lopende verplichtingen komen er meteen weer bij. */
  async function handleReactivate() {
    setArchiveError(null)
    setHeractiveren(true)
    try {
      await reactivateClient()
    } catch (err) {
      setArchiveError(reportError(err, 'Heractiveren is mislukt'))
    } finally {
      setHeractiveren(false)
    }
  }

  async function openEdit() {
    setBestaandeVerplichtingen(await loadClientObligations(clientId))
    setShowEdit(true)
  }

  async function updateTaskStatus(taskId: string, status: TaskStatus) {
    const { error: err } = await supabase.from('task_instances').update({ status }).eq('id', taskId)
    if (err) throw err
    await reload()
  }

  async function reassignTask(taskId: string, toegewezen_medewerker_id: string | null) {
    const { error: err } = await supabase.from('task_instances').update({ toegewezen_medewerker_id }).eq('id', taskId)
    if (err) throw err
    await reload()
  }

  /** Zie useTaskInstances.updateDueDate: enkel due_date; migratie 0013 zet de
   *  markering en schrijft de logregel. */
  async function updateTaskDueDate(taskId: string, dueDate: string) {
    const { error: err } = await supabase.from('task_instances').update({ due_date: dueDate }).eq('id', taskId)
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
      <div className="p-4 lg:p-6">
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  if (loading || !client) {
    return <p className="p-6 text-sm text-slate-400">Laden…</p>
  }

  // Een einddatum in de toekomst betekent dat de verplichting nog LOOPT: ze
  // levert nog taken op, tot en met de laatste periode die op of vóór die
  // datum eindigt (migratie 0053). Alleen wat echt voorbij is, is historiek.
  const vandaag = new Date().toISOString().slice(0, 10)
  const looptNog = (o: (typeof obligations)[number]) =>
    o.actief && (!o.geldig_tot || o.geldig_tot >= vandaag)
  const activeObligations = obligations.filter(looptNog)
  const historicalObligations = obligations.filter((o) => !looptNog(o))
  // `tasks` comes back due_date-descending (useful for history "most
  // recent first") — the upcoming/open list reads better soonest-first.
  const upcoming = tasks.filter((t) => !isAfgesloten(t.status)).sort((a, b) => a.due_date.localeCompare(b.due_date))
  const history = tasks.filter((t) => isAfgesloten(t.status))
  // Exact wat de archiveringstrigger zal annuleren (migratie 0026), geteld op
  // dezelfde regel — zie src/lib/klantArchief.ts.
  const teAnnuleren = telTeAnnulerenTaken(tasks)

  return (
    <div className="p-4 lg:p-6">
      <button type="button" onClick={() => navigate('klanten')} className="mb-3 text-sm text-slate-500 hover:text-slate-800">
        ← Terug naar klantenlijst
      </button>

      {boekjaar.wijziging && (
        <BoekjaarWijzigingPaneel
          wijziging={boekjaar.wijziging}
          taken={boekjaar.taken}
          bezig={boekjaar.bezig}
          onDoorvoeren={async () => {
            const aantal = await boekjaar.doorvoeren()
            await reload()
            return aantal
          }}
          onNegeren={boekjaar.negeren}
        />
      )}

      <div className="mb-6 flex items-start justify-between rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
            {client.vertrouwelijk && <span aria-label="Vertrouwelijke klant">🔒</span>}
            {client.naam}
            {!client.actief && (
              <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                Gearchiveerd
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
              <dt className="text-xs uppercase text-slate-400">Fiscaal mandaat</dt>
              <dd>{client.mandataris ? 'Ja' : 'Nee'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Standaard verantwoordelijke</dt>
              <dd>{employees.find((e) => e.id === client.standaard_verantwoordelijke_id)?.naam ?? '—'}</dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex gap-2">
            <button type="button" onClick={() => void openEdit()} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Bewerken
            </button>
            {client.actief ? (
              <button
                type="button"
                onClick={() => setShowArchive(true)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Archiveren
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleReactivate()}
                disabled={heractiveren}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {heractiveren ? 'Bezig…' : 'Heractiveren'}
              </button>
            )}
          </div>
          {archiveError && (
            <p role="alert" className="max-w-xs rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              {archiveError}
            </p>
          )}
        </div>
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
                  <td className="px-3 py-2 text-slate-600">
                    <ObligationEinddatum
                      geldigTot={o.geldig_tot}
                      naam={o.obligation_type.naam}
                      onZet={(datum) => setObligationEinddatum(o.id, datum)}
                    />
                  </td>
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

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Wijzigingshistoriek dossier</h2>
        {changeLog.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nog geen wijzigingen aan de vertrouwelijkheid, de verantwoordelijke of de toegang van dit dossier.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm text-slate-600">
            {changeLog.map((entry) => (
              <li key={entry.id} className="border-b border-slate-100 pb-1.5 last:border-0">
                <span className="font-medium text-slate-700">{CHANGE_FIELD_LABEL[entry.veld] ?? entry.veld}</span>
                <span>
                  {': '}
                  {entry.oude_waarde ?? '—'} → {entry.nieuwe_waarde ?? '—'}
                </span>
                <span className="ml-1 text-slate-400">
                  ({entry.actor?.naam ?? 'onbekende medewerker'}, {formatDateTime(entry.created_at)})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openTask && (
        <TaskDetailModal
          task={openTask}
          employees={employees}
          onClose={() => setOpenTask(null)}
          onStatusChange={updateTaskStatus}
          onReassign={reassignTask}
          onMarkReviewHandled={markReviewHandled}
          onDueDateChange={updateTaskDueDate}
        />
      )}
      {showArchive && (
        <ClientArchiveModal
          clientNaam={client.naam}
          vertrouwelijk={client.vertrouwelijk}
          openstaandeTaken={teAnnuleren}
          onClose={() => setShowArchive(false)}
          onConfirm={archiveClient}
        />
      )}
      {showEdit && (
        <ClientFormModal
          client={client}
          openstaandeTaken={teAnnuleren}
          employees={employees}
          obligationTypes={obligationTypes}
          bestaandeVerplichtingen={bestaandeVerplichtingen}
          huidigeMedewerker={employee}
          onClose={() => setShowEdit(false)}
          onSubmit={handleEdit}
        />
      )}
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

/**
 * De einddatum van een lopende verplichting.
 *
 * Waarom dit een veld is en geen tweede "deactiveren"-knop: deactiveren stopt
 * een verplichting vandáág. Hier gaat het om een datum die je nu al kent maar
 * die nog moet komen -- de sluiting van een vereffening, het einde van een
 * mandaat. De verplichting blijft tot dan gewoon lopen.
 *
 * De grens ligt op de periode, niet op de deadline (migratie 0053): zet je
 * 31/12/2026, dan blijft de aangifte over boekjaar 2026 staan, ook al wordt
 * die pas in september 2027 ingediend.
 */
function ObligationEinddatum({
  geldigTot,
  naam,
  onZet,
}: {
  geldigTot: string | null
  naam: string
  onZet: (datum: string | null) => Promise<void>
}) {
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  async function zet(datum: string | null) {
    setFout(null)
    setBezig(true)
    try {
      await onZet(datum)
    } catch (err) {
      setFout(reportError(err, 'De einddatum kon niet bewaard worden.'))
    } finally {
      setBezig(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="date"
          aria-label={`Loopt tot en met — ${naam}`}
          value={geldigTot ?? ''}
          disabled={bezig}
          onChange={(e) => void zet(e.target.value || null)}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
        />
        {geldigTot && (
          <button
            type="button"
            disabled={bezig}
            onClick={() => void zet(null)}
            className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
          >
            Wissen
          </button>
        )}
      </div>
      {geldigTot && (
        <span className="text-[11px] text-slate-500">
          Geen taken meer voor een periode na deze datum.
        </span>
      )}
      {fout && <span className="text-[11px] text-red-700">{fout}</span>}
    </div>
  )
}
