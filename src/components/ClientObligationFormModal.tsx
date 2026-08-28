import { useState, type FormEvent } from 'react'
import { Modal } from './Modal'
import type { Employee, ObligationType } from '../types'
import { reportError } from '../lib/errorMessage'

export function ClientObligationFormModal({
  obligationTypes,
  employees,
  onClose,
  onSubmit,
}: {
  obligationTypes: ObligationType[]
  employees: Employee[]
  onClose: () => void
  onSubmit: (input: {
    obligation_type_id: string
    parameters: Record<string, unknown>
    standaard_toegewezen_medewerker_id: string | null
  }) => Promise<void>
}) {
  const [obligationTypeId, setObligationTypeId] = useState(obligationTypes[0]?.id ?? '')
  const [frequentie, setFrequentie] = useState('kwartaal')
  const [termijnDagen, setTermijnDagen] = useState(10)
  const [slaMaanden, setSlaMaanden] = useState(3)
  const [assignee, setAssignee] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const selected = obligationTypes.find((o) => o.id === obligationTypeId);
  const code = selected?.code

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!obligationTypeId) {
      setError('Kies een type verplichting.')
      return
    }
    let parameters: Record<string, unknown> = {}
    if (code === 'rapportering') parameters = { frequentie, termijn_dagen: termijnDagen }
    if (code === 'jaarafsluiting') parameters = { sla_maanden: slaMaanden }

    setSubmitting(true)
    try {
      await onSubmit({ obligation_type_id: obligationTypeId, parameters, standaard_toegewezen_medewerker_id: assignee || null })
      onClose()
    } catch (err) {
      setError(reportError(err, 'Opslaan is mislukt'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Verplichting toevoegen" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3 text-sm">
        <div>
          <label htmlFor="obligation-type" className="mb-1 block text-xs font-medium text-slate-500">Type verplichting</label>
          <select
            id="obligation-type"
            value={obligationTypeId}
            onChange={(e) => setObligationTypeId(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5"
          >
            {obligationTypes.map((ot) => (
              <option key={ot.id} value={ot.id}>
                {ot.naam} ({ot.categorie})
              </option>
            ))}
          </select>
        </div>

        {code === 'rapportering' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="obligation-frequentie" className="mb-1 block text-xs font-medium text-slate-500">Frequentie</label>
              <select id="obligation-frequentie" value={frequentie} onChange={(e) => setFrequentie(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5">
                <option value="maand">Maand</option>
                <option value="kwartaal">Kwartaal</option>
                <option value="jaar">Jaar</option>
              </select>
            </div>
            <div>
              <label htmlFor="obligation-termijn" className="mb-1 block text-xs font-medium text-slate-500">Termijn (dagen na periode)</label>
              <input
                id="obligation-termijn"
                type="number"
                min={1}
                value={termijnDagen}
                onChange={(e) => setTermijnDagen(Number(e.target.value))}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5"
              />
            </div>
          </div>
        )}

        {code === 'jaarafsluiting' && (
          <div>
            <label htmlFor="obligation-sla" className="mb-1 block text-xs font-medium text-slate-500">Kantoor-SLA (maanden na boekjaareinde)</label>
            <input
              id="obligation-sla"
              type="number"
              min={1}
              max={12}
              value={slaMaanden}
              onChange={(e) => setSlaMaanden(Number(e.target.value))}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5"
            />
          </div>
        )}

        <div>
          <label htmlFor="obligation-assignee" className="mb-1 block text-xs font-medium text-slate-500">Standaard toegewezen medewerker</label>
          <select id="obligation-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5">
            <option value="">— valt terug op standaard verantwoordelijke van de klant —</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.naam}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100">
            Annuleren
          </button>
          <button type="submit" disabled={submitting} className="rounded-md bg-brand-600 px-4 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {submitting ? 'Bezig…' : 'Toevoegen'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
