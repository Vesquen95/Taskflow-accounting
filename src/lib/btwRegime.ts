import type { BtwRegime } from '../types'

/** Het btw-regime in woorden, zoals het kantoor het zegt. Eén plek, gedeeld
 *  door het importsjabloon, de klantenlijst en het dossier. */
export const REGIME_LABELS: Record<BtwRegime, string> = {
  geen: 'Geen',
  periodieke_aangever: 'Periodieke aangever',
  vrijgesteld_kleine_onderneming: 'Vrijgesteld (kleine onderneming)',
}
