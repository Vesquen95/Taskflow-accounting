import { describe, expect, it } from 'vitest'
import {
  leesVoorafbetaling,
  vaNaam,
  vaWeegtZwaar,
  VA_UITLEG,
  type VaNummer,
} from './voorafbetaling'

describe('leesVoorafbetaling', () => {
  it('haalt nummer en jaar uit het label', () => {
    expect(leesVoorafbetaling('va_venb', 'VA1-2026')).toEqual({ nummer: 1, jaar: '2026' })
    expect(leesVoorafbetaling('va_venb', 'VA4-2027')).toEqual({ nummer: 4, jaar: '2027' })
  })

  it('laat andere verplichtingen met rust', () => {
    // Een btw-kwartaal heeft ook een label; dat mag hier niet aanslaan.
    expect(leesVoorafbetaling('btw_aangifte', 'VA1-2026')).toBeNull()
    expect(leesVoorafbetaling(null, 'VA1-2026')).toBeNull()
  })

  it('geeft null bij een label dat we niet kennen', () => {
    expect(leesVoorafbetaling('va_venb', null)).toBeNull()
    expect(leesVoorafbetaling('va_venb', '')).toBeNull()
    expect(leesVoorafbetaling('va_venb', '2026')).toBeNull()
    expect(leesVoorafbetaling('va_venb', 'VA5-2026')).toBeNull()
    expect(leesVoorafbetaling('va_venb', 'VA1-26')).toBeNull()
  })
})

describe('het gewicht van een voorafbetaling', () => {
  it('VA1 en VA2 wegen zwaar, VA3 en VA4 niet', () => {
    expect(vaWeegtZwaar(1)).toBe(true)
    expect(vaWeegtZwaar(2)).toBe(true)
    expect(vaWeegtZwaar(3)).toBe(false)
    expect(vaWeegtZwaar(4)).toBe(false)
  })

  it('elke voorafbetaling heeft een eigen uitleg, en geen percentage', () => {
    const nummers: VaNummer[] = [1, 2, 3, 4]
    const zinnen = nummers.map((n) => VA_UITLEG[n])
    expect(new Set(zinnen).size).toBe(4)
    // Percentages veranderen jaarlijks; die horen hier niet te staan.
    for (const zin of zinnen) expect(zin).not.toMatch(/%|procent/)
  })

  it('de naam zegt welke van de vier het is', () => {
    expect(vaNaam(1)).toBe('Voorafbetaling VA1')
    expect(vaNaam(4)).toBe('Voorafbetaling VA4')
  })
})
