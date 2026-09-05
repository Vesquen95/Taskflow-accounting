import type { ObligationType, TaskInstanceWithRelations, Werkstroom } from '../types'

/** De ingangen van de app. De werkstromen komen uit de catalogus (migratie
 *  0022, uitgebreid met 'fiches' in 0027); 'adhoc' is de laatste en bestaat
 *  niet als enumwaarde — ad-hoc taken hebben geen verplichtingstype. */
type Ingang = Werkstroom | 'adhoc'

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
    // De enumwaarde blijft 'vennootschapsbelasting' (migratie 0022), maar het
    // label niet: sinds de aangifte RPB erbij kwam (0034) zit hier ook het werk
    // voor VZW's in, en die betalen geen vennootschapsbelasting.
    label: 'Belastingaangifte',
    omschrijving: 'Aangifte VenB of RPB en de voorafbetalingen — per boekjaar.',
  },
  {
    key: 'fiches',
    // Het pad blijft 'fiches': bestaande bladwijzers en de e2e-tests wijzen
    // ernaar, en een werkend adres breken voor een naam is de verkeerde ruil.
    pad: 'fiches',
    // Sinds de aangifte bedrijfsvoorheffing (0051) zit hier meer dan fiches.
    // "Personeel" is ook hoe de FOD het zelf indeelt: fiches en
    // bedrijfsvoorheffing staan daar samen onder personeel en loon.
    label: 'Personeel',
    omschrijving:
      'Fiches 281 per inkomstenjaar, en de kwartaalaangifte bedrijfsvoorheffing.',
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

/** De vensters waarin het kantoor plant. Er is bewust geen ondergrens: elk
 *  venster is een einddatum en niet een periode. Wat te laat is hoort in élk
 *  venster thuis, anders raak je achterstand kwijt zodra je inzoomt op deze
 *  week. "Volgende maand" betekent dus "tot en met het einde van volgende
 *  maand", niet "alleen volgende maand". */
export type VensterKey =
  | 'deze_week'
  | 'deze_maand'
  | 'volgende_maand'
  | 'dit_kwartaal'
  | 'volgend_kwartaal'
  | 'alles'

/** De vensters die het kantoor in een werkstroom kiest.
 *
 *  'deze_week' staat er bewust NIET bij: het kantoor plant per maand of per
 *  kwartaal, en een venster van een week leverde in de praktijk vooral lege
 *  schermen op. De berekening blijft wel bestaan -- het telefoonscherm
 *  (src/pages/TelefoonPage.tsx) gebruikt ze voor "wat komt er nu op me af",
 *  en dat is een andere vraag dan plannen. */
export const VENSTERS: { key: VensterKey; label: string }[] = [
  { key: 'deze_maand', label: 'Deze maand' },
  { key: 'volgende_maand', label: 'Volgende maand' },
  { key: 'dit_kwartaal', label: 'Dit kwartaal' },
  { key: 'volgend_kwartaal', label: 'Volgend kwartaal' },
  { key: 'alles', label: 'Alles' },
]

/** Een datum als ISO-dag (JJJJ-MM-DD) in de lokale tijdzone. Bewust niet
 *  toISOString(): die zet om naar UTC en levert in de Belgische zomertijd voor
 *  een datum kort na middernacht de dag ervoor op. */
export function isoDatum(d: Date): string {
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
    case 'deze_maand':
      // Dag 0 van de volgende maand is de laatste dag van deze maand.
      return isoDatum(new Date(d.getFullYear(), d.getMonth() + 1, 0))
    case 'volgende_maand':
      // Idem, één maand verder. De Date-constructor rolt zelf over de
      // jaarwissel: december is maand 11, dus maand 13 is januari erna.
      return isoDatum(new Date(d.getFullYear(), d.getMonth() + 2, 0))
    case 'dit_kwartaal': {
      // Kwartalen eindigen op 31/03, 30/06, 30/09 en 31/12. Sta je op zo'n
      // laatste dag, dan is dat meteen de bovengrens: het venster is die dag
      // smal, maar de achterstand blijft er onverkort in staan.
      const eersteMaandVolgendKwartaal = Math.floor(d.getMonth() / 3) * 3 + 3
      return isoDatum(new Date(d.getFullYear(), eersteMaandVolgendKwartaal, 0))
    }
    case 'volgend_kwartaal': {
      // Drie maanden verder dan het einde van dit kwartaal. De
      // Date-constructor rolt zelf over de jaarwissel: sta je in het vierde
      // kwartaal, dan levert maand 15 het einde van maart erna op.
      const eersteMaandDaarna = Math.floor(d.getMonth() / 3) * 3 + 6
      return isoDatum(new Date(d.getFullYear(), eersteMaandDaarna, 0))
    }
    case 'alles':
      return undefined
  }
}

export interface TakenBlok {
  /** De maand van dit blok als 'JJJJ-MM', of null voor het verzamelblok
   *  "te laat". Bewust de maand en niet de exacte deadline: die staat per
   *  regel in de kolom Deadline, met de urgentiebadge ernaast, en hoorde niet
   *  ook nog eens in de blokkop. */
  maand: string | null
  taken: TaskInstanceWithRelations[]
}

/**
 * Groepeert taken in blokken per maand — zo werkt het kantoor: "we werken
 * taken af per takenblok, niet per klant."
 *
 * Per maand en niet per deadlinedatum: bij een venster van een kwartaal levert
 * een blok per dag tientallen minuscule blokjes op, en dan zie je de stapel
 * niet meer. Binnen een blok blijven de taken op deadline gesorteerd, zodat de
 * maand chronologisch leest.
 *
 * Alles wat al te laat is gaat in één blok vooraan in plaats van in losse
 * maanden: die achterstand pak je als geheel aan.
 */
export function groepeerInBlokken(
  taken: TaskInstanceWithRelations[],
  vandaag: Date = new Date()
): TakenBlok[] {
  const vandaagIso = isoDatum(vandaag)
  const teLaat: TaskInstanceWithRelations[] = []
  const perMaand = new Map<string, TaskInstanceWithRelations[]>()

  for (const taak of taken) {
    if (taak.due_date < vandaagIso) {
      teLaat.push(taak)
      continue
    }
    const maand = taak.due_date.slice(0, 7)
    const rij = perMaand.get(maand)
    if (rij) rij.push(taak)
    else perMaand.set(maand, [taak])
  }

  // Binnen een maandblok staan nu tientallen verschillende deadlines onder
  // elkaar; die moeten chronologisch lopen, ook als de bron ze niet gesorteerd
  // aanlevert. De sortering is stabiel, dus taken op dezelfde dag houden hun
  // onderlinge volgorde.
  const opDeadline = (a: TaskInstanceWithRelations, b: TaskInstanceWithRelations) =>
    a.due_date.localeCompare(b.due_date)

  const blokken: TakenBlok[] = [...perMaand.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([maand, blokTaken]) => ({ maand, taken: blokTaken.sort(opDeadline) }))

  return teLaat.length > 0
    ? [{ maand: null, taken: teLaat.sort(opDeadline) }, ...blokken]
    : blokken
}
