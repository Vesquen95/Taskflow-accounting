interface PagineringProps {
  /** 1-gebaseerd, zoals de gebruiker telt. */
  pagina: number
  paginaGrootte: number
  /** Aantal rijen dat nu op het scherm staat. */
  aantalOpPagina: number
  /** Het werkelijke aantal rijen achter de filters, of null als de databank
   *  dat niet meegaf (dan blijft de kop over de zichtbare schijf gaan). */
  totaal: number | null
  onPagina: (pagina: number) => void
}

/**
 * De kop boven een afgekapte lijst.
 *
 * Waarom het totaal hier hoort: een teller die de opgehaalde rijen telt maakt
 * van een afgekapte lijst een volledige lijst — "50 taken" leest dan als "meer
 * zijn er niet". Met het exacte totaal ernaast is dat onderscheid er weer:
 * "Taken 1–50 van 247".
 */
export function Paginering({ pagina, paginaGrootte, aantalOpPagina, totaal, onPagina }: PagineringProps) {
  const van = (pagina - 1) * paginaGrootte + 1
  const tot = (pagina - 1) * paginaGrootte + aantalOpPagina
  const aantalPaginas = totaal === null ? pagina : Math.max(1, Math.ceil(totaal / paginaGrootte))
  const meerdere = aantalPaginas > 1

  if (aantalOpPagina === 0 && !meerdere) return null

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2">
      <p className="text-sm text-slate-600">
        {totaal === null ? `Taken ${van}–${tot}` : `Taken ${van}–${tot} van ${totaal}`}
      </p>
      {meerdere && (
        <nav aria-label="Paginering" className="flex items-center gap-2">
          <button
            type="button"
            disabled={pagina <= 1}
            onClick={() => onPagina(pagina - 1)}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Vorige
          </button>
          <span className="text-sm text-slate-600">
            Pagina {pagina} van {aantalPaginas}
          </span>
          <button
            type="button"
            disabled={pagina >= aantalPaginas}
            onClick={() => onPagina(pagina + 1)}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Volgende
          </button>
        </nav>
      )}
    </div>
  )
}
