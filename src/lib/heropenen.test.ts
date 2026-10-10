import { describe, expect, it } from 'vitest'
import { magHeropenen } from './heropenen'

const mw = { id: 'e-mw', rol: 'medewerker' as const, mag_goedkeuren: false }
const partner = { id: 'e-p', rol: 'medewerker' as const, mag_goedkeuren: true }
const beheerder = { id: 'e-b', rol: 'kantoorbeheerder' as const, mag_goedkeuren: false }

describe('magHeropenen', () => {
  const goedgekeurd = { status: 'ingediend_afgerond' as const, vereist_goedkeuring: true, toegewezen_medewerker_id: 'e-mw' }
  const eigen = { ...goedgekeurd, vereist_goedkeuring: false }

  it('laat wie mag goedkeuren en de kantoorbeheerder altijd heropenen', () => {
    expect(magHeropenen(goedgekeurd, partner)).toBe(true)
    expect(magHeropenen(goedgekeurd, beheerder)).toBe(true)
  })

  it('laat de indiener geen goedgekeurde aangifte heropenen', () => {
    expect(magHeropenen(goedgekeurd, mw)).toBe(false)
  })

  it('laat de verantwoordelijke zijn eigen taak zonder goedkeuring heropenen, een collega niet', () => {
    expect(magHeropenen(eigen, mw)).toBe(true)
    expect(magHeropenen(eigen, { ...mw, id: 'e-ander' })).toBe(false)
  })

  it('heropent alleen wat afgerond is', () => {
    expect(magHeropenen({ ...eigen, status: 'in_uitvoering' }, partner)).toBe(false)
    expect(magHeropenen({ ...eigen, status: 'geannuleerd' }, partner)).toBe(false)
  })
})
