import { describe, expect, it } from 'vitest'
import { dekkingStatus, feestdagenDekking, horizonJaar } from './feestdagen'
import type { PublicHoliday } from '../types'

function jaar(jaartal: number, aantal = 10, ingetrokken = false): PublicHoliday[] {
  return Array.from({ length: aantal }, (_, i) => ({
    id: `${jaartal}-${i}`,
    jaar: jaartal,
    datum: `${jaartal}-01-${String(i + 1).padStart(2, '0')}`,
    omschrijving: `Feestdag ${i + 1}`,
    aangemaakt_door: 'e1',
    gewijzigd_door: 'e1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ingetrokken,
  })) as PublicHoliday[]
}

describe('feestdagenDekking', () => {
  it('geeft het laatste volledig ingevoerde jaar', () => {
    expect(feestdagenDekking([...jaar(2026), ...jaar(2027)])).toBe(2027)
  })

  it('telt een half ingevoerd jaar niet mee', () => {
    // Precies het geval dat een valse geruststelling zou geven: één losse
    // feestdag in een ver jaar.
    expect(feestdagenDekking([...jaar(2027), ...jaar(2040, 1)])).toBe(2027)
  })

  it('telt ingetrokken feestdagen niet mee', () => {
    expect(feestdagenDekking([...jaar(2027), ...jaar(2028, 10, true)])).toBe(2027)
  })

  it('geeft nul terug zonder feestdagen', () => {
    expect(feestdagenDekking([])).toBe(0)
  })
})

describe('horizonJaar', () => {
  it('kijkt 36 maanden vooruit', () => {
    expect(horizonJaar(new Date(2026, 7, 27))).toBe(2029)
    // Begin januari valt de horizon nog in hetzelfde kalenderjaar + 3.
    expect(horizonJaar(new Date(2026, 0, 5))).toBe(2029)
    // Eind december schuift hij een jaar op.
    expect(horizonJaar(new Date(2026, 11, 20))).toBe(2029)
  })
})

describe('dekkingStatus', () => {
  const vandaag = new Date(2026, 7, 27)

  it('meldt een tekort wanneer de kalender achterloopt op de horizon', () => {
    // De echte situatie van 27/08/2026: kalender tot 2027, horizon tot 2029.
    const status = dekkingStatus([...jaar(2025), ...jaar(2026), ...jaar(2027)], vandaag)
    expect(status).toEqual({ dekkingTot: 2027, horizonTot: 2029, tekort: 2 })
  })

  it('meldt geen tekort wanneer de kalender ver genoeg loopt', () => {
    const holidays = [2027, 2028, 2029, 2030].flatMap((j) => jaar(j))
    expect(dekkingStatus(holidays, vandaag).tekort).toBe(0)
  })

  it('meldt geen tekort wanneer de kalender verder loopt dan nodig', () => {
    const holidays = [2029, 2030, 2035].flatMap((j) => jaar(j))
    expect(dekkingStatus(holidays, vandaag).tekort).toBe(0)
  })
})
