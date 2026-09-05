import { useWorkload } from '../hooks/useKantooroverzicht'
import { ErrorState } from '../components/ErrorState'

/** Workload-dashboard (§4 punt 6): wie zit vol, wie loopt achter.
 *
 *  Beantwoordt een andere vraag dan het Overzicht: dáár gaat het over wat er
 *  misloopt, hier over wie het moet doen.
 *
 *  De getallen komen sinds 0056 uit de databank. Daarvóór haalde dit scherm
 *  élke openstaande taak van het kantoor op -- op de testomgeving 3.588 rijen
 *  met drie gejoinde objecten -- om er in de browser 66 getallen van te maken.
 *  Er stond geen expliciete grens op die query, dus de standaardgrens van
 *  PostgREST bepaalde stilzwijgend hoeveel er meekwam; een afgekapt totaal
 *  ziet er precies uit als een kloppend totaal. */
export function WorkloadDashboardPage() {
  const { rijen, loading, error, reload } = useWorkload()

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Workload-dashboard</h1>
        <p className="text-sm text-slate-500">
          Capaciteit en achterstand per medewerker, over de dossiers die je kan zien.
        </p>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Medewerker</th>
                <th className="px-3 py-2">Open taken</th>
                <th className="px-3 py-2">Te laat</th>
                <th className="px-3 py-2">Binnen 7 dagen</th>
                <th className="px-3 py-2">Binnen 31 dagen</th>
                <th className="px-3 py-2">Wacht op goedkeuring</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rijen.map((r) => (
                <tr key={r.employee_id}>
                  <td className="px-3 py-2 font-medium text-slate-800">{r.naam}</td>
                  <td className="px-3 py-2 text-slate-600">{r.open_totaal}</td>
                  <td className={`px-3 py-2 font-semibold ${r.te_laat > 0 ? 'text-red-600' : 'text-slate-400'}`}>{r.te_laat}</td>
                  <td className="px-3 py-2 text-slate-600">{r.binnen_7_dagen}</td>
                  <td className="px-3 py-2 text-slate-600">{r.binnen_31_dagen}</td>
                  <td className="px-3 py-2 text-slate-600">{r.wacht_op_goedkeuring}</td>
                </tr>
              ))}
              {rijen.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                    Geen actieve medewerkers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
