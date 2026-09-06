import { describe, expect, it } from 'vitest'
import { begintOpEigenWeek, eindeVanDeWeek, startfiltersVoor, WEEK_DAGEN } from './startvenster'
import type { Employee } from '../types'

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

describe('begintOpEigenWeek', () => {
  it('geldt voor junior en senior', () => {
    expect(begintOpEigenWeek('junior')).toBe(true)
    expect(begintOpEigenWeek('senior')).toBe(true)
  })

  it('geldt niet voor wie aanstuurt', () => {
    // Een supervisor kijkt naar de ploeg, niet naar zijn eigen lijstje.
    expect(begintOpEigenWeek('supervisor')).toBe(false)
    expect(begintOpEigenWeek('manager')).toBe(false)
    expect(begintOpEigenWeek('partner')).toBe(false)
    expect(begintOpEigenWeek(null)).toBe(false)
  })
})

describe('eindeVanDeWeek', () => {
  it('is vandaag plus zes dagen, zoals in de maandagmail', () => {
    // 0043 rekent het blok "deze week" als due_date <= vandaag + 6. Loopt dit
    // uit elkaar, dan zegt de mail iets anders dan het scherm.
    expect(WEEK_DAGEN).toBe(6)
    expect(eindeVanDeWeek('2026-09-07')).toBe('2026-09-13')
  })

  it('rekent over een maandgrens heen', () => {
    expect(eindeVanDeWeek('2026-09-28')).toBe('2026-10-04')
  })

  it('rekent over een jaargrens heen', () => {
    expect(eindeVanDeWeek('2026-12-30')).toBe('2027-01-05')
  })
})

describe('startfiltersVoor', () => {
  it('zet een junior op zijn eigen werk van deze week', () => {
    expect(startfiltersVoor(medewerker({ id: 'jan', niveau: 'junior' }), '2026-09-07')).toEqual({
      toegewezenAan: 'jan',
      dueTot: '2026-09-13',
    })
  })

  it('laat een manager kantoorbreed en zonder bovengrens binnenkomen', () => {
    expect(startfiltersVoor(medewerker({ niveau: 'manager' }), '2026-09-07')).toEqual({
      toegewezenAan: 'alle',
      dueTot: undefined,
    })
  })

  it('verandert niets zolang de medewerker nog niet geladen is', () => {
    // Anders toont het scherm eerst iets anders dan waar het op uitkomt.
    expect(startfiltersVoor(null, '2026-09-07')).toEqual({
      toegewezenAan: 'alle',
      dueTot: undefined,
    })
  })
})
