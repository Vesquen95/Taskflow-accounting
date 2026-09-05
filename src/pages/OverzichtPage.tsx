import { useMemo } from 'react'
import { useKantooroverzicht, type OverzichtRij } from '../hooks/useKantooroverzicht'
import { ErrorState } from '../components/ErrorState'
import { WACHT_LANG_VANAF_DAGEN } from '../lib/urgency'

/** De vier getallen, in de volgorde waarin ze ertoe doen.
 *
 *  "Niemand op én te laat" staat vooraan en niet bij de rest: dat is het enige
 *  getal waar geen mens achter zit die eraan herinnerd wordt. Alle andere
 *  achterstand staat bij iemand op de lijst; deze bij niemand. */
const KOLOMMEN: {
  sleutel: keyof Pick<
    OverzichtRij,
    'niemand_op_te_laat' | 'te_laat' | 'te_lang_bij_klant' | 'wacht_op_goedkeuring'
  >
  label: string
  uitleg: string
  ernstig: boolean
}[] = [
  {
    sleutel: 'niemand_op_te_laat',
    label: 'Te laat, niemand op',
    uitleg: 'Achterstand zonder eigenaar. Niemand krijgt hier een herinnering voor.',
    ernstig: true,
  },
  {
    sleutel: 'te_laat',
    label: 'Te laat',
    uitleg: 'Alles waarvan de deadline voorbij is.',
    ernstig: true,
  },
  {
    sleutel: 'te_lang_bij_klant',
    label: `Bij de klant > ${WACHT_LANG_VANAF_DAGEN} dagen`,
    uitleg: 'Werk dat blijft liggen omdat er op de klant gewacht wordt.',
    ernstig: false,
  },
  {
    sleutel: 'wacht_op_goedkeuring',
    label: 'Wacht op goedkeuring',
    uitleg: 'Klaar, maar nog niet getekend.',
    ernstig: false,
  },
]

/**
 * Het kantooroverzicht: waar loopt het risico, per team.
 *
 * Vanaf supervisor (migratie 0056). De afbakening komt van de muur zelf: een
 * supervisor krijgt de rijen van zijn eigen team, een kantoorbeheerder krijgt
 * ze allemaal. Er is dus geen aparte "voor jou"- en "kantoorbrede" variant die
 * uit elkaar kan lopen.
 *
 * Dit scherm beantwoordt een andere vraag dan het workload-scherm: dáár gaat
 * het over wie vol zit, hier over wat er misloopt.
 */
export function OverzichtPage({
  navigate,
}: {
  navigate: (view: string, param?: string) => void
}) {
  const { rijen, loading, error, reload } = useKantooroverzicht()

  const totaal = useMemo(() => {
    return rijen.reduce(
      (acc, r) => ({
        open_totaal: acc.open_totaal + r.open_totaal,
        te_laat: acc.te_laat + r.te_laat,
        te_laat_wettelijk: acc.te_laat_wettelijk + r.te_laat_wettelijk,
        niemand_op: acc.niemand_op + r.niemand_op,
        niemand_op_te_laat: acc.niemand_op_te_laat + r.niemand_op_te_laat,
        te_lang_bij_klant: acc.te_lang_bij_klant + r.te_lang_bij_klant,
        wacht_op_goedkeuring: acc.wacht_op_goedkeuring + r.wacht_op_goedkeuring,
      }),
      {
        open_totaal: 0,
        te_laat: 0,
        te_laat_wettelijk: 0,
        niemand_op: 0,
        niemand_op_te_laat: 0,
        te_lang_bij_klant: 0,
        wacht_op_goedkeuring: 0,
      }
    )
  }, [rijen])

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Overzicht</h1>
        <p className="text-sm text-slate-500">
          Waar loopt het risico, per team. Je ziet de teams waar je bij kan.
        </p>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : rijen.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          Geen lopend werk op de dossiers die je kan zien.
        </p>
      ) : (
        <>
          {/* De vier getallen kantoorbreed, vóór de tabel. Dit is wat iemand
              ziet die één keer per week tien seconden kijkt. */}
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KOLOMMEN.map((kol) => {
              const waarde = totaal[kol.sleutel]
              const brandt = kol.ernstig && waarde > 0
              return (
                <div
                  key={kol.sleutel}
                  role="group"
                  aria-label={kol.label}
                  className={`rounded-lg border p-3 ${
                    brandt ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div
                    className={`text-2xl font-semibold ${
                      brandt ? 'text-red-700' : waarde > 0 ? 'text-slate-800' : 'text-slate-300'
                    }`}
                  >
                    {waarde}
                  </div>
                  <div className="text-xs font-medium text-slate-700">{kol.label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{kol.uitleg}</div>
                </div>
              )
            })}
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Team</th>
                  <th className="px-3 py-2">Open</th>
                  {KOLOMMEN.map((k) => (
                    <th key={k.sleutel} className="px-3 py-2">
                      {k.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rijen.map((r) => (
                  <tr key={r.team_id ?? 'geen-team'}>
                    <td className="px-3 py-2 font-medium text-slate-800">
                      {r.team_naam ?? 'Zonder team'}
                      {r.team_code && <span className="ml-1 text-xs text-slate-400">{r.team_code}</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{r.open_totaal}</td>
                    <td
                      className={`px-3 py-2 font-semibold ${
                        r.niemand_op_te_laat > 0 ? 'text-red-600' : 'text-slate-300'
                      }`}
                    >
                      {r.niemand_op_te_laat}
                    </td>
                    <td
                      className={`px-3 py-2 font-semibold ${
                        r.te_laat > 0 ? 'text-red-600' : 'text-slate-300'
                      }`}
                    >
                      {r.te_laat}
                      {r.te_laat_wettelijk > 0 && (
                        <span className="ml-1 text-xs font-normal text-slate-500">
                          ({r.te_laat_wettelijk} wettelijk)
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 ${r.te_lang_bij_klant > 0 ? 'text-slate-700' : 'text-slate-300'}`}>
                      {r.te_lang_bij_klant}
                    </td>
                    <td className={`px-3 py-2 ${r.wacht_op_goedkeuring > 0 ? 'text-slate-700' : 'text-slate-300'}`}>
                      {r.wacht_op_goedkeuring}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigate('kalender')}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Naar de kalender
            </button>
            {totaal.wacht_op_goedkeuring > 0 && (
              <button
                type="button"
                onClick={() => navigate('goedkeuring')}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Naar goedkeuren ({totaal.wacht_op_goedkeuring})
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
