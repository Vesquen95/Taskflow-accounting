/**
 * De citaten in de begroeting na het inloggen. Gevraagd (24/10/2026): "kan
 * je de teksten laten roteren?", met deze filmcitaten.
 *
 * Niet zomaar willekeurig: sommige passen bij een moment. "Good morning,
 * Vietnam!" alleen 's ochtends, "Fasten your seatbelts" 's avonds, "Houston,
 * we have a problem" als er taken over hun deadline zijn, en "You're gonna
 * need a bigger boat" bij een volle week. Wat past, komt in de pot; wat bij
 * het moment hoort, telt dubbel. Nooit twee keer na elkaar hetzelfde.
 */

export type Moment = 'altijd' | 'ochtend' | 'avond' | 'achterstand' | 'vol'

export interface Citaat {
  id: string
  tekst: string
  bron: string
  wanneer: Moment
}

export const CITATEN: Citaat[] = [
  { id: 'vietnam', tekst: 'Good morning, Vietnam!', bron: 'Good Morning, Vietnam', wanneer: 'ochtend' },
  {
    id: 'tijd',
    tekst: 'All we have to decide is what to do with the time that is given to us.',
    bron: 'The Lord of the Rings',
    wanneer: 'altijd',
  },
  { id: 'carpe', tekst: 'Carpe diem. Seize the day.', bron: 'Dead Poets Society', wanneer: 'altijd' },
  {
    id: 'gordels',
    tekst: 'Fasten your seatbelts. It’s going to be a bumpy night.',
    bron: 'All About Eve',
    wanneer: 'avond',
  },
  { id: 'boot', tekst: 'You’re gonna need a bigger boat.', bron: 'Jaws', wanneer: 'vol' },
  { id: 'houston', tekst: 'Houston, we have a problem.', bron: 'Apollo 13', wanneer: 'achterstand' },
]

/** Vanaf zoveel open taken in de komende zeven dagen is de week "vol". */
export const VOLLE_WEEK = 10

export interface Stand {
  /** Open taken van deze medewerker over hun deadline. */
  achterstand: number
  /** Open taken van deze medewerker met een deadline in de komende zeven dagen. */
  dezeWeek: number
}

function past(c: Citaat, uur: number, stand: Stand | null): boolean {
  switch (c.wanneer) {
    case 'altijd':
      return true
    case 'ochtend':
      return uur >= 5 && uur < 12
    case 'avond':
      return uur >= 18 || uur < 5
    case 'achterstand':
      return (stand?.achterstand ?? 0) > 0
    case 'vol':
      return (stand?.dezeWeek ?? 0) >= VOLLE_WEEK
  }
}

/**
 * Kiest een citaat. `toeval` is een getal in [0, 1), zoals Math.random();
 * meegegeven zodat de keuze te testen is.
 */
export function kiesCitaat(uur: number, stand: Stand | null, vorige: string | null, toeval: number): Citaat {
  const passend = CITATEN.filter((c) => past(c, uur, stand))
  const zonderVorige = passend.filter((c) => c.id !== vorige)
  const kandidaten = zonderVorige.length > 0 ? zonderVorige : passend
  // Wat bij dit moment hoort, telt dubbel.
  const pot = kandidaten.flatMap((c) => (c.wanneer === 'altijd' ? [c] : [c, c]))
  return pot[Math.min(pot.length - 1, Math.floor(toeval * pot.length))]
}

/** Wat het citaat over vandaag zegt, in het Nederlands op het scherm. */
export function toelichting(c: Citaat, stand: Stand | null): string | null {
  if (!stand) return null
  if (c.wanneer === 'achterstand') {
    return stand.achterstand === 1 ? '1 taak staat over haar deadline.' : `${stand.achterstand} taken staan over hun deadline.`
  }
  if (c.wanneer === 'vol') return `${stand.dezeWeek} taken deze week.`
  return null
}

/** En wat de stem erachter zegt. */
export function gesprokenToelichting(c: Citaat, stand: Stand | null): string {
  if (!stand) return ''
  if (c.wanneer === 'achterstand') {
    return stand.achterstand === 1 ? ' One task is overdue.' : ` ${stand.achterstand} tasks are overdue.`
  }
  if (c.wanneer === 'vol') return ` ${stand.dezeWeek} tasks this week.`
  return ''
}

const VORIG_CITAAT = 'taskflow.begroeting.citaat'

export function leesVorigCitaat(): string | null {
  try {
    return window.localStorage.getItem(VORIG_CITAAT)
  } catch {
    return null
  }
}

export function bewaarVorigCitaat(id: string): void {
  try {
    window.localStorage.setItem(VORIG_CITAAT, id)
  } catch {
    // Geen opslag: dan kan hetzelfde citaat twee keer na elkaar komen.
  }
}
