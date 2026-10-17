import { useEffect, useState } from 'react'
import { factuurstandVoorTaken, zetTaakOpFactuurlijst } from '../lib/factuurlijst'
import { reportError } from '../lib/errorMessage'
import type { TaskInstanceWithRelations } from '../types'

/**
 * Na het afronden of goedkeuren: moet dit gefactureerd worden?
 *
 * Het moment waarop je weet dat het werk klaar is, is het moment om eraan te
 * denken -- daarna is het uit beeld. Geen verplichting: een btw-aangifte zit
 * bij de ene klant in een forfait, bij de andere niet (zie 0069). Staat de
 * taak al op de lijst, dan wordt er niets meer gevraagd.
 */
export function FacturatieVraag({ task, onSluit }: { task: TaskInstanceWithRelations; onSluit: () => void }) {
  const [stand, setStand] = useState<'laden' | 'vraag' | 'stond_er_al' | 'toegevoegd'>('laden')
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  useEffect(() => {
    let actief = true
    factuurstandVoorTaken([task.id])
      .then((standen) => {
        if (!actief) return
        const s = standen.get(task.id)
        setStand(s === 'te_factureren' || s === 'gefactureerd' ? 'stond_er_al' : 'vraag')
      })
      // Lukt het nakijken niet, dan vragen we het gewoon: een tweede regel
      // weigert de databank toch.
      .catch(() => actief && setStand('vraag'))
    return () => {
      actief = false
    }
  }, [task.id])

  async function zetOpLijst() {
    setBezig(true)
    setFout(null)
    try {
      setStand(await zetTaakOpFactuurlijst(task))
    } catch (error) {
      setFout(reportError(error, 'Op de lijst te factureren'))
    } finally {
      setBezig(false)
    }
  }

  const knopRustig = 'rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50'

  return (
    <div className="space-y-3 text-sm">
      <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 font-medium text-emerald-800">
        Afgerond.
        {stand === 'stond_er_al' && ' Deze taak staat al op de lijst te factureren.'}
        {stand === 'toegevoegd' && ' Op de lijst te factureren gezet.'}
      </p>

      {stand === 'vraag' && (
        <>
          <p className="text-slate-700">Moet dit gefactureerd worden?</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={bezig}
              onClick={() => void zetOpLijst()}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {bezig ? 'Bezig…' : 'Op de lijst te factureren'}
            </button>
            <button type="button" disabled={bezig} onClick={onSluit} className={knopRustig}>
              Niet nu
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Later kan het ook nog: vanuit de taak, of op het scherm Afgerond.
          </p>
        </>
      )}

      {(stand === 'stond_er_al' || stand === 'toegevoegd') && (
        <button type="button" onClick={onSluit} className={knopRustig}>
          Sluiten
        </button>
      )}

      {fout && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
          {fout}
        </p>
      )}
    </div>
  )
}
