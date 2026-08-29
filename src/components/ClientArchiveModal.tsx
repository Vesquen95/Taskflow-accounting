import { useState } from 'react'
import { Modal } from './Modal'
import { reportError } from '../lib/errorMessage'
import { omschrijfOpenstaandeTaken } from '../lib/klantArchief'

/**
 * Bevestiging voor het archiveren van een klant.
 *
 * Dit is geen beleefdheidsvraag: het archiveren annuleert in één keer alle
 * openstaande taken van het dossier, en annuleren is niet terug te draaien.
 * Wie op de knop duwt hoort dus vooraf te weten om hoeveel taken het gaat.
 */
export function ClientArchiveModal({
  clientNaam,
  vertrouwelijk,
  openstaandeTaken,
  onClose,
  onConfirm,
}: {
  clientNaam: string
  vertrouwelijk: boolean
  openstaandeTaken: number
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const bevestigLabel =
    openstaandeTaken === 0
      ? 'Archiveren'
      : `Archiveren en ${openstaandeTaken} ${openstaandeTaken === 1 ? 'taak' : 'taken'} annuleren`

  async function handleConfirm() {
    setError(null)
    setBezig(true)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(reportError(err, 'Archiveren is mislukt'))
    } finally {
      setBezig(false)
    }
  }

  return (
    <Modal title="Klant archiveren" onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Je archiveert <span className="font-medium text-slate-900">{clientNaam}</span>.
        </p>

        {openstaandeTaken === 0 ? (
          <p>Er staan geen taken open voor dit dossier, dus er wordt niets geannuleerd.</p>
        ) : (
          <p>
            Daarbij {openstaandeTaken === 1 ? 'wordt' : 'worden'}{' '}
            <span className="font-medium text-slate-900">{omschrijfOpenstaandeTaken(openstaandeTaken)}</span> geannuleerd
            — alles wat nog niet ingediend of afgerond is.
          </p>
        )}

        <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
          Annuleren is niet terug te draaien. De taken verdwijnen uit alle werklijsten maar blijven in de historiek van
          het dossier staan. Zet je de klant later weer actief, dan maakt de taakgeneratie nieuwe taken aan voor de
          verplichtingen die nog lopen; de geannuleerde taken komen niet terug.
        </p>

        {vertrouwelijk && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
            Dit is een vertrouwelijk dossier. Toegang loopt via een lopende taak, en na het archiveren is er geen enkele
            lopende taak meer — daarna kan alleen een kantoorbeheerder dit dossier nog openen, ook jij niet.
          </p>
        )}

        <p className="text-slate-500">
          Een gearchiveerde klant verdwijnt uit de klantenlijst. Je vindt hem terug met het statusfilter
          “Gearchiveerd”.
        </p>

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
            disabled={bezig}
            className="rounded-md bg-red-600 px-4 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {bezig ? 'Bezig…' : bevestigLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
