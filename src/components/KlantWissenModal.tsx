import { useState } from 'react'
import { Modal } from './Modal'
import { reportError } from '../lib/errorMessage'

/**
 * Een gearchiveerde klant definitief wissen (migratie 0072).
 *
 * Archiveren is omkeerbaar, dit niet. Daarom typ je de naam van de klant over
 * voor de knop werkt: een dossier met zijn hele historiek hoort niet met één
 * verkeerde klik te verdwijnen. De databank controleert hetzelfde nog eens.
 */
export function KlantWissenModal({
  clientNaam,
  aantalTaken,
  onClose,
  onConfirm,
}: {
  clientNaam: string
  aantalTaken: number
  onClose: () => void
  onConfirm: (naam: string) => Promise<void>
}) {
  const [naam, setNaam] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)
  const klopt = naam.trim() === clientNaam.trim()

  async function handleConfirm() {
    setError(null)
    setBezig(true)
    try {
      await onConfirm(naam)
    } catch (err) {
      setError(reportError(err, 'Wissen is mislukt'))
      setBezig(false)
    }
  }

  return (
    <Modal title="Klant definitief wissen" onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Je wist <span className="font-medium text-slate-900">{clientNaam}</span> en alles wat erbij hoort:{' '}
          {aantalTaken === 1 ? '1 taak' : `${aantalTaken} taken`}, de verplichtingen, de historiek en de posten te
          factureren.
        </p>
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-800">
          Dit is niet terug te draaien. Wil je de klant alleen uit de lijsten halen, laat hem dan gearchiveerd staan.
          Alleen de naam, wie wiste en wanneer, blijven bewaard.
        </p>
        <div>
          <label htmlFor="wis-naam" className="mb-1 block text-xs font-medium text-slate-600">
            Typ de naam van de klant over om te bevestigen
          </label>
          <input
            id="wis-naam"
            type="text"
            value={naam}
            autoComplete="off"
            placeholder={clientNaam}
            onChange={(e) => setNaam(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base sm:text-sm"
          />
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
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!klopt || bezig}
            className="rounded-md bg-red-600 px-4 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {bezig ? 'Bezig…' : 'Definitief wissen'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
