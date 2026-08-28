import { useState } from 'react'
import { useClients } from '../hooks/useClients'
import { useEmployees } from '../hooks/useEmployees'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { ClientFormModal, type ClientFormValues } from '../components/ClientFormModal'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { saveClientObligations } from '../lib/clientObligations'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { formatDate } from '../lib/urgency'

/** Klantenlijst/zoekscherm (§4 point 8). */
export function KlantenlijstPage({ navigate }: { navigate: (view: string, param?: string) => void }) {
  const { employee } = useCurrentEmployee()
  const { employees } = useEmployees()
  const { clients, loading, error, filters, setFilters, reload, createClient } = useClients()
  const { obligationTypes } = useObligationTypes()
  const codePerTypeId = Object.fromEntries(obligationTypes.map((t) => [t.id, t.code]))
  const [showCreate, setShowCreate] = useState(false)

  async function handleCreate(values: ClientFormValues) {
    if (!employee) return
    const nieuw = await createClient({
      firm_id: employee.firm_id,
      naam: values.naam.trim(),
      ondernemingsnummer: values.ondernemingsnummer.trim() || null,
      rechtsvorm: values.rechtsvorm.trim() || null,
      boekjaar_einde_maand: values.boekjaar_einde_maand,
      boekjaar_einde_dag: values.boekjaar_einde_dag,
      btw_regime: values.btw_regime,
      btw_aangifte_frequentie: values.btw_regime === 'periodieke_aangever' ? (values.btw_aangifte_frequentie || 'kwartaal') : null,
      mandataris: values.mandataris,
      vertrouwelijk: values.vertrouwelijk,
      standaard_verantwoordelijke_id: values.standaard_verantwoordelijke_id || null,
      actief: true,
    })
    // Alles in één handeling: de klant staat er, en zijn toekomstige taken ook.
    await saveClientObligations(nieuw.id, values.obligations, codePerTypeId)
    await reload()
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Klanten</h1>
          <p className="text-sm text-slate-500">Zoek en filter over alle klanten van het kantoor.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Nieuwe klant
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Zoeken</label>
          <input
            type="text"
            placeholder="Naam, ondernemingsnummer…"
            value={filters.zoekterm ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, zoekterm: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Status</label>
          <select
            value={String(filters.actief)}
            onChange={(e) => setFilters((f) => ({ ...f, actief: e.target.value === 'alle' ? 'alle' : e.target.value === 'true' }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="true">Actief</option>
            <option value="false">Inactief</option>
            <option value="alle">Alle</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Mandataris</label>
          <select
            value={String(filters.mandataris)}
            onChange={(e) => setFilters((f) => ({ ...f, mandataris: e.target.value === 'alle' ? 'alle' : e.target.value === 'true' }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="alle">Alle</option>
            <option value="true">Ja</option>
            <option value="false">Nee</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Verantwoordelijke</label>
          <select
            value={filters.verantwoordelijkeId ?? 'alle'}
            onChange={(e) => setFilters((f) => ({ ...f, verantwoordelijkeId: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="alle">Alle</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : clients.length === 0 ? (
        <EmptyState title="Geen klanten gevonden voor deze filters." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Naam</th>
                <th className="px-3 py-2">Rechtsvorm</th>
                <th className="px-3 py-2">Boekjaareinde</th>
                <th className="px-3 py-2">BTW-regime</th>
                <th className="px-3 py-2">Mandataris</th>
                <th className="px-3 py-2">Verantwoordelijke</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {clients.map((client) => (
                <tr key={client.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate('klanten', client.id)}>
                  <td className="px-3 py-2 font-medium text-slate-800">
                    {client.vertrouwelijk && <span aria-label="Vertrouwelijk">🔒 </span>}
                    {client.naam}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{client.rechtsvorm ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {formatDate(`2000-${String(client.boekjaar_einde_maand).padStart(2, '0')}-${String(client.boekjaar_einde_dag).padStart(2, '0')}`).replace(
                      '2000',
                      ''
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{client.btw_regime}</td>
                  <td className="px-3 py-2 text-slate-600">{client.mandataris ? 'Ja' : 'Nee'}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {employees.find((e) => e.id === client.standaard_verantwoordelijke_id)?.naam ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                        client.actief ? 'border-emerald-300 bg-emerald-100 text-emerald-700' : 'border-slate-300 bg-slate-100 text-slate-500'
                      }`}
                    >
                      {client.actief ? 'Actief' : 'Inactief'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={() => setShowCreate(false)} onSubmit={handleCreate} />
      )}
    </div>
  )
}
