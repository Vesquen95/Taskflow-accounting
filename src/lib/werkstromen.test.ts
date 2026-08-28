import { describe, expect, it } from 'vitest'
import {
  INGANGEN,
  VENSTERS,
  groepeerInBlokken,
  ingangVoorPad,
  typesInWerkstroom,
  vensterTot,
} from './werkstromen'
import type { ObligationType, TaskInstanceWithRelations } from '../types'

const types: ObligationType[] = [
  { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: null, werkstroom: 'btw' },
  { id: 'ot-lst', code: 'btw_klantenlisting', naam: 'BTW-klantenlisting', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: null, werkstroom: 'btw' },
  { id: 'ot-jaf', code: 'jaarafsluiting', naam: 'Jaarafsluiting', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: null, werkstroom: 'afsluiting' },
  { id: 'ot-va', code: 'va_venb', naam: 'Voorafbetaling', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: null, werkstroom: 'vennootschapsbelasting' },
]

function taak(id: string, due_date: string): TaskInstanceWithRelations {
  return { id, due_date } as unknown as TaskInstanceWithRelations
}

describe('INGANGEN', () => {
  it('heeft de vier werkstromen plus ad-hoc, elk met een uniek pad', () => {
    expect(INGANGEN).toHaveLength(5)
    expect(INGANGEN.map((i) => i.key)).toEqual([
      'btw',
      'afsluiting',
      'vennootschapsbelasting',
      'rapportering',
      'adhoc',
    ])
    const paden = INGANGEN.map((i) => i.pad)
    expect(new Set(paden).size).toBe(paden.length)
  })

  it('vindt een ingang op haar pad en geeft niets terug voor een onbekend pad', () => {
    expect(ingangVoorPad('btw')?.label).toBe('Btw')
    expect(ingangVoorPad('bestaat-niet')).toBeUndefined()
  })
})

describe('typesInWerkstroom', () => {
  it('geeft de types van één stroom terug', () => {
    expect(typesInWerkstroom(types, 'btw').map((t) => t.code)).toEqual([
      'btw_aangifte',
      'btw_klantenlisting',
    ])
    expect(typesInWerkstroom(types, 'vennootschapsbelasting').map((t) => t.code)).toEqual(['va_venb'])
  })

  it('geeft een lege lijst voor een stroom zonder types', () => {
    expect(typesInWerkstroom(types, 'rapportering')).toEqual([])
  })
})

describe('vensterTot', () => {
  // Woensdag 26 augustus 2026.
  const woensdag = new Date(2026, 7, 26)

  it('laat "deze week" lopen tot en met zondag', () => {
    expect(vensterTot('deze_week', woensdag)).toBe('2026-08-30')
  })

  it('telt op een zondag die zondag zelf mee, niet de week erna', () => {
    expect(vensterTot('deze_week', new Date(2026, 7, 30))).toBe('2026-08-30')
  })

  it('laat "deze maand" tot de laatste dag van de maand lopen', () => {
    expect(vensterTot('deze_maand', woensdag)).toBe('2026-08-31')
    expect(vensterTot('deze_maand', new Date(2026, 1, 3))).toBe('2026-02-28')
  })

  it('laat "volgende maand" tot en met het einde van volgende maand lopen', () => {
    expect(vensterTot('volgende_maand', woensdag)).toBe('2026-09-30')
  })

  it('rolt "volgende maand" in december mee over de jaarwissel', () => {
    // 15 december 2026 → tot en met 31 januari 2027, niet 31 januari 2026.
    expect(vensterTot('volgende_maand', new Date(2026, 11, 15))).toBe('2027-01-31')
    // En de laatste dag van december rekent nog altijd januari erbij.
    expect(vensterTot('volgende_maand', new Date(2026, 11, 31))).toBe('2027-01-31')
  })

  it('houdt rekening met een kortere volgende maand', () => {
    // 31 januari 2028 (schrikkeljaar) → tot en met 29 februari, niet 31 februari.
    expect(vensterTot('volgende_maand', new Date(2028, 0, 31))).toBe('2028-02-29')
    expect(vensterTot('volgende_maand', new Date(2026, 0, 31))).toBe('2026-02-28')
  })

  it('laat "dit kwartaal" tot de laatste dag van het lopende kwartaal lopen', () => {
    expect(vensterTot('dit_kwartaal', new Date(2026, 0, 5))).toBe('2026-03-31')
    expect(vensterTot('dit_kwartaal', new Date(2026, 4, 5))).toBe('2026-06-30')
    expect(vensterTot('dit_kwartaal', woensdag)).toBe('2026-09-30')
    expect(vensterTot('dit_kwartaal', new Date(2026, 10, 5))).toBe('2026-12-31')
  })

  it('rekent op een kwartaaleinde die dag zelf mee en springt niet naar het volgende kwartaal', () => {
    expect(vensterTot('dit_kwartaal', new Date(2026, 2, 31))).toBe('2026-03-31')
    expect(vensterTot('dit_kwartaal', new Date(2026, 5, 30))).toBe('2026-06-30')
    expect(vensterTot('dit_kwartaal', new Date(2026, 8, 30))).toBe('2026-09-30')
    // Het vierde kwartaal loopt tot oudejaar en niet door in het nieuwe jaar.
    expect(vensterTot('dit_kwartaal', new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('heeft geen bovengrens voor "alles"', () => {
    expect(vensterTot('alles', woensdag)).toBeUndefined()
  })

  it('geeft voor elk venster in de keuzelijst een bruikbare bovengrens', () => {
    // De keuzelijst en vensterTot mogen niet uit elkaar lopen: een venster
    // zonder tak in de switch zou stil undefined teruggeven en dus onbedoeld
    // "alles" tonen.
    for (const v of VENSTERS) {
      const tot = vensterTot(v.key, woensdag)
      if (v.key === 'alles') expect(tot).toBeUndefined()
      else expect(tot).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('houdt "alles" als laatste keuze, zodat het geheel te overzien blijft', () => {
    expect(VENSTERS.map((v) => v.key)).toEqual([
      'deze_week',
      'deze_maand',
      'volgende_maand',
      'dit_kwartaal',
      'alles',
    ])
  })
})

describe('groepeerInBlokken', () => {
  const vandaag = new Date(2026, 7, 26) // 2026-08-26

  it('zet taken uit dezelfde maand in één blok, op maand gesorteerd', () => {
    const blokken = groepeerInBlokken(
      [taak('c', '2026-09-20'), taak('a', '2026-08-31'), taak('b', '2026-08-28')],
      vandaag
    )

    expect(blokken.map((b) => b.maand)).toEqual(['2026-08', '2026-09'])
    // Binnen de maand loopt het chronologisch, ook al kwam het door elkaar aan.
    expect(blokken[0].taken.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('houdt dezelfde maand in verschillende jaren uit elkaar', () => {
    // Met het venster "Alles" loopt de lijst tot 2029; september 2026 en
    // september 2027 mogen dan niet in één blok belanden.
    const blokken = groepeerInBlokken(
      [taak('nu', '2026-09-20'), taak('later', '2027-09-20')],
      vandaag
    )

    expect(blokken.map((b) => b.maand)).toEqual(['2026-09', '2027-09'])
  })

  it('verzamelt alles wat te laat is in één blok vooraan, ook over maanden heen', () => {
    const blokken = groepeerInBlokken(
      [taak('laat1', '2026-07-20'), taak('op-tijd', '2026-08-31'), taak('laat2', '2026-08-10')],
      vandaag
    )

    expect(blokken[0].maand).toBeNull()
    expect(blokken[0].taken.map((t) => t.id)).toEqual(['laat1', 'laat2'])
    expect(blokken).toHaveLength(2)
  })

  it('rekent vandaag niet als te laat en zet het bij de lopende maand', () => {
    const blokken = groepeerInBlokken([taak('vandaag', '2026-08-26')], vandaag)

    expect(blokken).toHaveLength(1)
    expect(blokken[0].maand).toBe('2026-08')
  })

  it('splitst de lopende maand tussen achterstand en wat nog komt', () => {
    const blokken = groepeerInBlokken(
      [taak('laat', '2026-08-10'), taak('komt-nog', '2026-08-31')],
      vandaag
    )

    expect(blokken.map((b) => b.maand)).toEqual([null, '2026-08'])
    expect(blokken[1].taken.map((t) => t.id)).toEqual(['komt-nog'])
  })

  it('laat het te-laat-blok weg als er geen achterstand is', () => {
    const blokken = groepeerInBlokken([taak('a', '2026-08-31')], vandaag)

    expect(blokken.every((b) => b.maand !== null)).toBe(true)
  })

  it('houdt bij een kwartaalvenster het aantal blokken beperkt tot de maanden', () => {
    // De aanleiding voor maandblokken: een kwartaal aan dagblokken gaf
    // tientallen blokjes van één regel.
    const taken = Array.from({ length: 30 }, (_, i) =>
      taak(`t${i}`, `2026-09-${String((i % 30) + 1).padStart(2, '0')}`)
    )

    const blokken = groepeerInBlokken(taken, vandaag)

    expect(blokken).toHaveLength(1)
    expect(blokken[0].maand).toBe('2026-09')
    expect(blokken[0].taken).toHaveLength(30)
  })

  it('geeft een lege lijst terug zonder taken', () => {
    expect(groepeerInBlokken([], vandaag)).toEqual([])
  })
})
