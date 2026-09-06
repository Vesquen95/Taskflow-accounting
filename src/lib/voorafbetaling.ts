/**
 * De vier voorafbetalingen vennootschapsbelasting, uit elkaar gehaald.
 *
 * Alle vier de taken dragen dezelfde naam van de verplichting
 * ("Voorafbetaling VenB (VA1-VA4)"). Op het scherm staat dan vier keer
 * hetzelfde, met alleen een datum als verschil -- en in een lijst die op de
 * naam afgekapt wordt, valt het periodelabel er nog af ook. Terwijl het net
 * uitmaakt wélke het is: een voorafbetaling in het eerste kwartaal drukt de
 * vermeerdering het sterkst, en elk kwartaal later weegt lichter.
 *
 * De percentages staan hier bewust NIET in. Ze worden jaarlijks vastgelegd
 * en volgen de referentierentevoet; een getal dat hier hardgecodeerd staat is
 * binnen een jaar fout, en fout op een scherm is erger dan afwezig. Wat wél
 * elk jaar klopt, is de volgorde: VA1 zwaarder dan VA2, VA2 zwaarder dan VA3,
 * VA3 zwaarder dan VA4.
 */

export type VaNummer = 1 | 2 | 3 | 4

export interface Voorafbetaling {
  nummer: VaNummer
  /** Het boekjaar waarop de voorafbetaling slaat, als jaartal. */
  jaar: string
}

/** De code van de verplichting in de databank (migratie 0003). */
export const VA_CODE = 'va_venb'

const LABEL = /^VA([1-4])-(\d{4})$/

/**
 * Leest "VA1-2026" uit het periodelabel.
 *
 * Geeft null zodra er iets niet klopt: een andere verplichting, een leeg
 * label, of een label in een vorm die we niet kennen. Dan valt het scherm
 * terug op de gewone weergave in plaats van iets te verzinnen.
 */
export function leesVoorafbetaling(
  code: string | null | undefined,
  periodeLabel: string | null | undefined
): Voorafbetaling | null {
  if (code !== VA_CODE || !periodeLabel) return null
  const treffer = LABEL.exec(periodeLabel)
  if (!treffer) return null
  return { nummer: Number(treffer[1]) as VaNummer, jaar: treffer[2] }
}

/** Hoe zwaar deze voorafbetaling doorweegt. Bepaalt of ze nadruk krijgt. */
export function vaWeegtZwaar(nummer: VaNummer): boolean {
  return nummer <= 2
}

/**
 * Eén zin bij deze voorafbetaling, voor het detailvenster. Zonder
 * percentages; zie de kop van dit bestand.
 */
export const VA_UITLEG: Record<VaNummer, string> = {
  1: 'De eerste van vier. Deze weegt het zwaarst: hoe vroeger in het boekjaar je betaalt, hoe meer ze de vermeerdering drukt.',
  2: 'De tweede van vier. Na VA1 is dit de zwaarste; er blijven nog twee kwartalen over.',
  3: 'De derde van vier. Weegt minder door dan VA1 en VA2.',
  4: 'De laatste van vier, en de lichtste. Dit is de laatste kans om de vermeerdering voor dit boekjaar nog te drukken.',
}

/** "Voorafbetaling VA1" — de naam zoals ze in een lijst hoort te staan. */
export function vaNaam(nummer: VaNummer): string {
  return `Voorafbetaling VA${nummer}`
}
