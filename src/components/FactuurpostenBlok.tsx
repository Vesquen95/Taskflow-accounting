import { useState, type FormEvent } from 'react'
import { useClients } from '../hooks/useClients'
import { formatDate, formatDateTime } from '../lib/urgency'
import { vandaag } from '../lib/facturatie'
import type { FactuurpostMetRelaties, FactuurpostStatus } from '../types'

/**
 * De bouwstenen van "te factureren" (migratie 0069): het blok met de posten
 * van één klant, één regel, en het formulier om een post toe te voegen.
 * Gedeeld door het scherm Te factureren en het klantdossier, zodat een post
 * er op beide plaatsen hetzelfde uitziet en hetzelfde doet.
 */

export function FactuurpostenBlok({
  klant,
  posten,
  status,
  afvinken,
  mijnId,
  onOpenKlant,
  onAfhandelen,
  onWijzigen,
  toonKop = true,
}: {
  klant: FactuurpostMetRelaties['client']
  posten: FactuurpostMetRelaties[]
  status: FactuurpostStatus
  afvinken: boolean
  mijnId: string | null
  onOpenKlant: () => void
  onAfhandelen: (ids: string[], status: FactuurpostStatus, ref?: string) => Promise<void>
  onWijzigen: (id: string, omschrijving: string, datum: string, notitie: string | null) => Promise<void>
  /** In het klantdossier staat de klant al bovenaan; daar geen eigen kop. */
  toonKop?: boolean
}) {
  const [gekozen, setGekozen] = useState<Set<string>>(new Set())
  const [referentie, setReferentie] = useState('')
  const open = status === 'te_factureren'
  const doel = gekozen.size > 0 ? [...gekozen] : posten.map((p) => p.id)

  function wissel(id: string) {
    setGekozen((oud) => {
      const nieuw = new Set(oud)
      if (nieuw.has(id)) nieuw.delete(id)
      else nieuw.add(id)
      return nieuw
    })
  }

  return (
    <section aria-label={klant.naam} className="rounded-lg border border-slate-200 bg-white">
      {toonKop && (
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <button type="button" onClick={onOpenKlant} className="text-left text-sm font-semibold text-slate-900 hover:underline">
          {klant.vertrouwelijk && <span aria-label="Vertrouwelijk">🔒 </span>}
          {klant.naam}
        </button>
        <span className="text-xs text-slate-500">
          {posten.length} {posten.length === 1 ? 'post' : 'posten'}
        </span>
      </header>
      )}

      <ul className="divide-y divide-slate-100">
        {posten.map((post) => (
          <PostRegel
            key={post.id}
            post={post}
            open={open}
            afvinken={afvinken}
            mag_aanpassen={open && (afvinken || post.aangemaakt_door === mijnId)}
            gekozen={gekozen.has(post.id)}
            onKies={() => wissel(post.id)}
            onAfhandelen={(nieuw) => onAfhandelen([post.id], nieuw)}
            onWijzigen={onWijzigen}
          />
        ))}
      </ul>

      {open && afvinken && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2.5">
          <label htmlFor={`ref-${klant.id}`} className="sr-only">
            Factuurnummer voor {klant.naam}
          </label>
          <input
            id={`ref-${klant.id}`}
            value={referentie}
            onChange={(e) => setReferentie(e.target.value)}
            placeholder="Factuurnummer (optioneel)"
            maxLength={100}
            className="w-48 rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
          <button
            type="button"
            onClick={() =>
              void onAfhandelen(doel, 'gefactureerd', referentie).then(() => {
                setGekozen(new Set())
                setReferentie('')
              })
            }
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {gekozen.size > 0
              ? `${gekozen.size} geselecteerd als gefactureerd`
              : posten.length === 1
                ? 'Gefactureerd'
                : `Alle ${posten.length} gefactureerd`}
          </button>
        </footer>
      )}
    </section>
  )
}

function PostRegel({
  post,
  open,
  afvinken,
  mag_aanpassen,
  gekozen,
  onKies,
  onAfhandelen,
  onWijzigen,
}: {
  post: FactuurpostMetRelaties
  open: boolean
  afvinken: boolean
  mag_aanpassen: boolean
  gekozen: boolean
  onKies: () => void
  onAfhandelen: (status: FactuurpostStatus) => Promise<void>
  onWijzigen: (id: string, omschrijving: string, datum: string, notitie: string | null) => Promise<void>
}) {
  const [bewerken, setBewerken] = useState(false)
  const [omschrijving, setOmschrijving] = useState(post.omschrijving)
  const [datum, setDatum] = useState(post.uitgevoerd_op)
  const [notitie, setNotitie] = useState(post.notitie ?? '')

  if (bewerken) {
    return (
      <li className="space-y-2 px-4 py-3">
        <input
          aria-label="Omschrijving"
          value={omschrijving}
          onChange={(e) => setOmschrijving(e.target.value)}
          maxLength={300}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Datum van de prestatie"
            type="date"
            value={datum}
            onChange={(e) => setDatum(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
          <input
            aria-label="Notitie"
            value={notitie}
            onChange={(e) => setNotitie(e.target.value)}
            maxLength={1000}
            placeholder="Notitie (optioneel)"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!omschrijving.trim() || !datum}
            onClick={() => void onWijzigen(post.id, omschrijving, datum, notitie || null).then(() => setBewerken(false))}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Bewaren
          </button>
          <button
            type="button"
            onClick={() => setBewerken(false)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Annuleren
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-2.5 text-sm">
      {open && afvinken && (
        <input
          type="checkbox"
          checked={gekozen}
          onChange={onKies}
          aria-label={`Selecteer ${post.omschrijving}`}
          className="mt-1"
        />
      )}
      <span className="w-20 shrink-0 tabular-nums text-slate-500">{formatDate(post.uitgevoerd_op)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-slate-800">
          {post.omschrijving}
          {post.task_instance_id && (
            <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">taak</span>
          )}
        </p>
        {post.notitie && <p className="text-xs text-slate-500">{post.notitie}</p>}
        <p className="text-xs text-slate-400">
          Opgenomen door {post.aangemaakt?.naam ?? 'onbekend'}
          {!open && post.afgehandeld_op && (
            <>
              {' · '}
              {post.status === 'gefactureerd' ? 'gefactureerd' : 'niet te factureren'} door{' '}
              {post.afgehandeld?.naam ?? 'onbekend'} op {formatDateTime(post.afgehandeld_op)}
              {post.factuurreferentie && ` · factuur ${post.factuurreferentie}`}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-3 text-xs font-medium">
        {mag_aanpassen && (
          <button type="button" onClick={() => setBewerken(true)} className="text-slate-500 hover:text-slate-900">
            Aanpassen
          </button>
        )}
        {open && afvinken && (
          <button
            type="button"
            onClick={() => void onAfhandelen('niet_factureren')}
            className="text-slate-500 hover:text-red-700"
          >
            Niet factureren
          </button>
        )}
        {!open && afvinken && (
          <button
            type="button"
            onClick={() => void onAfhandelen('te_factureren')}
            className="text-slate-500 hover:text-slate-900"
          >
            Terugzetten
          </button>
        )}
      </div>
    </li>
  )
}

export function NieuwePostFormulier({
  onBewaar,
  onAnnuleer,
  clientId: vasteKlant,
}: {
  onBewaar: (post: { clientId: string; omschrijving: string; uitgevoerdOp: string; notitie: string | null }) => Promise<void>
  onAnnuleer: () => void
  /** Vanuit het klantdossier ligt de klant vast: geen keuzelijst. */
  clientId?: string
}) {
  const [clientId, setClientId] = useState(vasteKlant ?? '')
  const [omschrijving, setOmschrijving] = useState('')
  const [uitgevoerdOp, setUitgevoerdOp] = useState(vandaag())
  const [notitie, setNotitie] = useState('')
  const [bezig, setBezig] = useState(false)

  async function verstuur(e: FormEvent) {
    e.preventDefault()
    if (!clientId || !omschrijving.trim()) return
    setBezig(true)
    await onBewaar({ clientId, omschrijving, uitgevoerdOp, notitie: notitie.trim() || null })
    setBezig(false)
  }

  return (
    <form
      onSubmit={verstuur}
      aria-label="Nieuwe post"
      className="mb-5 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2"
    >
      {!vasteKlant && <KlantKeuze value={clientId} onChange={setClientId} />}
      <div>
        <label htmlFor="np-datum" className="mb-1 block text-xs font-medium text-slate-500">
          Datum van de prestatie
        </label>
        <input
          id="np-datum"
          type="date"
          value={uitgevoerdOp}
          onChange={(e) => setUitgevoerdOp(e.target.value)}
          required
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
        />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="np-omschrijving" className="mb-1 block text-xs font-medium text-slate-500">
          Omschrijving
        </label>
        <input
          id="np-omschrijving"
          value={omschrijving}
          onChange={(e) => setOmschrijving(e.target.value)}
          maxLength={300}
          required
          placeholder="bv. Bijkomend advies herstructurering"
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
        />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="np-notitie" className="mb-1 block text-xs font-medium text-slate-500">
          Notitie (optioneel)
        </label>
        <input
          id="np-notitie"
          value={notitie}
          onChange={(e) => setNotitie(e.target.value)}
          maxLength={1000}
          placeholder="bv. 2 uur, telefonisch overleg met de klant"
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
        />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={bezig || !clientId || !omschrijving.trim()}
          className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {bezig ? 'Bezig…' : 'Op de lijst zetten'}
        </button>
        <button type="button" onClick={onAnnuleer} className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">
          Annuleren
        </button>
      </div>
    </form>
  )
}

/** Apart, zodat de klantenlijst alleen opgehaald wordt waar er gekozen moet worden. */
function KlantKeuze({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { clients } = useClients()
  return (
    <div>
      <label htmlFor="np-klant" className="mb-1 block text-xs font-medium text-slate-500">
        Klant
      </label>
      <select
        id="np-klant"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
      >
        <option value="">— kies een klant —</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.naam}
          </option>
        ))}
      </select>
    </div>
  )
}
