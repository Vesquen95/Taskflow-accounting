import { describe, expect, it } from 'vitest'
import { NIVEAUS, niveauLabel, niveauMagGoedkeuren } from './niveaus'

describe('niveaus — het goedkeuringsrecht volgt de graad', () => {
  it('kent de zes graden in rangorde', () => {
    expect(NIVEAUS.map((n) => n.waarde)).toEqual([
      'junior',
      'senior',
      'supervisor',
      'manager',
      'director',
      'partner',
    ])
  })

  it('laat niemand onder manager goedkeuren', () => {
    expect(niveauMagGoedkeuren('junior')).toBe(false)
    expect(niveauMagGoedkeuren('senior')).toBe(false)
    expect(niveauMagGoedkeuren('supervisor')).toBe(false)
  })

  it('laat manager en hoger wel goedkeuren', () => {
    expect(niveauMagGoedkeuren('manager')).toBe(true)
    expect(niveauMagGoedkeuren('director')).toBe(true)
    expect(niveauMagGoedkeuren('partner')).toBe(true)
  })

  it('zegt nee zolang er geen graad ingevuld is', () => {
    // Niet "ja bij twijfel": goedkeuren is een bevoegdheid, en die verzin je
    // niet uit een leeg veld. Het scherm valt dan terug op het oude vinkje.
    expect(niveauMagGoedkeuren(null)).toBe(false)
  })

  it('toont een streepje in plaats van een lege cel bij een ontbrekende graad', () => {
    expect(niveauLabel(null)).toBe('—')
    expect(niveauLabel('manager')).toBe('Manager')
  })
})
