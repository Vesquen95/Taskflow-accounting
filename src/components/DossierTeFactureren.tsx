import { useState } from 'react'
import { useFactuurposten } from '../hooks/useFactuurposten'
import { useCurrentEmployee } from '../hooks/useCurrentEmployee'
import { magAfvinken } from '../lib/facturatie'
import { reportError } from '../lib/errorMessage'
import { FactuurpostenBlok, NieuwePostFormulier } from './FactuurpostenBlok'
import type { FactuurpostMetRelaties, FactuurpostStatus } from '../types'

/**
 * "Te factureren" in het klantdossier (0069): wat er voor deze klant nog op
 * een factuur moet, met dezelfde knoppen als op het scherm Te factureren.
 *
 * Alleen wat open staat. De historiek -- wat gefactureerd is, en wanneer --
 * staat op het scherm Te factureren; hier zou ze het dossier alleen langer
 * maken.
 */
export function DossierTeFactureren({
  klant,
  navigate,
}: {
  klant: FactuurpostMetRelaties['client']
  navigate: (view: string, param?: string) => void
}) {
  const { employee } = useCurrentEmployee()
  const { posten, loading, error, toevoegen, wijzigen, afhandelen } = useFactuurposten({
    status: 'te_factureren',
    clientId: klant.id,
  })
  const [toevoegenOpen, setToevoegenOpen] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  async function doe(actie: () => Promise<void>) {
    setFout(null)
    try {
      await actie()
    } catch (e) {
      setFout(reportError(e, 'Te factureren'))
    }
  }

  return (
    <section className="mb-6" aria-labelledby="dossier-te-factureren">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="dossier-te-factureren" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Te factureren{posten.length > 0 && ` (${posten.length})`}
        </h2>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => navigate('facturatie')}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            Alles bekijken
          </button>
          <button
            type="button"
            onClick={() => setToevoegenOpen((open) => !open)}
            aria-expanded={toevoegenOpen}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            + Post toevoegen
          </button>
        </div>
      </div>

      {toevoegenOpen && (
        <NieuwePostFormulier
          clientId={klant.id}
          onAnnuleer={() => setToevoegenOpen(false)}
          onBewaar={(post) =>
            doe(async () => {
              await toevoegen(post)
              setToevoegenOpen(false)
            })
          }
        />
      )}

      {fout && (
        <p role="alert" className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {fout}
        </p>
      )}

      {error ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : loading ? (
        <p className="text-sm text-slate-400">Laden…</p>
      ) : posten.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-400">
          Niets te factureren voor deze klant.
        </p>
      ) : (
        <FactuurpostenBlok
          klant={klant}
          posten={posten}
          status="te_factureren"
          toonKop={false}
          afvinken={magAfvinken(employee)}
          mijnId={employee?.id ?? null}
          onOpenKlant={() => undefined}
          onAfhandelen={(ids: string[], nieuw: FactuurpostStatus, ref?: string) => doe(() => afhandelen(ids, nieuw, ref))}
          onWijzigen={(id, omschrijving, datum, notitie) => doe(() => wijzigen(id, omschrijving, datum, notitie))}
        />
      )}
    </section>
  )
}
