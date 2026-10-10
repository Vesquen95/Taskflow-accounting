import { useState } from 'react'
import { reportError } from '../lib/errorMessage'

/**
 * De reden waarom een afgeronde taak heropend wordt (0070). Verplicht: ze
 * komt in de historiek van de taak, naast wie het deed.
 */
export function HeropenFormulier({
  onBevestig,
  onAnnuleer,
  vereistGoedkeuring,
}: {
  onBevestig: (reden: string) => Promise<void>
  onAnnuleer: () => void
  vereistGoedkeuring: boolean
}) {
  const [reden, setReden] = useState('')
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)
  const geldig = reden.trim().length >= 3

  async function bevestig() {
    setBezig(true)
    setFout(null)
    try {
      await onBevestig(reden.trim())
    } catch (e) {
      setFout(reportError(e, 'Heropenen'))
      setBezig(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
      <label htmlFor="heropen-reden" className="block text-xs font-medium text-amber-900">
        Waarom wordt deze taak heropend?
      </label>
      <input
        id="heropen-reden"
        value={reden}
        onChange={(e) => setReden(e.target.value)}
        maxLength={500}
        placeholder="bv. per ongeluk afgevinkt, verkeerde periode ingediend"
        className="w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-base sm:text-sm"
      />
      <p className="text-xs text-amber-800">
        De taak gaat terug naar &quot;in uitvoering&quot;. De reden en je naam komen in de historiek.
        {vereistGoedkeuring && ' De goedkeuring vervalt: na het opnieuw indienen moet ze opnieuw goedgekeurd worden.'}
      </p>
      {fout && (
        <p role="alert" className="text-xs text-red-700">
          {fout}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!geldig || bezig}
          onClick={() => void bevestig()}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {bezig ? 'Bezig…' : 'Heropenen'}
        </button>
        <button
          type="button"
          onClick={onAnnuleer}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Annuleren
        </button>
      </div>
    </div>
  )
}
