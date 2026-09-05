import { describe, expect, it } from 'vitest'
import { niveauMagOverzicht, magOverzichtZien } from './overzicht'
import { niveauMagGoedkeuren } from './niveaus'
import type { Employee, MedewerkerNiveau } from '../types'

function medewerker(over: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    firm_id: 'f1',
    auth_user_id: 'auth-1',
    naam: 'Test',
    email: 'test@firm.be',
    rol: 'medewerker',
    niveau: null,
    mag_goedkeuren: false,
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('niveauMagOverzicht', () => {
  it('laat de supervisor binnen', () => {
    // Dit is de hele reden dat deze functie bestaat: het oude scherm stond op
    // `kantoorbeheerder`, en juist de graden die het meeste werk doen konden
    // er niet in.
    expect(niveauMagOverzicht('supervisor')).toBe(true)
    expect(niveauMagOverzicht('manager')).toBe(true)
    expect(niveauMagOverzicht('partner')).toBe(true)
  })

  it('houdt junior en senior erbuiten', () => {
    expect(niveauMagOverzicht('junior')).toBe(false)
    expect(niveauMagOverzicht('senior')).toBe(false)
    expect(niveauMagOverzicht(null)).toBe(false)
  })

  it('ligt lager dan de grens voor goedkeuren', () => {
    // Meekijken en tekenen zijn niet hetzelfde recht. Zouden de twee grenzen
    // samenvallen, dan was één van de twee functies overbodig -- en dan zou
    // iemand ze later stilzwijgend samenvoegen.
    const supervisor: MedewerkerNiveau = 'supervisor'
    expect(niveauMagOverzicht(supervisor)).toBe(true)
    expect(niveauMagGoedkeuren(supervisor)).toBe(false)
  })
})

describe('magOverzichtZien', () => {
  it('laat een kantoorbeheerder zonder graad toch binnen', () => {
    expect(magOverzichtZien(medewerker({ rol: 'kantoorbeheerder', niveau: null }))).toBe(true)
  })

  it('houdt een junior buiten, ook al is hij medewerker', () => {
    expect(magOverzichtZien(medewerker({ niveau: 'junior' }))).toBe(false)
  })

  it('laat een supervisor zonder beheerdersrol binnen', () => {
    expect(magOverzichtZien(medewerker({ rol: 'medewerker', niveau: 'supervisor' }))).toBe(true)
  })

  it('zegt nee zonder medewerker', () => {
    expect(magOverzichtZien(null)).toBe(false)
  })
})
