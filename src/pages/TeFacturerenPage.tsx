import { useMemo, useState, type FormEvent } from 'react'
import { useFactuurposten } from '../hooks/useFactuurposten'
import { useClients } from '../hooks/useClients'
import { useTeams } from '../hooks/useTeams'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { teamLabel } from '../lib/teams'
import { formatDate, formatDateTime } from '../lib/urgency'
import { reportError } from '../lib/errorMessage'
import { ErrorState } from '../components/ErrorState'
import { EmptyState } from '../components/EmptyState'
import { magAfvinken, perKlant } from '../lib/facturatie'
import type { FactuurpostMetRelaties, FactuurpostStatus } from '../types'

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

function vandaag(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

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
            <KlantBlok
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

function KlantBlok({
  klant,
  posten,
  status,
  afvinken,
  mijnId,
  onOpenKlant,
  onAfhandelen,
  onWijzigen,
}: {
  klant: FactuurpostMetRelaties['client']
  posten: FactuurpostMetRelaties[]
  status: FactuurpostStatus
  afvinken: boolean
  mijnId: string | null
  onOpenKlant: () => void
  onAfhandelen: (ids: string[], status: FactuurpostStatus, ref?: string) => Promise<void>
  onWijzigen: (id: string, omschrijving: string, datum: string, notitie: string | null) => Promise<void>
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
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <button type="button" onClick={onOpenKlant} className="text-left text-sm font-semibold text-slate-900 hover:underline">
          {klant.vertrouwelijk && <span aria-label="Vertrouwelijk">🔒 </span>}
          {klant.naam}
        </button>
        <span className="text-xs text-slate-500">
          {posten.length} {posten.length === 1 ? 'post' : 'posten'}
        </span>
      </header>

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

function NieuwePostFormulier({
  onBewaar,
  onAnnuleer,
}: {
  onBewaar: (post: { clientId: string; omschrijving: string; uitgevoerdOp: string; notitie: string | null }) => Promise<void>
  onAnnuleer: () => void
}) {
  const { clients } = useClients()
  const [clientId, setClientId] = useState('')
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
      <div>
        <label htmlFor="np-klant" className="mb-1 block text-xs font-medium text-slate-500">
          Klant
        </label>
        <select
          id="np-klant"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
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
