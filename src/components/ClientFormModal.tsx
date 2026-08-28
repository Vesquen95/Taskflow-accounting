import { useEffect, useState, type FormEvent } from 'react'
import { Modal } from './Modal'
import type { BtwFrequentie, BtwRegime, Client, Employee, ObligationType } from '../types'
import { reportError } from '../lib/errorMessage'
import { ObligationPicker } from './ObligationPicker'
import { legeSelecties, type ObligationSelection } from '../lib/clientObligations'

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
  onClose,
  onSubmit,
}: {
  client: Client | null
  employees: Employee[]
  obligationTypes: ObligationType[]
  bestaandeVerplichtingen?: ObligationSelection[]
  onClose: () => void
  onSubmit: (values: ClientFormValues) => Promise<void>
}) {
  const [values, setValues] = useState<ClientFormValues>(
    toFormValues(client, obligationTypes, bestaandeVerplichtingen)
  )

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
            {employees.map((emp) => (
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
            Mandataris
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

        <ObligationPicker
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
