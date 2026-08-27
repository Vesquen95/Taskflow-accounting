import { describe, expect, it } from 'vitest'
import {
  INGANGEN,
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
  // Woensdag 27 augustus 2026.
  const woensdag = new Date(2026, 7, 26)

  it('laat "deze week" lopen tot en met zondag', () => {
    expect(vensterTot('deze_week', woensdag)).toBe('2026-08-30')
  })

  it('telt op een zondag die zondag zelf mee, niet de week erna', () => {
    expect(vensterTot('deze_week', new Date(2026, 7, 30))).toBe('2026-08-30')
  })

  it('laat "komende twee weken" een week verder lopen', () => {
    expect(vensterTot('twee_weken', woensdag)).toBe('2026-09-06')
  })

  it('laat "deze maand" tot de laatste dag van de maand lopen', () => {
    expect(vensterTot('deze_maand', woensdag)).toBe('2026-08-31')
    expect(vensterTot('deze_maand', new Date(2026, 1, 3))).toBe('2026-02-28')
  })

  it('heeft geen bovengrens voor "alles"', () => {
    expect(vensterTot('alles', woensdag)).toBeUndefined()
  })
})

describe('groepeerInBlokken', () => {
  const vandaag = new Date(2026, 7, 26) // 2026-08-26

  it('zet taken met dezelfde deadline in één blok, op datum gesorteerd', () => {
    const blokken = groepeerInBlokken(
      [taak('c', '2026-09-20'), taak('a', '2026-08-31'), taak('b', '2026-08-31')],
      vandaag
    )

    expect(blokken.map((b) => b.due_date)).toEqual(['2026-08-31', '2026-09-20'])
    expect(blokken[0].taken.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('verzamelt alles wat te laat is in één blok vooraan', () => {
    const blokken = groepeerInBlokken(
      [taak('laat1', '2026-07-20'), taak('op-tijd', '2026-08-31'), taak('laat2', '2026-08-10')],
      vandaag
    )

    expect(blokken[0].due_date).toBeNull()
    expect(blokken[0].taken.map((t) => t.id)).toEqual(['laat1', 'laat2'])
    expect(blokken).toHaveLength(2)
  })

  it('rekent vandaag niet als te laat', () => {
    const blokken = groepeerInBlokken([taak('vandaag', '2026-08-26')], vandaag)

    expect(blokken).toHaveLength(1)
    expect(blokken[0].due_date).toBe('2026-08-26')
  })

  it('laat het te-laat-blok weg als er geen achterstand is', () => {
    const blokken = groepeerInBlokken([taak('a', '2026-08-31')], vandaag)

    expect(blokken.every((b) => b.due_date !== null)).toBe(true)
  })

  it('geeft een lege lijst terug zonder taken', () => {
    expect(groepeerInBlokken([], vandaag)).toEqual([])
  })
})
