import { Suspense, lazy, useState } from 'react'
import { useClients } from '../hooks/useClients'
import { useEmployees } from '../hooks/useEmployees'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { ClientFormModal, type ClientFormValues } from '../components/ClientFormModal'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { saveClientObligations, syncClientTasks } from '../lib/clientObligations'
import { metStandaardParameters } from '../lib/obligationParameters'
import type { NieuweKlant, VerplichtingKeuze } from '../lib/klantImport'
import { reportError } from '../lib/errorMessage'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { formatDate } from '../lib/urgency'

/** Het importscherm en alles wat eraan hangt (de Excel-bibliotheken voorop)
 *  blijven uit de hoofdbundel: de meeste mensen importeren nooit iets. Enkel
 *  het type NieuweKlant komt hierboven statisch binnen, en dat is een
 *  type-import — die verdwijnt bij het bouwen. */
const KlantImportModal = lazy(() =>
  import('../components/KlantImportModal').then((m) => ({ default: m.KlantImportModal }))
)

/** Klantenlijst/zoekscherm (§4 point 8). */
export function KlantenlijstPage({ navigate }: { navigate: (view: string, param?: string) => void }) {
  const { employee } = useCurrentEmployee()
  const { employees } = useEmployees()
  const { clients, loading, error, filters, setFilters, reload, createClient, insertClient, haalOndernemingsnummers } =
    useClients()
  const { obligationTypes } = useObligationTypes()
  const codePerTypeId = Object.fromEntries(obligationTypes.map((t) => [t.id, t.code]))
  const [showCreate, setShowCreate] = useState(false)
  // null = importscherm dicht. De bestaande ondernemingsnummers worden één
  // keer opgehaald bij het openen, zodat het voorbeeld dubbels kan tonen vóór
  // de unieke index ze weigert.
  const [importNummers, setImportNummers] = useState<string[] | null>(null)
  const [sjabloonFout, setSjabloonFout] = useState<string | null>(null)

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

  async function openImport() {
    setSjabloonFout(null)
    try {
      setImportNummers(await haalOndernemingsnummers())
    } catch (err) {
      // Geen reden om de import tegen te houden: de databank blijft de echte
      // bewaker van dubbele ondernemingsnummers.
      console.error('[Taskflow] Kon bestaande ondernemingsnummers niet ophalen', err)
      setImportNummers([])
    }
  }

  async function haalSjabloon() {
    setSjabloonFout(null)
    try {
      const { downloadSjabloon } = await import('../lib/klantImportBestand')
      await downloadSjabloon()
    } catch (err) {
      setSjabloonFout(reportError(err, 'Kon het sjabloon niet maken'))
    }
  }

  /** Eén klant uit het importbestand. Bewust dezelfde velden als het
   *  klantformulier, min vertrouwelijk en de standaard verantwoordelijke:
   *  block_unaudited_confidentiality_change() weigert die bij het aanmaken. */
  async function maakKlantUitImport(klant: NieuweKlant): Promise<string> {
    if (!employee) throw new Error('Geen medewerkersprofiel geladen.')
    const nieuw = await insertClient({
      firm_id: employee.firm_id,
      ...klant,
      vertrouwelijk: false,
      standaard_verantwoordelijke_id: null,
      actief: true,
    })
    return nieuw.id
  }

  /** De verplichtingen van een geïmporteerde klant aanvinken, en meteen zijn
   *  taken laten aanmaken.
   *
   *  Zelfde weg als het klantformulier (saveClientObligations), zodat een
   *  geïmporteerde klant niet anders in de databank staat dan een handmatig
   *  aangemaakte: dezelfde standaardparameters, dezelfde afsluitende
   *  taakgeneratie. Ook een rij zonder één aangevinkte verplichting komt hier
   *  langs — dan is er niets aan te vinken, maar de btw-taken (die uit het
   *  regime volgen) moeten wel gegenereerd worden. */
  async function zetVerplichtingenUitImport(
    clientId: string,
    verplichtingen: VerplichtingKeuze[]
  ): Promise<void> {
    const selecties = obligationTypes.map((type) => {
      const keuze = verplichtingen.find((v) => v.code === type.code)
      return {
        obligation_type_id: type.id,
        gekozen: keuze !== undefined,
        standaard_toegewezen_medewerker_id: '',
        // Het bestand geeft alleen mee wat er echt ingevuld stond; de
        // standaardwaarden komen er hier bij, langs precies dezelfde helper
        // als het klantformulier. Zo houdt de import geen tweede set
        // standaarden bij die na de eerste wijziging uiteenloopt.
        parameters: keuze ? metStandaardParameters(type.code, keuze.parameters) : {},
      }
    })
    if (selecties.some((sel) => sel.gekozen)) {
      await saveClientObligations(clientId, selecties, codePerTypeId)
      return
    }
    await syncClientTasks(clientId)
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Klanten</h1>
          <p className="text-sm text-slate-500">Zoek en filter over alle klanten van het kantoor.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={haalSjabloon}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sjabloon downloaden
          </button>
          <button
            type="button"
            onClick={openImport}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Importeren uit Excel
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Nieuwe klant
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <label htmlFor="klanten-zoeken" className="mb-1 block text-xs font-medium text-slate-500">Zoeken</label>
          <input
            id="klanten-zoeken"
            type="text"
            placeholder="Naam, ondernemingsnummer…"
            value={filters.zoekterm ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, zoekterm: e.target.value }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          {/* Een gearchiveerde klant hoort niet tussen de actieve te staan,
              maar moet wel terug te vinden zijn — vandaar de twee andere
              standen van dit filter. */}
          <label htmlFor="klanten-status" className="mb-1 block text-xs font-medium text-slate-500">Status</label>
          <select
            id="klanten-status"
            value={String(filters.actief)}
            onChange={(e) => setFilters((f) => ({ ...f, actief: e.target.value === 'alle' ? 'alle' : e.target.value === 'true' }))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="true">Actief</option>
            <option value="false">Gearchiveerd</option>
            <option value="alle">Alle (ook gearchiveerd)</option>
          </select>
        </div>
        <div>
          <label htmlFor="klanten-mandataris" className="mb-1 block text-xs font-medium text-slate-500">Mandataris</label>
          <select
            id="klanten-mandataris"
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
          <label htmlFor="klanten-verantwoordelijke" className="mb-1 block text-xs font-medium text-slate-500">Verantwoordelijke</label>
          <select
            id="klanten-verantwoordelijke"
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
                      {client.actief ? 'Actief' : 'Gearchiveerd'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sjabloonFout && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {sjabloonFout}
        </p>
      )}

      {importNummers !== null && (
        <Suspense fallback={<p className="text-sm text-slate-400">Importscherm laden…</p>}>
          <KlantImportModal
            bestaandeOndernemingsnummers={importNummers}
            maakKlant={maakKlantUitImport}
            zetVerplichtingen={zetVerplichtingenUitImport}
            onKlaar={() => reload()}
            onClose={() => setImportNummers(null)}
          />
        </Suspense>
      )}

      {showCreate && (
        <ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={() => setShowCreate(false)} onSubmit={handleCreate} />
      )}
    </div>
  )
}
