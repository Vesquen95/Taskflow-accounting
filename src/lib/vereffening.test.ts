import { describe, expect, it } from 'vitest'
import { vereffeningStand } from './vereffening'

describe('vereffeningStand', () => {
  it('is "geen" zonder datums', () => {
    expect(vereffeningStand({})).toBe('geen')
    expect(vereffeningStand({ ontbonden_op: null, vereffend_op: null })).toBe('geen')
  })

  it('is "in vereffening" zodra er ontbonden is', () => {
    expect(vereffeningStand({ ontbonden_op: '2026-04-30' })).toBe('in_vereffening')
  })

  it('blijft "in vereffening" hoe lang het ook duurt', () => {
    // Het kantoor: een dossier kan hier járen in blijven staan. Er is geen
    // termijn na dewelke het vanzelf iets anders wordt -- alleen de sluiting
    // maakt er een einde aan.
    expect(vereffeningStand({ ontbonden_op: '2019-01-01' })).toBe('in_vereffening')
  })

  it('is "vereffend" zodra de sluiting er is', () => {
    expect(
      vereffeningStand({ ontbonden_op: '2026-04-30', vereffend_op: '2029-09-30' })
    ).toBe('vereffend')
  })
})
