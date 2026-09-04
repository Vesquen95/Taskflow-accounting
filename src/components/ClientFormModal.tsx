import { useEffect, useState, type FormEvent } from 'react'
import { Modal } from './Modal'
import type { BtwFrequentie, BtwRegime, Client, Employee, ObligationType, Klantsoort } from '../types'
import { reportError } from '../lib/errorMessage'
import { ObligationPicker } from './ObligationPicker'
import { useTeams } from '../hooks/useTeams'
import { collegasVoorDossier, teamLabel, teamsVan } from '../lib/teams'
import { legeSelecties, type ObligationSelection } from '../lib/clientObligations'
import { omschrijfOpenstaandeTaken } from '../lib/klantArchief'

const RECHTSVORMEN = ['BV', 'NV', 'CommV', 'VOF', 'VZW', 'Eenmanszaak', 'Coöperatieve vennootschap', 'Andere']

export interface ClientFormValues {
  naam: string
  ondernemingsnummer: string
  rechtsvorm: string
  boekjaar_einde_maand: number
  boekjaar_einde_dag: number
  btw_regime: BtwRegime
  btw_aangifte_frequentie: BtwFrequentie | ''
  mandataris: boolean
  vertrouwelijk: boolean
  standaard_verantwoordelijke_id: string
  team_id: string
  klantsoort: Klantsoort
  actief: boolean
  /** Alle verplichtingen die het kantoor voor deze klant doet, in één keer
   *  ingevuld -- zie docs/PLAN.md §10. */
  obligations: ObligationSelection[]
}

function toFormValues(
  client: Client | null,
  obligationTypes: ObligationType[],
  bestaandeSelecties: ObligationSelection[]
): ClientFormValues {
  return {
    naam: client?.naam ?? '',
    ondernemingsnummer: client?.ondernemingsnummer ?? '',
    rechtsvorm: client?.rechtsvorm ?? '',
    boekjaar_einde_maand: client?.boekjaar_einde_maand ?? 12,
    boekjaar_einde_dag: client?.boekjaar_einde_dag ?? 31,
    btw_regime: client?.btw_regime ?? 'geen',
    btw_aangifte_frequentie: client?.btw_aangifte_frequentie ?? '',
    mandataris: client?.mandataris ?? false,
    vertrouwelijk: client?.vertrouwelijk ?? false,
    standaard_verantwoordelijke_id: client?.standaard_verantwoordelijke_id ?? '',
    team_id: client?.team_id ?? '',
    klantsoort: client?.klantsoort ?? 'rechtspersoon',
    actief: client?.actief ?? true,
    obligations: legeSelecties(obligationTypes).map((leeg) => {
      const bestaand = bestaandeSelecties.find((b) => b.obligation_type_id === leeg.obligation_type_id)
      return bestaand ?? leeg
    }),
  }
}

export function ClientFormModal({
  client,
  employees,
  obligationTypes,
  bestaandeVerplichtingen = [],
  openstaandeTaken,
  huidigeMedewerker,
  onClose,
  onSubmit,
}: {
  client: Client | null
  employees: Employee[]
  obligationTypes: ObligationType[]
  bestaandeVerplichtingen?: ObligationSelection[]
  /** Wie dit formulier openheeft. Bepaalt of het teamveld leeggemaakt mag
   *  worden: een dossier zonder team is voor het hele kantoor zichtbaar, en
   *  sinds migratie 0045 mag alleen een kantoorbeheerder dat nog. Weggelaten
   *  = de voorzichtige kant. */
  huidigeMedewerker?: Employee | null
  /** Hoeveel taken er geannuleerd worden als "Actief" hier uitgevinkt wordt.
   *  Zonder dit getal blijft het vinkje een stille archivering. */
  openstaandeTaken?: number
  onClose: () => void
  onSubmit: (values: ClientFormValues) => Promise<void>
}) {
  const [values, setValues] = useState<ClientFormValues>(
    toFormValues(client, obligationTypes, bestaandeVerplichtingen)
  )

  const { teams, leden } = useTeams()

  // Wat het teamveld mag aanbieden.
  //
  // De databank weigert twee dingen sinds 0045, en een keuzelijst die ze toch
  // toont, is een knop die faalt bij het opslaan:
  //
  //  1. Het team van een bestaand dossier weghalen mag alleen een
  //     kantoorbeheerder -- zonder team ziet het hele kantoor het dossier.
  //  2. Een dossier verhuizen naar een team waar je zelf niet in zit, lukt
  //     sowieso niet: het gewijzigde dossier valt dan buiten je eigen bereik
  //     en RLS weigert de rij. Dat is geen aparte controle maar een gevolg
  //     van de policy zelf.
  //
  // Bij een NIEUW dossier geldt geen van beide: dat mag je zonder team of voor
  // een ander team aanmaken.
  const bestaandTeam = client?.team_id ?? null
  const isBeheerder = huidigeMedewerker?.rol === 'kantoorbeheerder'
  const magTeamLeegmaken = !bestaandTeam || isBeheerder
  const eigenTeams = teamsVan(leden, huidigeMedewerker?.id)
  const kiesbareTeams =
    !bestaandTeam || isBeheerder
      ? teams
      : teams.filter((t) => eigenTeams.includes(t.id) || t.id === bestaandTeam)

  // De keuzelijst met collega's volgt het team van het dossier: met zes teams
  // is een lijst van iedereen een lijst waarin je de verkeerde aanklikt. Wie
  // er nu op staat blijft staan, ook buiten het team -- anders verdwijnt de
  // huidige waarde uit haar eigen keuzelijst.
  const collegas = collegasVoorDossier(
    employees,
    leden,
    values.team_id || null,
    values.standaard_verantwoordelijke_id || null
  )

  // De bijzondere btw-aangifte staat bij het btw-regime en niet in de lijst
  // onderaan. Het is dezelfde verplichting en dezelfde opslag; alleen de plek
  // op het scherm verschilt, want dáár neem je de beslissing.
  const bijzondereAangifteType = obligationTypes.find((t) => t.code === 'btw_bijzondere_aangifte')
  const bijzondereAangifteGekozen = Boolean(
    values.obligations.find((o) => o.obligation_type_id === bijzondereAangifteType?.id)?.gekozen
  )
  function zetBijzondereAangifte(gekozen: boolean) {
    if (!bijzondereAangifteType) return
    setValues((v) => ({
      ...v,
      obligations: v.obligations.map((o) =>
        o.obligation_type_id === bijzondereAangifteType.id ? { ...o, gekozen } : o
      ),
    }))
  }

  // De catalogus wordt opgehaald terwijl het scherm al staat. Wie snel op
  // "Nieuwe klant" klikt opent dit venster voor ze binnen is, en omdat de
  // beginwaarde van useState maar één keer berekend wordt, bleef de lijst met
  // verplichtingen dan voorgoed leeg -- je kon niets aanvinken en de klant
  // kreeg alleen de btw-taken die de database zelf afleidt.
  //
  // Daarom vullen we de ontbrekende types alsnog aan zodra ze er zijn. Wat de
  // gebruiker ondertussen al aanvinkte blijft staan.
  useEffect(() => {
    if (obligationTypes.length === 0) return
    setValues((v) => {
      const ontbreekt = obligationTypes.filter(
        (t) => !v.obligations.some((o) => o.obligation_type_id === t.id)
      )
      if (ontbreekt.length === 0) return v
      const aangevuld = legeSelecties(ontbreekt).map((leeg) => {
        const bestaand = bestaandeVerplichtingen.find(
          (b) => b.obligation_type_id === leeg.obligation_type_id
        )
        return bestaand ?? leeg
      })
      return { ...v, obligations: [...v.obligations, ...aangevuld] }
    })
    // bestaandeVerplichtingen is een prop-array die bij elke render een nieuwe
    // referentie kan zijn; de types sturen deze aanvulling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obligationTypes])

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const needsResponsible = values.vertrouwelijk && !values.standaard_verantwoordelijke_id

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!values.naam.trim()) {
      setError('Naam is verplicht.')
      return
    }
    if (needsResponsible) {
      setError('Een vertrouwelijke klant vereist een standaard verantwoordelijke.')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(values)
      onClose()
    } catch (err) {
      setError(reportError(err, 'Opslaan is mislukt'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={client ? 'Klant bewerken' : 'Nieuwe klant'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3 text-sm">
        <div>
          <label htmlFor="client-naam" className="mb-1 block text-xs font-medium text-slate-500">Naam *</label>
          <input
            id="client-naam"
            value={values.naam}
            onChange={(e) => setValues((v) => ({ ...v, naam: e.target.value }))}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            required
          />
        </div>
        {/* Bovenaan, want dit bepaalt welke velden en welke verplichtingen
            hieronder nog zin hebben. Een eenmanszaak is een natuurlijke
            persoon: die heeft wél btw en fiches, maar geen algemene
            vergadering en geen vennootschapsbelasting. */}
        <div>
          <label htmlFor="client-klantsoort" className="mb-1 block text-xs font-medium text-slate-500">Soort dossier</label>
          <select
            id="client-klantsoort"
            value={values.klantsoort}
            onChange={(e) => setValues((v) => ({ ...v, klantsoort: e.target.value as Klantsoort }))}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5"
          >
            <option value="rechtspersoon">Rechtspersoon — vennootschap, vzw, stichting</option>
            <option value="natuurlijk_persoon">Natuurlijke persoon — eenmanszaak, vrij beroep, bedrijfsleider</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="client-ondernemingsnummer" className="mb-1 block text-xs font-medium text-slate-500">Ondernemingsnummer</label>
            <input
              id="client-ondernemingsnummer"
              value={values.ondernemingsnummer}
              onChange={(e) => setValues((v) => ({ ...v, ondernemingsnummer: e.target.value }))}
              placeholder="BE0123.456.789"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            />
          </div>
          <div>
            <label htmlFor="client-rechtsvorm" className="mb-1 block text-xs font-medium text-slate-500">Rechtsvorm</label>
            <input
              id="client-rechtsvorm"
              list="rechtsvormen"
              value={values.rechtsvorm}
              onChange={(e) => setValues((v) => ({ ...v, rechtsvorm: e.target.value }))}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            />
            <datalist id="rechtsvormen">
              {RECHTSVORMEN.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
        </div>

        {values.klantsoort === 'natuurlijk_persoon' ? (
          // Een natuurlijke persoon wordt belast per kalenderjaar. Het veld
          // tonen zou suggereren dat er iets te kiezen valt; het weglaten
          // zonder uitleg zou suggereren dat het vergeten is.
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Een natuurlijke persoon wordt belast per kalenderjaar; er valt geen
            boekjaareinde te kiezen.
          </p>
        ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="client-boekjaar-maand" className="mb-1 block text-xs font-medium text-slate-500">Boekjaareinde — maand</label>
            <select
              id="client-boekjaar-maand"
              value={values.boekjaar_einde_maand}
              onChange={(e) => setValues((v) => ({ ...v, boekjaar_einde_maand: Number(e.target.value) }))}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="client-boekjaar-dag" className="mb-1 block text-xs font-medium text-slate-500">Boekjaareinde — dag</label>
            <input
              id="client-boekjaar-dag"
              type="number"
              min={1}
              max={31}
              value={values.boekjaar_einde_dag}
              onChange={(e) => setValues((v) => ({ ...v, boekjaar_einde_dag: Number(e.target.value) }))}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            />
          </div>
        </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="client-btw-regime" className="mb-1 block text-xs font-medium text-slate-500">BTW-regime</label>
            <select
              id="client-btw-regime"
              value={values.btw_regime}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  btw_regime: e.target.value as BtwRegime,
                  btw_aangifte_frequentie: e.target.value === 'periodieke_aangever' ? v.btw_aangifte_frequentie || 'kwartaal' : '',
                }))
              }
              className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            >
              <option value="geen">Geen</option>
              <option value="periodieke_aangever">Periodieke aangever</option>
              <option value="vrijgesteld_kleine_onderneming">Vrijgesteld (kleine onderneming)</option>
            </select>
          </div>
          {values.btw_regime === 'periodieke_aangever' && (
            <div>
              <label htmlFor="client-btw-frequentie" className="mb-1 block text-xs font-medium text-slate-500">Aangiftefrequentie</label>
              <select
                id="client-btw-frequentie"
                value={values.btw_aangifte_frequentie}
                onChange={(e) => setValues((v) => ({ ...v, btw_aangifte_frequentie: e.target.value as BtwFrequentie }))}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5"
              >
                <option value="maand">Maand</option>
                <option value="kwartaal">Kwartaal</option>
              </select>
            </div>
          )}
        </div>

        {/* De bijzondere aangifte hoort bij het btw-regime en niet onderaan bij
            de verplichtingen: ze bestaat juist voor wie géén periodieke
            aangifte doet, en dat zie je hier. Bij een periodieke aangever
            verdwijnt ze — de databank weigert die combinatie sowieso. Staat ze
            al aan, dan blijft het vinkje wél staan: anders zou het scherm ze
            verbergen terwijl ze opgeslagen blijft, en zou het opslaan stuklopen
            op iets wat je nergens ziet. */}
        {bijzondereAangifteType && (values.btw_regime !== 'periodieke_aangever' || bijzondereAangifteGekozen) && (
          <label className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={bijzondereAangifteGekozen}
              onChange={(e) => zetBijzondereAangifte(e.target.checked)}
            />
            <span>
              <span className="font-medium text-slate-800">Bijzondere btw-aangifte</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Elk kwartaal nakijken of er intracommunautaire verwervingen of ontvangen diensten
                waren, en zo ja indienen tegen de 25ste van de maand erna.
              </span>
            </span>
          </label>
        )}

        <div>
          {/* Het team eerst, de persoon daarna: het team bepaalt wie het
              dossier überhaupt ziet, en het snoeit meteen de keuzelijst
              eronder. */}
          <label htmlFor="client-team" className="mb-1 block text-xs font-medium text-slate-500">Team</label>
          <select
            id="client-team"
            value={values.team_id}
            onChange={(e) => setValues((v) => ({ ...v, team_id: e.target.value }))}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5"
          >
            {magTeamLeegmaken && <option value="">— nog geen team —</option>}
            {kiesbareTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {teamLabel(t)}
              </option>
            ))}
          </select>
          {!values.team_id && (
            <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              Zonder team is dit dossier zichtbaar voor het hele kantoor. Kies een
              team om het af te schermen.
            </p>
          )}
          {bestaandTeam && !magTeamLeegmaken && (
            <p className="mt-1 text-[11px] text-slate-500">
              Een dossier zonder team is zichtbaar voor het hele kantoor; het team
              weghalen kan daarom alleen een kantoorbeheerder. Verhuizen naar een
              team waar je zelf in zit, kan wel.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="client-verantwoordelijke" className="mb-1 block text-xs font-medium text-slate-500">
            Standaard verantwoordelijke {values.vertrouwelijk && '*'}
          </label>
          <select
            id="client-verantwoordelijke"
            value={values.standaard_verantwoordelijke_id}
            onChange={(e) => setValues((v) => ({ ...v, standaard_verantwoordelijke_id: e.target.value }))}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5"
          >
            <option value="">— geen —</option>
            {collegas.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={values.mandataris}
              onChange={(e) => setValues((v) => ({ ...v, mandataris: e.target.checked }))}
            />
            Fiscaal mandaat
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={values.vertrouwelijk}
              onChange={(e) => setValues((v) => ({ ...v, vertrouwelijk: e.target.checked }))}
            />
            Vertrouwelijk
          </label>
          {client && (
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={values.actief}
                onChange={(e) => setValues((v) => ({ ...v, actief: e.target.checked }))}
              />
              Actief
            </label>
          )}
        </div>

        {client?.actief && !values.actief && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Het vinkje "Actief" uitzetten archiveert deze klant
            {typeof openstaandeTaken === 'number' && openstaandeTaken > 0
              ? ` en annuleert ${omschrijfOpenstaandeTaken(openstaandeTaken)}`
              : ''}
            . Dat is niet terug te draaien; de taken blijven wel in de historiek van het dossier staan.
          </p>
        )}

        <ObligationPicker
          klantsoort={values.klantsoort}
          rechtsvorm={values.rechtsvorm}
          verbergCodes={['btw_bijzondere_aangifte']}
          obligationTypes={obligationTypes}
          employees={employees}
          selections={values.obligations}
          btwRegime={values.btw_regime}
          onChange={(next) => setValues((v) => ({ ...v, obligations: next }))}
        />

        {values.vertrouwelijk && (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Vertrouwelijke klanten zijn enkel zichtbaar voor de kantoorbeheerder en de medewerker(s) die aan een taak van
            deze klant zijn toegewezen — vandaar de verplichte standaard verantwoordelijke.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100">
            Annuleren
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-brand-600 px-4 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {submitting ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
