import { useState } from 'react'
import type { BoekjaarWijziging, BoekjaarWijzigingTaak } from '../hooks/useBoekjaarWijziging'
import { formatDate } from '../lib/urgency'
import { reportError } from '../lib/errorMessage'
import { boekjaarLabel } from '../lib/boekjaar'

/**
 * Het boekjaareinde van dit dossier is gewijzigd, en de al gegenereerde
 * jaartaken staan nog op het oude ritme.
 *
 * Waarom dit een paneel is en geen stille herberekening: het kantoor vroeg
 * uitdrukkelijk om automatisch herrekenen mét een menselijke goedkeuring
 * ertussen. Een boekjaar verzetten is zeldzaam en zelden onschuldig -- er
 * hangt meestal een overgangsboekjaar aan vast, of het is een typfout. In
 * allebei de gevallen is stil herrekenen de verkeerde uitkomst.
 */
export function BoekjaarWijzigingPaneel({
  wijziging,
  taken,
  bezig,
  onDoorvoeren,
  onNegeren,
}: {
  wijziging: BoekjaarWijziging
  taken: BoekjaarWijzigingTaak[]
  bezig: boolean
  onDoorvoeren: () => Promise<number>
  onNegeren: () => Promise<void>
}) {
  const [fout, setFout] = useState<string | null>(null)
  const [resultaat, setResultaat] = useState<string | null>(null)

  const herzetbaar = taken.filter((t) => t.herzetbaar)
  const blijftStaan = taken.filter((t) => !t.herzetbaar)
  const van = boekjaarLabel(wijziging.oude_maand, wijziging.oude_dag)
  const naar = boekjaarLabel(wijziging.nieuwe_maand, wijziging.nieuwe_dag)

  async function doorvoeren() {
    setFout(null)
    try {
      const aantal = await onDoorvoeren()
      setResultaat(
        aantal === 1
          ? 'Eén taak is herrekend op het nieuwe boekjaar.'
          : `${aantal} taken zijn herrekend op het nieuwe boekjaar.`
      )
    } catch (e) {
      setFout(reportError(e, 'Het herrekenen is niet gelukt.'))
    }
  }

  async function negeren() {
    setFout(null)
    try {
      await onNegeren()
    } catch (e) {
      setFout(reportError(e, 'De melding kon niet gesloten worden.'))
    }
  }

  if (resultaat) {
    return (
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        {resultaat}
      </div>
    )
  }

  return (
    <section
      aria-labelledby="boekjaarwijziging-titel"
      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4"
    >
      <h2 id="boekjaarwijziging-titel" className="text-sm font-semibold text-amber-900">
        Het boekjaareinde is gewijzigd van {van} naar {naar}
      </h2>
      <p className="mt-1 text-sm text-amber-900">
        {taken.length === 0
          ? 'Er staan geen toekomstige jaartaken meer op het oude boekjaar. Er valt niets te herrekenen.'
          : 'De onderstaande taken staan nog op het oude boekjaar. Ze worden pas herrekend als je hieronder akkoord gaat — tot dan tonen de schermen de oude data.'}
      </p>

      {herzetbaar.length > 0 && (
        <>
          <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-amber-800">
            Wordt herrekend ({herzetbaar.length})
          </h3>
          <ul className="mt-1 space-y-1 text-sm text-amber-900">
            {herzetbaar.map((t) => (
              <li key={t.task_id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{t.verplichting}</span>
                <span>{t.periode_label ?? '—'}</span>
                <span className="text-amber-700">nu {formatDate(t.due_date)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {blijftStaan.length > 0 && (
        <>
          <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-amber-800">
            Blijft staan ({blijftStaan.length})
          </h3>
          <ul className="mt-1 space-y-1 text-sm text-amber-900">
            {blijftStaan.map((t) => (
              <li key={t.task_id}>
                <span className="font-medium">{t.verplichting}</span> {t.periode_label ?? '—'}{' '}
                <span className="text-amber-700">nu {formatDate(t.due_date)}</span>
                {t.reden && <div className="text-xs text-amber-700">{t.reden}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      {fout && <p className="mt-3 text-sm text-red-700">{fout}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={bezig || herzetbaar.length === 0}
          onClick={() => void doorvoeren()}
          className="rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {bezig ? 'Bezig…' : `Herrekenen (${herzetbaar.length})`}
        </button>
        <button
          type="button"
          disabled={bezig}
          onClick={() => void negeren()}
          className="rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          Laat staan zoals het is
        </button>
      </div>
    </section>
  )
}
