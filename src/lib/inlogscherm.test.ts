import { describe, expect, it } from 'vitest'
import { dagVanHetJaar, isoWeek, volgendeBtwKwartaal } from './inlogscherm'

describe('volgendeBtwKwartaal', () => {
  it('wijst midden oktober naar de termijn over Q3, zonder uitstel op zondag', () => {
    expect(volgendeBtwKwartaal(new Date('2026-10-14T09:00:00'))).toEqual({
      datum: '2026-10-25',
      kwartaal: 'Q3 2026',
      dagen: 11,
    })
  })

  it('telt de termijndag zelf nog mee', () => {
    expect(volgendeBtwKwartaal(new Date('2026-10-25T23:30:00')).dagen).toBe(0)
  })

  it('springt na de 25ste naar het volgende kwartaal, over de jaargrens', () => {
    expect(volgendeBtwKwartaal(new Date('2026-10-26T08:00:00'))).toEqual({
      datum: '2027-01-25',
      kwartaal: 'Q4 2026',
      dagen: 91,
    })
  })

  it('kijkt in een maand zonder termijn vooruit naar de volgende', () => {
    expect(volgendeBtwKwartaal(new Date('2026-02-10T08:00:00')).datum).toBe('2026-04-25')
  })
})

describe('isoWeek', () => {
  it.each([
    ['2026-10-14', 42],
    ['2026-01-01', 1],
    ['2027-01-01', 53],
    ['2026-12-31', 53],
  ])('%s valt in week %i', (datum, week) => {
    expect(isoWeek(new Date(`${datum}T12:00:00`))).toBe(week)
  })
})

describe('dagVanHetJaar', () => {
  it('begint bij 0 op 1 januari', () => {
    expect(dagVanHetJaar(new Date('2026-01-01T15:00:00'))).toBe(0)
    expect(dagVanHetJaar(new Date('2026-10-14T15:00:00'))).toBe(286)
  })
})
