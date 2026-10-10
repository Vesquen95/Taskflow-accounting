import { useMemo, useState } from 'react'
import { useAfgerondeTaken, MAX_AFGEROND, type AfgerondeTaak } from '../hooks/useAfgerondeTaken'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useEmployees } from '../hooks/useEmployees'
import { useTeams } from '../hooks/useTeams'
import { teamLabel } from '../lib/teams'
import { taakRegel } from '../lib/taakLabel'
import { formatDateTime } from '../lib/urgency'
import { heropenTaak, magHeropenen } from '../lib/heropenen'
import { HeropenFormulier } from '../components/HeropenFormulier'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'

/**
 * Afgerond: wat de laatste tijd afgevinkt werd (0070).
 *
 * Bedoeld om een vergissing terug te draaien. Wie te snel was, vindt de taak
 * hier terug en heropent ze; ze gaat terug naar "in uitvoering", met de reden
 * en zijn naam in de historiek. Geen archief: daarvoor is het klantdossier.
 */

const PERIODES = [
  { dagen: 7, label: 'Laatste 7 dagen' },
  { dagen: 30, label: 'Laatste 30 dagen' },
  { dagen: 90, label: 'Laatste 90 dagen' },
]

function dagenGeleden(dagen: number): string {
  const d = new Date()
  d.setDate(d.getDate() - dagen)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function AfgerondPage({ navigate }: { navigate: (view: string, param?: string) => void }) {
  const { employee } = useCurrentEmployee()
  const { employees } = useEmployees()
  const { teams } = useTeams()
  const [dagen, setDagen] = useState(30)
  const [team, setTeam] = useState('alle')
  const [wie, setWie] = useState('alle')
  const [zoek, setZoek] = useState('')
  const [heropenId, setHeropenId] = useState<string | null>(null)
  const [melding, setMelding] = useState<string | null>(null)
  const vanaf = useMemo(() => dagenGeleden(dagen), [dagen])
  const { taken, loading, error, reload } = useAfgerondeTaken({ vanaf, team, toegewezenAan: wie })

  const zichtbaar = useMemo(() => {
    const term = zoek.trim().toLowerCase()
    if (!term) return taken
    return taken.filter((t) => {
      const regel = taakRegel(t)
      return [t.client.naam, regel.naam, regel.periode ?? ''].some((s) => s.toLowerCase().includes(term))
    })
  }, [taken, zoek])

  async function heropen(taak: AfgerondeTaak, reden: string) {
    await heropenTaak(taak.id, reden)
    setHeropenId(null)
    const regel = taakRegel(taak)
    setMelding(`${taak.client.naam} — ${regel.naam}${regel.periode ? ` ${regel.periode}` : ''} is heropend en staat weer op "in uitvoering".`)
    await reload()
  }

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">Afgerond</h1>
        <p className="text-sm text-slate-500">
          Wat de laatste tijd afgerond werd. Te snel afgevinkt? Heropen de taak: ze gaat terug naar &quot;in
          uitvoering&quot;, met je reden in de historiek.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <label htmlFor="af-periode" className="mb-1 block text-xs font-medium text-slate-500">
            Afgerond
          </label>
          <select
            id="af-periode"
            value={dagen}
            onChange={(e) => setDagen(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            {PERIODES.map((p) => (
              <option key={p.dagen} value={p.dagen}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="af-team" className="mb-1 block text-xs font-medium text-slate-500">
            Team
          </label>
          <select
            id="af-team"
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
          <label htmlFor="af-wie" className="mb-1 block text-xs font-medium text-slate-500">
            Verantwoordelijke
          </label>
          <select
            id="af-wie"
            value={wie}
            onChange={(e) => setWie(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          >
            <option value="alle">Iedereen</option>
            {employee && <option value={employee.id}>Ikzelf</option>}
            {employees
              .filter((e) => e.id !== employee?.id)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.naam}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor="af-zoek" className="mb-1 block text-xs font-medium text-slate-500">
            Zoeken
          </label>
          <input
            id="af-zoek"
            type="search"
            value={zoek}
            onChange={(e) => setZoek(e.target.value)}
            placeholder="Klant of verplichting"
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
        </div>
      </div>

      {melding && (
        <p role="status" className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {melding}
        </p>
      )}

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : zichtbaar.length === 0 ? (
        <EmptyState title="Niets afgerond in deze periode" description="Kies een langere periode, of een ander team." />
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {zichtbaar.map((taak) => {
              const regel = taakRegel(taak)
              const mag = magHeropenen(taak, employee)
              return (
                <li key={taak.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-slate-800">
                        <button
                          type="button"
                          onClick={() => navigate('klanten', taak.client.id)}
                          className="font-medium hover:underline"
                        >
                          {taak.client.vertrouwelijk && <span aria-label="Vertrouwelijk">🔒 </span>}
                          {taak.client.naam}
                        </button>
                        {' — '}
                        {regel.naam}
                        {regel.periode && <span className="text-slate-500"> {regel.periode}</span>}
                      </p>
                      <p className="text-xs text-slate-400">
                        Afgerond {taak.afgerond_op ? formatDateTime(taak.afgerond_op) : ''}
                        {taak.toegewezen_medewerker && ` · verantwoordelijke ${taak.toegewezen_medewerker.naam}`}
                        {taak.goedgekeurd && ` · goedgekeurd door ${taak.goedgekeurd.naam}`}
                      </p>
                    </div>
                    {mag && heropenId !== taak.id && (
                      <button
                        type="button"
                        onClick={() => {
                          setMelding(null)
                          setHeropenId(taak.id)
                        }}
                        aria-label={`Heropenen: ${taak.client.naam} — ${regel.naam}${regel.periode ? ` ${regel.periode}` : ''}`}
                        className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                      >
                        Heropenen
                      </button>
                    )}
                  </div>
                  {heropenId === taak.id && (
                    <div className="mt-2">
                      <HeropenFormulier
                        vereistGoedkeuring={taak.vereist_goedkeuring}
                        onAnnuleer={() => setHeropenId(null)}
                        onBevestig={(reden) => heropen(taak, reden)}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {taken.length >= MAX_AFGEROND && (
            <p className="mt-2 text-xs text-slate-500">
              De {MAX_AFGEROND} recentste. Kies een kortere periode of een team om verder terug te zoeken.
            </p>
          )}
        </>
      )}
    </div>
  )
}
