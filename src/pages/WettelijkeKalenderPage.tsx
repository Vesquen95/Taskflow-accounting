import { useCallback, useState, type FormEvent } from 'react'
import { useLegalCalendar } from '../hooks/useLegalCalendar'
import { useObligationTypes } from '../hooks/useObligationTypes'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { useEmployees } from '../hooks/useEmployees'
import { ErrorState } from '../components/ErrorState'
import { Modal } from '../components/Modal'
import { formatDate } from '../lib/urgency'
import { dekkingStatus } from '../lib/feestdagen'
import { reportError } from '../lib/errorMessage'
import type { PublicHoliday } from '../types'

/** Wettelijke-kalenderbeheer (§4 point 7, kantoorbeheerder-only): jaarlijkse
 * campagnedata + feestdagen invoeren/corrigeren, met zichtbare historie van
 * overrides — én de "Genereer taken nu" actie die de recurrence-engine
 * aanstuurt (zie de mechanisme-keuze in 0006_recurrence_engine.sql). */
export function WettelijkeKalenderPage() {
  const { employee } = useCurrentEmployee()
  const { obligationTypes } = useObligationTypes()
  const { employees } = useEmployees()
  const { entries, holidays, loading, error, reload, addEntry, addHoliday, retractHoliday, generateTaskInstances, laadFeestdagen } =
    useLegalCalendar()
  const isKantoorbeheerder = employee?.rol === 'kantoorbeheerder'

  const [genResult, setGenResult] = useState<string | null>(null)
  const [genFailed, setGenFailed] = useState(false)
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

  const [laadBusy, setLaadBusy] = useState(false)
  const [laadResultaat, setLaadResultaat] = useState<string | null>(null)
  const [laadFout, setLaadFout] = useState(false)

  const [retractTarget, setRetractTarget] = useState<PublicHoliday | null>(null)
  const [retractReden, setRetractReden] = useState('')
  const [retractBusy, setRetractBusy] = useState(false)
  const [retractError, setRetractError] = useState<string | null>(null)

  // Stabiele identiteit: Modal focust bij elke wijziging van `onClose` de
  // sluitknop opnieuw. Met een inline closure zou dat bij élke toetsaanslag
  // in het redenveld gebeuren — de focus springt dan uit het tekstvak en een
  // spatie activeert de sluitknop.
  const closeRetract = useCallback(() => {
    setRetractTarget(null)
    setRetractError(null)
  }, [])

  function employeeNaam(id: string | null): string {
    if (!id) return 'onbekend'
    return employees.find((e) => e.id === id)?.naam ?? 'onbekend'
  }

  async function handleRetract(e: FormEvent) {
    e.preventDefault()
    if (!retractTarget) return
    if (retractReden.trim().length === 0) {
      setRetractError('Geef een reden op — die blijft als correctiehistoriek bewaard.')
      return
    }
    setRetractBusy(true)
    setRetractError(null)
    try {
      await retractHoliday({ holidayId: retractTarget.id, reden: retractReden })
      setRetractTarget(null)
      setRetractReden('')
    } catch (err) {
      setRetractError(reportError(err, 'Intrekken van de feestdag is mislukt'))
    } finally {
      setRetractBusy(false)
    }
  }

  async function handleGenerate() {
    setGenBusy(true)
    setGenResult(null)
    setGenFailed(false)
    try {
      const created = await generateTaskInstances()
      setGenResult(`${created} nieuwe taakinstantie(s) aangemaakt.`)
    } catch (err) {
      setGenFailed(true)
      setGenResult(reportError(err, 'Genereren is mislukt'))
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
      setFormError(reportError(err, 'Toevoegen van de kalenderdatum is mislukt'))
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
      setFormError(reportError(err, 'Toevoegen van de feestdag is mislukt'))
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
        {genResult && (
          <p
            role={genFailed ? 'alert' : undefined}
            className={
              genFailed
                ? 'mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700'
                : 'mt-2 text-sm text-slate-600'
            }
          >
            {genResult}
          </p>
        )}
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

        <FeestdagenDekking
          holidays={holidays}
          isKantoorbeheerder={isKantoorbeheerder}
          busy={laadBusy}
          resultaat={laadResultaat}
          fout={laadFout}
          onLaden={async (van, tot) => {
            setLaadBusy(true)
            setLaadFout(false)
            setLaadResultaat(null)
            try {
              const n = await laadFeestdagen(van, tot)
              setLaadResultaat(
                n === 0
                  ? 'De kalender was al volledig; er is niets toegevoegd.'
                  : `${n} feestdagen toegevoegd (${van}\u2013${tot}). Deadlines die op een feestdag stonden zijn meteen verschoven.`
              )
            } catch (err) {
              setLaadFout(true)
              setLaadResultaat(reportError(err, 'De feestdagen konden niet geladen worden'))
            } finally {
              setLaadBusy(false)
            }
          }}
        />

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
        <p className="mb-2 text-xs text-slate-500">
          Een foutieve feestdag wordt niet overschreven of verwijderd, maar <strong>ingetrokken</strong> met een reden —
          de correctie herberekent meteen alle open deadlines en blijft zichtbaar in de historiek. De juiste datum voer je
          daarna als nieuwe rij in.
        </p>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Datum</th>
                <th className="px-3 py-2">Omschrijving</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Acties</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {holidays.map((h) => (
                <tr key={h.id} className={h.ingetrokken ? 'bg-slate-50 text-slate-400' : undefined}>
                  <td className={`px-3 py-2 ${h.ingetrokken ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                    {formatDate(h.datum)}
                  </td>
                  <td className={`px-3 py-2 ${h.ingetrokken ? 'text-slate-400 line-through' : 'text-slate-600'}`}>
                    {h.omschrijving}
                  </td>
                  <td className="px-3 py-2">
                    {h.ingetrokken ? (
                      <span className="text-xs text-slate-500">
                        Ingetrokken door {employeeNaam(h.ingetrokken_door)}
                        {h.ingetrokken_op ? ` op ${formatDate(h.ingetrokken_op)}` : ''}
                        {h.ingetrokken_reden ? ` — ${h.ingetrokken_reden}` : ''}
                      </span>
                    ) : (
                      <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
                        Actief
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!h.ingetrokken && isKantoorbeheerder && (
                      <button
                        type="button"
                        onClick={() => {
                          setRetractTarget(h)
                          setRetractReden('')
                          setRetractError(null)
                        }}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Intrekken
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {holidays.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-slate-400">
                    Nog geen feestdagen ingevoerd.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {retractTarget && (
          <Modal
            title={`Feestdag intrekken — ${formatDate(retractTarget.datum)}`}
            onClose={closeRetract}
          >
            <form onSubmit={handleRetract} className="space-y-3 text-sm">
              <p className="text-slate-600">
                {retractTarget.omschrijving} wordt ingetrokken en telt niet langer mee bij het doorschuiven van
                deadlines. Alle open taken worden meteen herberekend en elke verschuiving wordt gelogd. De rij blijft
                zichtbaar in de historiek.
              </p>
              <div>
                <label htmlFor="retract-reden" className="mb-1 block text-xs font-medium text-slate-500">
                  Reden (verplicht)
                </label>
                <textarea
                  id="retract-reden"
                  value={retractReden}
                  onChange={(ev) => setRetractReden(ev.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5"
                  placeholder="bv. Verkeerde datum ingevoerd; correcte datum wordt opnieuw toegevoegd."
                />
              </div>
              {retractError && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {retractError}
                </p>
              )}
              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={closeRetract}
                  className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  disabled={retractBusy}
                  className="rounded-md bg-slate-800 px-3 py-1.5 font-medium text-white hover:bg-slate-900 disabled:opacity-60"
                >
                  {retractBusy ? 'Bezig…' : 'Feestdag intrekken'}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </section>
    </div>
  )
}

/**
 * Waarschuwt wanneer de feestdagenkalender achterloopt op de generatiehorizon.
 *
 * Zonder dit blok is dat onzichtbaar: de motor rekent gewoon door en verschuift
 * voorbij het laatste ingevoerde jaar alleen nog op weekends. Zo belandde een
 * algemene vergadering op 1 januari 2029. De fout zat niet in de berekening
 * maar in de stilte eromheen -- vandaar dat dit hier staat, en niet pas in een
 * foutmelding achteraf.
 */
function FeestdagenDekking({
  holidays,
  isKantoorbeheerder,
  busy,
  resultaat,
  fout,
  onLaden,
}: {
  holidays: PublicHoliday[]
  isKantoorbeheerder: boolean
  busy: boolean
  resultaat: string | null
  fout: boolean
  onLaden: (vanJaar: number, totJaar: number) => Promise<void>
}) {
  const { dekkingTot, horizonTot, tekort } = dekkingStatus(holidays)
  const vanaf = dekkingTot > 0 ? dekkingTot + 1 : new Date().getFullYear()
  // Ruim over de horizon heen laden, zodat dit niet elk jaar terugkomt.
  const tot = horizonTot + 3

  return (
    <div
      className={`mb-3 rounded-lg border p-3 text-sm ${
        tekort > 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      {tekort > 0 ? (
        <>
          <p className="font-medium text-amber-900">
            De feestdagenkalender loopt tot {dekkingTot || 'nergens'}, de taakgeneratie tot {horizonTot}.
          </p>
          <p className="mt-1 text-amber-800">
            Voor de {tekort === 1 ? 'ontbrekende jaargang' : `${tekort} ontbrekende jaargangen`} verschuiven deadlines
            alleen nog op weekends, niet op feestdagen. Een deadline kan dan op Nieuwjaar of 21 juli terechtkomen.
          </p>
        </>
      ) : (
        <p className="text-slate-600">
          Feestdagenkalender volledig tot en met {dekkingTot}; de taakgeneratie loopt tot {horizonTot}.
        </p>
      )}

      {isKantoorbeheerder && tekort > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onLaden(vanaf, tot)}
          className="mt-2 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
        >
          {busy ? 'Bezig\u2026' : `Feestdagen ${vanaf}\u2013${tot} aanvullen`}
        </button>
      )}

      {resultaat && (
        <p
          role={fout ? 'alert' : 'status'}
          className={`mt-2 text-xs ${fout ? 'text-red-700' : 'text-slate-600'}`}
        >
          {resultaat}
        </p>
      )}
    </div>
  )
}
