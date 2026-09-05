/**
 * De vereffeningstoestand van een dossier.
 *
 * Twee datums, geen statusvlag. Het kantoor: "In vereffening en vereffend is
 * nog iets anders. Een dossier kan in vereffening staan voor meerdere jaren,
 * maar een vereffening is gedaan." De wet zegt hetzelfde: de vennootschap
 * blijft na de ontbinding bestaan vóór haar vereffening (art. 2:76 WVV), en de
 * rechtspersoonlijkheid verdwijnt pas bij de sluiting.
 *
 * Hoe lang het ertussen duurt, doet er niet toe -- er hangt geen berekening
 * aan. Wat telt is wanneer het begint en wanneer het gedaan is.
 */
export type VereffeningStand = 'geen' | 'in_vereffening' | 'vereffend'

export function vereffeningStand(klant: {
  ontbonden_op?: string | null
  vereffend_op?: string | null
}): VereffeningStand {
  if (klant.vereffend_op) return 'vereffend'
  if (klant.ontbonden_op) return 'in_vereffening'
  return 'geen'
}

/** Het woord dat op het scherm hoort. */
export const VEREFFENING_LABEL: Record<Exclude<VereffeningStand, 'geen'>, string> = {
  in_vereffening: 'In vereffening',
  vereffend: 'Vereffend',
}
