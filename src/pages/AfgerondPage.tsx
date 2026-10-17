import { useEffect, useMemo, useState } from 'react'
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
import { isoDatum } from '../lib/werkstromen'
import { factuurstandVoorTaken, zetTaakOpFactuurlijst } from '../lib/factuurlijst'
import { reportError } from '../lib/errorMessage'
import type { FactuurpostStatus } from '../types'

/**
 * Afgerond: wat de laatste tijd afgevinkt werd (0070).
 *
 * Bedoeld om een vergissing terug te draaien. Wie te snel was, vindt de taak
 * hier terug en heropent ze; ze gaat terug naar "in uitvoering", met de reden
 * en zijn naam in de historiek. Geen archief: daarvoor is het klantdossier.
 *
 * En om niets te vergeten aan te rekenen: per taak staat erbij of ze op de
 * lijst te factureren staat. Zo niet, dan kan het hier met één klik, en een
 * filter toont alleen wat er nog niet op staat.
 */

const FACTUURSTAND: Record<FactuurpostStatus, { label: string; klasse: string }> = {
  te_factureren: { label: 'Op de lijst te factureren', klasse: 'border-purple-300 bg-purple-50 text-purple-800' },
  gefactureerd: { label: 'Gefactureerd', klasse: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  niet_factureren: { label: 'Niet te factureren', klasse: 'border-slate-300 bg-slate-50 text-slate-600' },
}

const PERIODES = [
  { dagen: 7, label: 'Laatste 7 dagen' },
  { dagen: 30, label: 'Laatste 30 dagen' },
  { dagen: 90, label: 'Laatste 90 dagen' },
]

function dagenGeleden(dagen: number): string {
  const d = new Date()
  d.setDate(d.getDate() - dagen)
  return isoDatum(d)
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
  const [fout, setFout] = useState<string | null>(null)
  const [alleenNietGefactureerd, setAlleenNietGefactureerd] = useState(false)
  const [standen, setStanden] = useState<Map<string, FactuurpostStatus>>(new Map())
  const [bezigMet, setBezigMet] = useState<string | null>(null)
  const vanaf = useMemo(() => dagenGeleden(dagen), [dagen])
  const { taken, loading, error, reload } = useAfgerondeTaken({ vanaf, team, toegewezenAan: wie })

  // Eén vraag voor de hele lijst: welke taken staan op de factuurlijst?
  // Lukt dat niet, dan toont de lijst gewoon geen factuurstand.
  useEffect(() => {
    let actief = true
    factuurstandVoorTaken(taken.map((t) => t.id))
      .then((s) => actief && setStanden(s))
      .catch(() => actief && setStanden(new Map()))
    return () => {
      actief = false
    }
  }, [taken])

  async function zetOpLijst(taak: AfgerondeTaak) {
    setMelding(null)
    setFout(null)
    setBezigMet(taak.id)
    try {
      await zetTaakOpFactuurlijst(taak)
      setStanden((s) => new Map(s).set(taak.id, 'te_factureren'))
      setMelding(`${taak.client.naam} staat op de lijst te factureren.`)
    } catch (e) {
      setFout(reportError(e, 'Op de lijst te factureren'))
    } finally {
      setBezigMet(null)
    }
  }

  const zichtbaar = useMemo(() => {
    const term = zoek.trim().toLowerCase()
    return taken.filter((t) => {
      if (alleenNietGefactureerd && standen.has(t.id)) return false
      if (!term) return true
      const regel = taakRegel(t)
      return [t.client.naam, regel.naam, regel.periode ?? ''].some((s) => s.toLowerCase().includes(term))
    })
  }, [taken, zoek, alleenNietGefactureerd, standen])

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
        <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={alleenNietGefactureerd}
            onChange={(e) => setAlleenNietGefactureerd(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Alleen wat nog niet op de factuurlijst staat
        </label>
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
      ) : zichtbaar.length === 0 ? (
        <EmptyState
          title={alleenNietGefactureerd ? 'Alles staat op de factuurlijst' : 'Niets afgerond in deze periode'}
          description={
            alleenNietGefactureerd
              ? 'Elke afgeronde taak in deze periode staat al op de lijst te factureren, of werd afgehandeld.'
              : 'Kies een langere periode, of een ander team.'
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {zichtbaar.map((taak) => {
              const regel = taakRegel(taak)
              const mag = magHeropenen(taak, employee)
              return (
                <li key={taak.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-[14rem] flex-1">
                      <p className="text-slate-800">
                        <button
                          type="button"
                          onClick={() => navigate('klanten', taak.client.id)}
                          className="text-left font-medium hover:underline"
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
                    <div className="flex shrink-0 items-center gap-2">
                      {standen.has(taak.id) ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${FACTUURSTAND[standen.get(taak.id)!].klasse}`}
                        >
                          {FACTUURSTAND[standen.get(taak.id)!].label}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={bezigMet === taak.id}
                          onClick={() => void zetOpLijst(taak)}
                          aria-label={`Te factureren: ${taak.client.naam} — ${regel.naam}${regel.periode ? ` ${regel.periode}` : ''}`}
                          className="rounded-md border border-purple-300 bg-white px-3 py-1.5 text-xs font-medium text-purple-800 hover:bg-purple-50 disabled:opacity-50"
                        >
                          {bezigMet === taak.id ? 'Bezig…' : 'Te factureren'}
                        </button>
                      )}
                      {mag && heropenId !== taak.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setMelding(null)
                            setHeropenId(taak.id)
                          }}
                          aria-label={`Heropenen: ${taak.client.naam} — ${regel.naam}${regel.periode ? ` ${regel.periode}` : ''}`}
                          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                        >
                          Heropenen
                        </button>
                      )}
                    </div>
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
