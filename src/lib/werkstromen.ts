import type { ObligationType, TaskInstanceWithRelations, Werkstroom } from '../types'

/** De ingangen van de app. De vier werkstromen komen uit de catalogus
 *  (migratie 0022); 'adhoc' is de vijfde en bestaat niet als enumwaarde —
 *  ad-hoc taken hebben geen verplichtingstype. */
export type Ingang = Werkstroom | 'adhoc'

export interface IngangDefinitie {
  key: Ingang
  /** Segment in de hash-router, bv. #/werk/btw. */
  pad: string
  label: string
  omschrijving: string
}

export const INGANGEN: IngangDefinitie[] = [
  {
    key: 'btw',
    pad: 'btw',
    label: 'Btw',
    omschrijving: 'Aangiftes en klantenlistings — loopt per kalenderjaar.',
  },
  {
    key: 'afsluiting',
    pad: 'afsluiting',
    label: 'Afsluiting',
    omschrijving: 'Jaarafsluiting, algemene vergadering en neerlegging — per boekjaar.',
  },
  {
    key: 'vennootschapsbelasting',
    pad: 'vennootschapsbelasting',
    label: 'Vennootschapsbelasting',
    omschrijving: 'Voorafbetalingen en de aangifte — per boekjaar.',
  },
  {
    key: 'rapportering',
    pad: 'rapportering',
    label: 'Rapportering',
    omschrijving: 'Periodieke rapportering naar de klant. Geen wettelijke deadline.',
  },
  {
    key: 'adhoc',
    pad: 'adhoc',
    label: 'Ad-hoc',
    omschrijving: 'Losse taken zonder verplichtingstype.',
  },
]

export function ingangVoorPad(pad: string): IngangDefinitie | undefined {
  return INGANGEN.find((i) => i.pad === pad)
}

/** De verplichtingstypes die in deze werkstroom vallen. De indeling zelf staat
 *  in de catalogus, niet hier — zo valt een nieuw type vanzelf ergens. */
export function typesInWerkstroom(
  types: ObligationType[],
  werkstroom: Werkstroom
): ObligationType[] {
  return types.filter((t) => t.werkstroom === werkstroom)
}

/** De vensters waarin het kantoor plant. Er is bewust geen ondergrens: wat te
 *  laat is hoort in élk venster thuis, anders raak je achterstand kwijt zodra
 *  je inzoomt op deze week. */
export type VensterKey = 'deze_week' | 'twee_weken' | 'deze_maand' | 'alles'

export const VENSTERS: { key: VensterKey; label: string }[] = [
  { key: 'deze_week', label: 'Deze week' },
  { key: 'twee_weken', label: 'Komende twee weken' },
  { key: 'deze_maand', label: 'Deze maand' },
  { key: 'alles', label: 'Alles' },
]

function isoDatum(d: Date): string {
  const jaar = d.getFullYear()
  const maand = String(d.getMonth() + 1).padStart(2, '0')
  const dag = String(d.getDate()).padStart(2, '0')
  return `${jaar}-${maand}-${dag}`
}

/** De bovengrens van een venster als ISO-datum, of undefined voor 'alles'.
 *  De week loopt tot en met zondag: een Belgische werkweek eindigt daar. */
export function vensterTot(venster: VensterKey, vandaag: Date = new Date()): string | undefined {
  const d = new Date(vandaag.getFullYear(), vandaag.getMonth(), vandaag.getDate())
  switch (venster) {
    case 'deze_week': {
      // getDay(): 0 = zondag. Aantal dagen tot en met de eerstvolgende zondag.
      const totZondag = (7 - d.getDay()) % 7
      d.setDate(d.getDate() + totZondag)
      return isoDatum(d)
    }
    case 'twee_weken': {
      const totZondag = (7 - d.getDay()) % 7
      d.setDate(d.getDate() + totZondag + 7)
      return isoDatum(d)
    }
    case 'deze_maand': {
      return isoDatum(new Date(d.getFullYear(), d.getMonth() + 1, 0))
    }
    case 'alles':
      return undefined
  }
}

export interface TakenBlok {
  /** De deadline van dit blok, of null voor het verzamelblok "te laat". */
  due_date: string | null
  taken: TaskInstanceWithRelations[]
}

/**
 * Groepeert taken in blokken per deadline — zo werkt het kantoor: "we werken
 * taken af per takenblok, niet per klant."
 *
 * Alles wat al te laat is gaat in één blok vooraan in plaats van in een reeks
 * losse dagblokken: die achterstand pak je als geheel aan, en anders staat er
 * bij ~100 dossiers een lange staart van dagen met één taak.
 */
export function groepeerInBlokken(
  taken: TaskInstanceWithRelations[],
  vandaag: Date = new Date()
): TakenBlok[] {
  const vandaagIso = isoDatum(vandaag)
  const teLaat: TaskInstanceWithRelations[] = []
  const perDatum = new Map<string, TaskInstanceWithRelations[]>()

  for (const taak of taken) {
    if (taak.due_date < vandaagIso) {
      teLaat.push(taak)
      continue
    }
    const rij = perDatum.get(taak.due_date)
    if (rij) rij.push(taak)
    else perDatum.set(taak.due_date, [taak])
  }

  const blokken: TakenBlok[] = [...perDatum.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([due_date, blokTaken]) => ({ due_date, taken: blokTaken }))

  return teLaat.length > 0 ? [{ due_date: null, taken: teLaat }, ...blokken] : blokken
}
