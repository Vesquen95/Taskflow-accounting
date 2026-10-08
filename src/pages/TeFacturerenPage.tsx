import { useMemo, useState } from 'react'
import { useFactuurposten } from '../hooks/useFactuurposten'
import { useTeams } from '../hooks/useTeams'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { teamLabel } from '../lib/teams'
import { reportError } from '../lib/errorMessage'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { magAfvinken, perKlant } from '../lib/facturatie'
import { FactuurpostenBlok, NieuwePostFormulier } from '../components/FactuurpostenBlok'
import type { FactuurpostStatus } from '../types'

/**
 * Te factureren: per klant wat er nog op een factuur moet (migratie 0069).
 *
 * Nog zonder bedragen. Die komen later, met de opdrachtbrief; tot dan is dit
 * de lijst die verhindert dat werk vergeten wordt aan te rekenen.
 *
 * Wie het werk deed, zet het erop (hier, of met één klik vanuit de taak).
 * Wie mag goedkeuren, vinkt af wanneer de factuur de deur uit is -- per regel
 * of alles van een klant in één keer, met het factuurnummer erbij.
 */

const TABS: { status: FactuurpostStatus; label: string }[] = [
  { status: 'te_factureren', label: 'Te factureren' },
  { status: 'gefactureerd', label: 'Gefactureerd' },
  { status: 'niet_factureren', label: 'Niet te factureren' },
]


export function TeFacturerenPage({ navigate }: { navigate: (view: string, param?: string) => void }) {
  const { employee } = useCurrentEmployee()
  const { teams } = useTeams()
  const [status, setStatus] = useState<FactuurpostStatus>('te_factureren')
  const [team, setTeam] = useState<string>('alle')
  const [zoek, setZoek] = useState('')
  const [toevoegenOpen, setToevoegenOpen] = useState(false)
  const [melding, setMelding] = useState<string | null>(null)
  const [fout, setFout] = useState<string | null>(null)
  const { posten, loading, error, reload, toevoegen, wijzigen, afhandelen } = useFactuurposten({ status, team })
  const afvinken = magAfvinken(employee)

  const groepen = useMemo(() => {
    const term = zoek.trim().toLowerCase()
    const gefilterd = term
      ? posten.filter((p) => p.client.naam.toLowerCase().includes(term) || p.omschrijving.toLowerCase().includes(term))
      : posten
    return perKlant(gefilterd)
  }, [posten, zoek])

  async function doe(actie: () => Promise<void>, gelukt: string) {
    setFout(null)
    setMelding(null)
    try {
      await actie()
      setMelding(gelukt)
    } catch (e) {
      setFout(reportError(e, 'Te factureren'))
    }
  }

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Te factureren</h1>
          <p className="text-sm text-slate-500">
            Per klant wat er nog gefactureerd moet worden. Nog zonder bedragen; die komen later met de opdrachtbrief.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setToevoegenOpen((open) => !open)}
          aria-expanded={toevoegenOpen}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Post toevoegen
        </button>
      </div>

      {toevoegenOpen && (
        <NieuwePostFormulier
          onAnnuleer={() => setToevoegenOpen(false)}
          onBewaar={(post) =>
            doe(async () => {
              await toevoegen(post)
              setToevoegenOpen(false)
            }, 'Toegevoegd aan de lijst te factureren.')
          }
        />
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Status" className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.status}
              type="button"
              role="tab"
              aria-selected={status === tab.status}
              onClick={() => setStatus(tab.status)}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                status === tab.status ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor="tf-team" className="mb-1 block text-xs font-medium text-slate-500">
            Team
          </label>
          <select
            id="tf-team"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            <option value="alle">Alle teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {teamLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tf-zoek" className="mb-1 block text-xs font-medium text-slate-500">
            Zoeken
          </label>
          <input
            id="tf-zoek"
            type="search"
            value={zoek}
            onChange={(e) => setZoek(e.target.value)}
            placeholder="Klant of omschrijving"
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
        </div>
      </div>

      {melding && (
        <p role="status" className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {melding}
        </p>
      )}
      {fout && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {fout}
        </p>
      )}

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : groepen.length === 0 ? (
        <EmptyState
          title={status === 'te_factureren' ? 'Niets te factureren' : 'Nog niets afgehandeld'}
          description={
            status === 'te_factureren'
              ? 'Zet een prestatie op de lijst met "Post toevoegen", of vanuit een taak met "Op de lijst te factureren".'
              : 'Hier komt wat afgevinkt is, met wie het deed en wanneer.'
          }
        />
      ) : (
        <div className="space-y-4">
          {groepen.map((groep) => (
            <FactuurpostenBlok
              key={groep.klant.id}
              klant={groep.klant}
              posten={groep.posten}
              status={status}
              afvinken={afvinken}
              mijnId={employee?.id ?? null}
              onOpenKlant={() => navigate('klanten', groep.klant.id)}
              onAfhandelen={(ids, nieuw, ref) =>
                doe(
                  () => afhandelen(ids, nieuw, ref),
                  nieuw === 'gefactureerd'
                    ? `${ids.length} ${ids.length === 1 ? 'post' : 'posten'} afgevinkt als gefactureerd.`
                    : nieuw === 'niet_factureren'
                      ? `${ids.length === 1 ? 'Post' : 'Posten'} op "niet te factureren" gezet.`
                      : `${ids.length === 1 ? 'Post' : 'Posten'} terug op de lijst gezet.`
                )
              }
              onWijzigen={(id, omschrijving, datum, notitie) =>
                doe(() => wijzigen(id, omschrijving, datum, notitie), 'Aangepast.')
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}
