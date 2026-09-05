import { useState } from 'react'
import { formatDate } from '../lib/urgency'
import { reportError } from '../lib/errorMessage'
import { vereffeningStand } from '../lib/vereffening'

/**
 * De vereffening van een dossier: wanneer ze begon en wanneer ze gedaan was.
 *
 * Twee momenten, niet één. Een ontbinding verandert niets aan het werk -- de
 * vereffenaar dient elk jaar gewoon de aangifte in en legt elk jaar de
 * jaarrekening neer, en dat kan járen duren. Pas de SLUITING maakt er een
 * einde aan: dan bestaat de rechtspersoon niet meer en houden de
 * verplichtingen op.
 *
 * Waarom sluiten niet hetzelfde is als archiveren: archiveren annuleert alles
 * wat nog openstaat. De aangifte over het laatste boekjaar wordt pas maanden
 * ná de sluiting ingediend en moet dus blijven staan.
 */
export function VereffeningPaneel({
  ontbondenOp,
  vereffendOp,
  onOntbonden,
  onVereffend,
}: {
  ontbondenOp: string | null
  vereffendOp: string | null
  onOntbonden: (datum: string | null) => Promise<void>
  onVereffend: (datum: string | null) => Promise<void>
}) {
  const [openen, setOpenen] = useState(false)
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)
  const stand = vereffeningStand({ ontbonden_op: ontbondenOp, vereffend_op: vereffendOp })

  async function doe(actie: () => Promise<void>) {
    setFout(null)
    setBezig(true)
    try {
      await actie()
      setOpenen(false)
    } catch (err) {
      setFout(reportError(err, 'De vereffeningsdatum kon niet bewaard worden.'))
    } finally {
      setBezig(false)
    }
  }

  if (stand === 'geen') {
    return (
      <div className="mt-2">
        {openen ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-600">
              Ontbonden op{' '}
              <input
                type="date"
                aria-label="Datum van de ontbinding"
                disabled={bezig}
                onChange={(e) => e.target.value && void doe(() => onOntbonden(e.target.value))}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              onClick={() => setOpenen(false)}
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              Annuleren
            </button>
            {fout && <span className="text-xs text-red-700">{fout}</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpenen(true)}
            className="text-xs text-slate-500 hover:text-slate-800"
          >
            Dit dossier is in vereffening…
          </button>
        )}
      </div>
    )
  }

  return (
    <section
      aria-labelledby="vereffening-titel"
      className="mt-3 rounded-md border border-slate-300 bg-slate-50 p-3"
    >
      <h2 id="vereffening-titel" className="text-sm font-semibold text-slate-800">
        {stand === 'vereffend'
          ? `Vereffend op ${formatDate(vereffendOp!)}`
          : `In vereffening sinds ${formatDate(ontbondenOp!)}`}
      </h2>

      {stand === 'in_vereffening' && (
        <>
          <p className="mt-1 text-xs text-slate-600">
            De vennootschap blijft bestaan tot de sluiting van de vereffening, dus alle
            verplichtingen lopen gewoon door. Hoe lang dat duurt, maakt niet uit.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-600">
              Vereffening gesloten op{' '}
              <input
                type="date"
                aria-label="Datum van de sluiting van de vereffening"
                disabled={bezig}
                min={ontbondenOp ?? undefined}
                onChange={(e) => e.target.value && void doe(() => onVereffend(e.target.value))}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              disabled={bezig}
              onClick={() => void doe(() => onOntbonden(null))}
              className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
            >
              Toch niet in vereffening
            </button>
          </div>
        </>
      )}

      {stand === 'vereffend' && (
        <>
          <p className="mt-1 text-xs text-slate-600">
            In vereffening sinds {formatDate(ontbondenOp!)}. De verplichtingen lopen tot en met{' '}
            {formatDate(vereffendOp!)}; het papierwerk over de laatste periodes blijft staan, ook
            wat pas later ingediend wordt.
          </p>
          <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            <strong>Nog met de hand toe te voegen:</strong> de aangifte over het
            vereffeningstijdperk zelf. Die termijn is geen formule — hij loopt vanaf de
            goedkeuring van de resultaten van de vereffening (art. 310, tweede lid WIB 92), en die
            datum kent Taskflow niet. Maak er een losse taak voor met de afgesproken datum.
          </p>
          <button
            type="button"
            disabled={bezig}
            onClick={() => void doe(() => onVereffend(null))}
            className="mt-2 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
          >
            Sluiting terugdraaien
          </button>
        </>
      )}

      {fout && <p className="mt-2 text-xs text-red-700">{fout}</p>}
    </section>
  )
}
