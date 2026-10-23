import { describe, expect, it } from 'vitest'
import { CITATEN, gesprokenToelichting, kiesCitaat, toelichting, VOLLE_WEEK } from './citaten'

const rustig = { achterstand: 0, dezeWeek: 3 }

/** Alle citaten die bij dit moment kunnen vallen. */
function mogelijk(uur: number, stand: Parameters<typeof kiesCitaat>[1], vorige: string | null = null) {
  const ids = new Set<string>()
  for (let i = 0; i < 100; i++) ids.add(kiesCitaat(uur, stand, vorige, i / 100).id)
  return [...ids].sort()
}

describe('citaten', () => {
  it('kiest "Good morning, Vietnam" alleen in de ochtend', () => {
    expect(mogelijk(9, rustig)).toEqual(['carpe', 'tijd', 'vietnam'])
    expect(mogelijk(14, rustig)).toEqual(['carpe', 'tijd'])
  })

  it('kiest de veiligheidsgordels alleen bij een avondlogin', () => {
    expect(mogelijk(20, rustig)).toEqual(['carpe', 'gordels', 'tijd'])
    expect(mogelijk(2, rustig)).toContain('gordels')
  })

  it('roept Houston erbij als er taken te laat zijn, en de grotere boot bij een volle week', () => {
    expect(mogelijk(14, { achterstand: 2, dezeWeek: 3 })).toContain('houston')
    expect(mogelijk(14, { achterstand: 0, dezeWeek: VOLLE_WEEK - 1 })).not.toContain('boot')
    expect(mogelijk(14, { achterstand: 0, dezeWeek: VOLLE_WEEK })).toContain('boot')
    // Zonder telling: niets wat erop steunt.
    expect(mogelijk(14, null)).toEqual(['carpe', 'tijd'])
  })

  it('laat wat bij het moment hoort dubbel tellen', () => {
    // Middag, met achterstand: carpe, tijd, en houston dubbel.
    const keer = { carpe: 0, tijd: 0, houston: 0 } as Record<string, number>
    for (let i = 0; i < 400; i++) keer[kiesCitaat(14, { achterstand: 1, dezeWeek: 0 }, null, i / 400).id]++
    expect(keer.houston).toBe(200)
    expect(keer.carpe).toBe(100)
  })

  it('geeft nooit twee keer na elkaar hetzelfde', () => {
    expect(mogelijk(14, rustig, 'carpe')).toEqual(['tijd'])
    // Is er maar één die past, dan toch die ene.
    expect(kiesCitaat(14, rustig, 'tijd', 0.99).id).not.toBe('tijd')
  })

  it('zegt erbij hoeveel taken het betreft', () => {
    const houston = CITATEN.find((c) => c.id === 'houston')!
    const boot = CITATEN.find((c) => c.id === 'boot')!
    expect(toelichting(houston, { achterstand: 1, dezeWeek: 0 })).toBe('1 taak staat over haar deadline.')
    expect(toelichting(houston, { achterstand: 3, dezeWeek: 0 })).toBe('3 taken staan over hun deadline.')
    expect(toelichting(boot, { achterstand: 0, dezeWeek: 14 })).toBe('14 taken deze week.')
    expect(gesprokenToelichting(houston, { achterstand: 3, dezeWeek: 0 })).toBe(' 3 tasks are overdue.')
    expect(toelichting(CITATEN[1], rustig)).toBeNull()
  })
})
