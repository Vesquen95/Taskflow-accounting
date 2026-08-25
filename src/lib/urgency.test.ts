import { describe, expect, it } from 'vitest'
import { getUrgencyBand, urgencySortWeight } from './urgency'

const today = new Date('2026-06-15T12:00:00')

function iso(daysFromToday: number): string {
  const d = new Date(today)
  d.setDate(d.getDate() + daysFromToday)
  return d.toISOString().slice(0, 10)
}

describe('getUrgencyBand', () => {
  it('marks a past due date as te_laat regardless of category', () => {
    expect(getUrgencyBand(iso(-1), 'open', 'wettelijk', today)).toBe('te_laat')
    expect(getUrgencyBand(iso(-1), 'open', 'service', today)).toBe('te_laat')
  })

  it('marks a due date of today as vandaag', () => {
    expect(getUrgencyBand(iso(0), 'open', 'wettelijk', today)).toBe('vandaag')
  })

  it('applies stricter (earlier) bands to wettelijk than to service obligations', () => {
    // 4 days out: still "deze_week" pressure for a statutory deadline...
    expect(getUrgencyBand(iso(4), 'open', 'wettelijk', today)).toBe('binnenkort')
    // ...but merely "deze_week" (not yet binnenkort) for service work, since
    // service gets a longer runway before the same label kicks in.
    expect(getUrgencyBand(iso(4), 'open', 'service', today)).toBe('deze_week')
  })

  it('treats a task with no obligation_type (ad-hoc) as wettelijk-strict by default', () => {
    expect(getUrgencyBand(iso(2), 'open', null, today)).toBe('deze_week')
  })

  it('returns null for final statuses regardless of how overdue the date is', () => {
    expect(getUrgencyBand(iso(-30), 'ingediend_afgerond', 'wettelijk', today)).toBeNull()
    expect(getUrgencyBand(iso(-30), 'geannuleerd', 'wettelijk', today)).toBeNull()
  })

  it('returns later for dates well beyond the near-term bands', () => {
    expect(getUrgencyBand(iso(30), 'open', 'wettelijk', today)).toBe('later')
    expect(getUrgencyBand(iso(20), 'open', 'service', today)).toBe('later')
  })
})

describe('urgencySortWeight', () => {
  it('orders te_laat before vandaag before later bands, with null (done) last', () => {
    const weights = [null, 'later', 'binnenkort', 'deze_week', 'vandaag', 'te_laat'] as const
    const sorted = [...weights].sort((a, b) => urgencySortWeight(a) - urgencySortWeight(b))
    expect(sorted).toEqual(['te_laat', 'vandaag', 'deze_week', 'binnenkort', 'later', null])
  })
})
