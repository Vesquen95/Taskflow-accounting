import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDateTime } from '../lib/urgency'
import { reportError } from '../lib/errorMessage'

/** Wat `mail_status()` teruggeeft (migratie 0067). */
export interface MailStatus {
  omleiden_naar: string | null
  meldingen_aan: boolean
  weekoverzicht_aan: boolean
  ingesteld: boolean
  wachtend: number
  laatst_verzonden: string | null
  laatste_fout: string | null
  /** Het laatste antwoord van de mailfunctie (pg_net bewaart het een paar uur). */
  laatste_antwoord: { status: number | null; op: string; inhoud: string } | null
}

/**
 * De stand van het mailen, voor de kantoorbeheerder.
 *
 * Zelfde gedachte als "Automatisch onderhoud" erboven: iets dat buiten beeld
 * draait, hoort ergens te zeggen óf het draait. Een mail die niet vertrekt,
 * merkt niemand -- tot iemand een deadline mist die hij gemeld dacht te
 * krijgen.
 */
export function MailStand() {
  const [stand, setStand] = useState<MailStatus | null>(null)
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)
  const [gevraagd, setGevraagd] = useState(false)

  const laad = useCallback(async () => {
    const { data, error } = await supabase.rpc('mail_status')
    if (error) {
      setFout(reportError(error))
      return
    }
    setFout(null)
    setStand(data as MailStatus)
  }, [])

  useEffect(() => {
    void laad()
  }, [laad])

  async function stuurTest() {
    setBezig(true)
    const { error } = await supabase.rpc('mail_test_aanvragen')
    setBezig(false)
    if (error) {
      setFout(reportError(error))
      return
    }
    setGevraagd(true)
    void laad()
  }

  if (fout) {
    return (
      <section className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm">
        <h2 className="mb-1 text-sm font-semibold text-red-900">Mail</h2>
        <p className="text-red-800">{fout}</p>
      </section>
    )
  }
  if (!stand) return null

  const antwoord = stand.laatste_antwoord
  // 503 = het Gmail-wachtwoord ontbreekt nog; alles blijft netjes wachten.
  const nietIngesteld = antwoord?.status === 503
  const functieFout = antwoord !== null && antwoord.status !== null && antwoord.status >= 400 && !nietIngesteld
  const probleem = stand.laatste_fout !== null || nietIngesteld || functieFout
  return (
    <section
      className={`rounded-lg border p-4 text-sm ${probleem ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}
    >
      <h2 className="mb-1 text-sm font-semibold text-slate-800">Mail</h2>
      <ul className="space-y-0.5 text-slate-600">
        <li>
          Meldingen {stand.meldingen_aan ? 'staan aan' : 'staan uit'}, de maandagmail{' '}
          {stand.weekoverzicht_aan ? 'staat aan' : 'staat uit'}.
        </li>
        {stand.omleiden_naar && (
          <li className="text-amber-800">
            Testfase: elke mail gaat naar <strong>{stand.omleiden_naar}</strong>, met de echte ontvanger in het
            onderwerp.
          </li>
        )}
        <li>
          {stand.laatst_verzonden
            ? `Laatst verzonden: ${formatDateTime(stand.laatst_verzonden)}.`
            : 'Er is nog geen enkele mail verzonden.'}
          {stand.wachtend > 0 && ` ${stand.wachtend} ${stand.wachtend === 1 ? 'bericht wacht' : 'berichten wachten'}.`}
        </li>
      </ul>
      {nietIngesteld && (
        <p className="mt-2 text-amber-900">
          <strong>Nog niet ingesteld.</strong> Het Gmail-adres en zijn app-wachtwoord ontbreken bij de mailfunctie in
          Supabase. Tot dan wacht alles; er gaat niets verloren.
        </p>
      )}
      {functieFout && antwoord && (
        <p className="mt-1 font-mono text-xs text-amber-800">
          De mailfunctie antwoordde {antwoord.status}: {antwoord.inhoud}
        </p>
      )}
      {stand.laatste_fout && (
        <p className="mt-1 font-mono text-xs text-amber-800">Laatste fout: {stand.laatste_fout}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void stuurTest()}
          disabled={bezig}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {bezig ? 'Bezig…' : 'Stuur een testmail'}
        </button>
        {gevraagd && (
          <span role="status" className="text-xs text-slate-500">
            Gevraagd. De mail vertrekt binnen enkele minuten; kijk dan hier of er een fout staat.
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Meldingen gaan binnen enkele minuten de deur uit, gebundeld per persoon. De maandagmail vertrekt maandag
        vroeg, alleen naar wie iets openstaan heeft.
      </p>
    </section>
  )
}
