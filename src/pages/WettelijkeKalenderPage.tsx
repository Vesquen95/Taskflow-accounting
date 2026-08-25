import { useState, type FormEvent } from 'react'
import { useLegalCalendar } from '../hooks/useLegalCalendar'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { ErrorState } from '../components/ErrorState'
import { formatDate } from '../lib/urgency'

/** Wettelijke-kalenderbeheer (§4 point 7, kantoorbeheerder-only): jaarlijkse
 * campagnedata + feestdagen invoeren/corrigeren, met zichtbare historie van
 * overrides — én de "Genereer taken nu" actie die de recurrence-engine
 * aanstuurt (zie de mechanisme-keuze in 0006_recurrence_engine.sql). */
export function WettelijkeKalenderPage() {
  const { employee } = useCurrentEmployee()
  const { obligationTypes } = useObligationTypes()
  const { entries, holidays, loading, error, reload, addEntry, addHoliday, generateTaskInstances } = useLegalCalendar()

  const [genResult, setGenResult] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [obligationTypeId, setObligationTypeId] = useState('')
  const [jaar, setJaar] = useState(new Date().getFullYear() + 1)
  const [scope, setScope] = useState('')
  const [deadline, setDeadline] = useState('')
  const [isOverride, setIsOverride] = useState(false)
  const [bron, setBron] = useState('')

  const [holidayJaar, setHolidayJaar] = useState(new Date().getFullYear() + 1)
  const [holidayDatum, setHolidayDatum] = useState('')
  const [holidayOmschrijving, setHolidayOmschrijving] = useState('')

  async function handleGenerate() {
    setGenBusy(true)
    setGenResult(null)
    try {
      const created = await generateTaskInstances()
      setGenResult(`${created} nieuwe taakinstantie(s) aangemaakt.`)
    } catch (err) {
      setGenResult(err instanceof Error ? `Fout: ${err.message}` : 'Genereren is mislukt.')
    } finally {
      setGenBusy(false)
    }
  }

  async function handleAddEntry(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!employee || !obligationTypeId || !deadline) {
      setFormError('Vul type, jaar en datum in.')
      return
    }
    try {
      await addEntry({
        obligation_type_id: obligationTypeId,
        jaar,
        scope: scope.trim() || null,
        deadline_datum: deadline,
        is_override: isOverride,
        bron: bron.trim() || null,
        actorId: employee.id,
      })
      setDeadline('')
      setBron('')
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Toevoegen is mislukt.')
    }
  }

  async function handleAddHoliday(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!employee || !holidayDatum || !holidayOmschrijving.trim()) {
      setFormError('Vul datum en omschrijving in.')
      return
    }
    try {
      await addHoliday({ jaar: holidayJaar, datum: holidayDatum, omschrijving: holidayOmschrijving.trim(), actorId: employee.id })
      setHolidayDatum('')
      setHolidayOmschrijving('')
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Toevoegen is mislukt.')
    }
  }

  if (error) {
    return (
      <div className="p-6">
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Wettelijke kalender</h1>
        <p className="text-sm text-slate-500">
          Jaarlijkse campagnedata en feestdagen zijn hier bewust bewerkbare data, geen hardcoded logica — jaarlijks bij te
          werken door de kantoorbeheerder.
        </p>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Taakgeneratie</h2>
        <p className="mb-3 text-xs text-slate-500">
          Er is in deze build geen scheduler/cron actief — genereer nieuwe taakinstanties (rollende horizon van 3 maanden
          vooruit, 6 maanden backfill) hier expliciet. Idempotent: veilig om herhaaldelijk te draaien.
        </p>
        <button
          type="button"
          disabled={genBusy}
          onClick={handleGenerate}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        >
          {genBusy ? 'Bezig…' : 'Genereer taken nu'}
        </button>
        {genResult && <p className="mt-2 text-sm text-slate-600">{genResult}</p>}
      </section>

      {formError && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </p>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Campagnedata (legal_calendar)</h2>
        <form onSubmit={handleAddEntry} className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Type</label>
            <select value={obligationTypeId} onChange={(e) => setObligationTypeId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5">
              <option value="">— kies —</option>
              {obligationTypes
                .filter((ot) => ot.deadline_mechanisme === 'jaarlijkse_kalender')
                .map((ot) => (
                  <option key={ot.id} value={ot.id}>
                    {ot.naam}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Jaar</label>
            <input type="number" value={jaar} onChange={(e) => setJaar(Number(e.target.value))} className="w-24 rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Scope (optioneel)</label>
            <input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="bv. boekjaar_12"
              className="w-36 rounded-md border border-slate-300 px-2 py-1.5"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Deadline</label>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Bron</label>
            <input value={bron} onChange={(e) => setBron(e.target.value)} placeholder="bv. FOD Financiën bericht" className="w-40 rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <label className="flex items-center gap-1.5 pb-1.5 text-slate-600">
            <input type="checkbox" checked={isOverride} onChange={(e) => setIsOverride(e.target.checked)} />
            Correctie (override)
          </label>
          <button type="submit" className="rounded-md bg-slate-800 px-3 py-1.5 font-medium text-white hover:bg-slate-900">
            Toevoegen
          </button>
        </form>

        {loading ? (
          <p className="text-sm text-slate-400">Laden…</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Jaar</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2">Deadline</th>
                  <th className="px-3 py-2">Override?</th>
                  <th className="px-3 py-2">Bron</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 text-slate-700">{obligationTypes.find((ot) => ot.id === e.obligation_type_id)?.naam ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{e.jaar}</td>
                    <td className="px-3 py-2 text-slate-600">{e.scope ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-800">{formatDate(e.deadline_datum)}</td>
                    <td className="px-3 py-2">
                      {e.is_override ? (
                        <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Override</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{e.bron ?? '—'}</td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                      Nog geen campagnedata ingevoerd.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Feestdagen (public_holidays)</h2>
        <form onSubmit={handleAddHoliday} className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Jaar</label>
            <input type="number" value={holidayJaar} onChange={(e) => setHolidayJaar(Number(e.target.value))} className="w-24 rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Datum</label>
            <input type="date" value={holidayDatum} onChange={(e) => setHolidayDatum(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Omschrijving</label>
            <input value={holidayOmschrijving} onChange={(e) => setHolidayOmschrijving(e.target.value)} className="w-48 rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <button type="submit" className="rounded-md bg-slate-800 px-3 py-1.5 font-medium text-white hover:bg-slate-900">
            Toevoegen
          </button>
        </form>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Datum</th>
                <th className="px-3 py-2">Omschrijving</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {holidays.map((h) => (
                <tr key={h.id}>
                  <td className="px-3 py-2 text-slate-800">{formatDate(h.datum)}</td>
                  <td className="px-3 py-2 text-slate-600">{h.omschrijving}</td>
                </tr>
              ))}
              {holidays.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-3 py-4 text-center text-slate-400">
                    Nog geen feestdagen ingevoerd.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
